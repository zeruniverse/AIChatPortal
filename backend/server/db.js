import { DatabaseSync } from 'node:sqlite';

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}
function columns(db, name) {
  if (!tableExists(db, name)) return [];
  return db.prepare(`PRAGMA table_info(${name})`).all();
}
function pick(row, names, fallback = null) {
  for (const name of names) if (row && row[name] !== undefined && row[name] !== null) return row[name];
  return fallback;
}
function millis(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
function boolInt(value) { return value ? 1 : 0; }

function createCanonicalTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      title TEXT NOT NULL,
      share_enabled INTEGER NOT NULL DEFAULT 0,
      share_token TEXT UNIQUE,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_conversations_owner_updated ON conversations(owner_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_conversations_created ON conversations(created_at);

    CREATE TABLE IF NOT EXISTS turns (
      conversation_id TEXT NOT NULL,
      turn_no INTEGER NOT NULL,
      model_id TEXT NOT NULL,
      status TEXT NOT NULL,
      has_attachments INTEGER NOT NULL DEFAULT 0,
      attachment_ready INTEGER NOT NULL DEFAULT 0,
      attachment_size INTEGER NOT NULL DEFAULT 0,
      upload_id TEXT,
      attempt INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (conversation_id, turn_no),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_turns_status ON turns(status, created_at);

    CREATE TABLE IF NOT EXISTS uploads (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      status TEXT NOT NULL,
      conversation_id TEXT,
      turn_no INTEGER,
      total_raw_size INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_uploads_owner ON uploads(owner_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_uploads_created ON uploads(created_at);

    CREATE TABLE IF NOT EXISTS upload_files (
      id TEXT PRIMARY KEY,
      upload_id TEXT NOT NULL,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      size INTEGER NOT NULL,
      received_size INTEGER NOT NULL DEFAULT 0,
      mime TEXT,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (upload_id) REFERENCES uploads(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_upload_files_upload ON upload_files(upload_id, created_at);
  `);
}

function migrateToV6(db, { defaultOwnerId, defaultModelId, validModelIds }) {
  const oldConversations = tableExists(db, 'conversations') ? db.prepare('SELECT * FROM conversations').all() : [];
  const oldTurns = tableExists(db, 'turns') ? db.prepare('SELECT * FROM turns').all() : [];
  const stamp = Date.now();
  db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;');
  try {
    db.exec(`
      DROP TABLE IF EXISTS _v6_legacy_text;
      CREATE TABLE _v6_legacy_text(conversation_id TEXT NOT NULL, turn_no INTEGER NOT NULL, question TEXT, answer TEXT, PRIMARY KEY(conversation_id,turn_no));
      DROP TABLE IF EXISTS upload_files;
      DROP TABLE IF EXISTS uploads;
      DROP TABLE IF EXISTS turns;
      DROP TABLE IF EXISTS conversations;
    `);
    createCanonicalTables(db);
    const insertConversation = db.prepare('INSERT OR IGNORE INTO conversations(id,owner_id,title,share_enabled,share_token,created_at,updated_at) VALUES(?,?,?,?,?,?,?)');
    const insertTurn = db.prepare('INSERT OR IGNORE INTO turns(conversation_id,turn_no,model_id,status,has_attachments,attachment_ready,attachment_size,upload_id,attempt,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
    const insertLegacyText = db.prepare('INSERT OR REPLACE INTO _v6_legacy_text(conversation_id,turn_no,question,answer) VALUES(?,?,?,?)');
    const conversationRows = new Map();
    for (const row of oldConversations) {
      const id = String(pick(row, ['id','conversation_id','uuid'], '') || '');
      if (!id) continue;
      const created = millis(pick(row, ['created_at','createdAt','created']), stamp);
      const updated = millis(pick(row, ['updated_at','updatedAt','updated']), created);
      const owner = String(pick(row, ['owner_id','ownerId','user_id'], defaultOwnerId));
      const title = String(pick(row, ['title','question','prompt'], '旧对话')).slice(0, 120) || '旧对话';
      const shareEnabled = boolInt(pick(row, ['share_enabled','shareEnabled','is_shared'], 0));
      const shareToken = shareEnabled ? pick(row, ['share_token','shareToken'], null) : null;
      insertConversation.run(id, owner, title, shareEnabled, shareToken, created, updated);
      conversationRows.set(id, { row, created, updated });
    }
    const groupedCounters = new Map();
    for (const row of oldTurns) {
      const conversationId = String(pick(row, ['conversation_id','conversationId','chat_id'], '') || '');
      if (!conversationId) continue;
      if (!conversationRows.has(conversationId)) {
        insertConversation.run(conversationId, defaultOwnerId, '旧对话', 0, null, stamp, stamp);
        conversationRows.set(conversationId, { row: {}, created: stamp, updated: stamp });
      }
      const next = (groupedCounters.get(conversationId) || 0) + 1;
      const turnNo = Number(pick(row, ['turn_no','turnNo','round','sequence'], next)) || next;
      groupedCounters.set(conversationId, Math.max(next, turnNo));
      let model = String(pick(row, ['model_id','modelId','model'], defaultModelId));
      if (!validModelIds.has(model)) model = defaultModelId;
      let status = String(pick(row, ['status'], 'completed'));
      if (['queued','running','uploading'].includes(status)) status = 'pending';
      if (!['pending','compressing','generating','completed','error'].includes(status)) status = 'completed';
      const created = millis(pick(row, ['created_at','createdAt','created']), conversationRows.get(conversationId).created);
      const updated = millis(pick(row, ['updated_at','updatedAt','updated']), created);
      const hasAttachments = boolInt(pick(row, ['has_attachments','hasAttachments','attachment_count'], 0));
      const ready = boolInt(pick(row, ['attachment_ready','attachmentReady'], hasAttachments));
      const size = Number(pick(row, ['attachment_size','attachmentSize','compressed_size'], 0)) || 0;
      const attempt = Number(pick(row, ['attempt'], 1)) || 1;
      insertTurn.run(conversationId, turnNo, model, status, hasAttachments, ready, size, null, attempt, created, updated);
      insertLegacyText.run(conversationId, turnNo, String(pick(row, ['question','prompt','user_text','userText'], '') || ''), String(pick(row, ['answer','response','assistant_text','assistantText'], '') || ''));
    }
    for (const [id, meta] of conversationRows) {
      if (db.prepare('SELECT 1 FROM turns WHERE conversation_id=? LIMIT 1').get(id)) continue;
      let model = String(pick(meta.row, ['model_id','modelId','model'], defaultModelId));
      if (!validModelIds.has(model)) model = defaultModelId;
      let status = String(pick(meta.row, ['status'], 'completed'));
      if (['queued','running','uploading'].includes(status)) status = 'pending';
      if (!['pending','compressing','generating','completed','error'].includes(status)) status = 'completed';
      const hasAttachments = boolInt(pick(meta.row, ['has_attachments','hasAttachments','attachment_count'], 0));
      insertTurn.run(id, 1, model, status, hasAttachments, hasAttachments, Number(pick(meta.row, ['attachment_size'], 0)) || 0, null, 1, meta.created, meta.updated);
      insertLegacyText.run(id, 1, String(pick(meta.row, ['question','prompt'], '') || ''), String(pick(meta.row, ['answer','response'], '') || ''));
    }
    db.exec('PRAGMA user_version=6; COMMIT; PRAGMA foreign_keys=ON;');
  } catch (error) {
    try { db.exec('ROLLBACK; PRAGMA foreign_keys=ON;'); } catch {}
    throw error;
  }
}

export function createDb(dbPath, options) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  const expectedConversationColumns = new Set(['id','owner_id','title','share_enabled','share_token','created_at','updated_at']);
  const expectedTurnColumns = new Set(['conversation_id','turn_no','model_id','status','has_attachments','attachment_ready','attachment_size','upload_id','attempt','created_at','updated_at']);
  const convColumns = new Set(columns(db, 'conversations').map((c) => c.name));
  const turnColumns = new Set(columns(db, 'turns').map((c) => c.name));
  const schemaCurrent = [...expectedConversationColumns].every((c) => convColumns.has(c)) && [...expectedTurnColumns].every((c) => turnColumns.has(c));
  if (version < 6 || !schemaCurrent) migrateToV6(db, options);
  else createCanonicalTables(db);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`UPDATE turns SET status='pending', updated_at=${Date.now()} WHERE status IN ('compressing','generating')`);
  db.exec(`UPDATE upload_files SET status='failed', updated_at=${Date.now()} WHERE status='uploading'`);

  const activeStatuses = "('pending','compressing','generating')";
  const api = {
    raw: db,
    transaction(fn) {
      db.exec('BEGIN IMMEDIATE');
      try { const result = fn(); db.exec('COMMIT'); return result; }
      catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
    },
    activeCount() { return db.prepare(`SELECT COUNT(*) AS count FROM turns WHERE status IN ${activeStatuses}`).get().count; },
    listPending(limit = 20) { return db.prepare(`SELECT * FROM turns WHERE status='pending' ORDER BY created_at LIMIT ?`).all(limit); },
    getConversation(id) { return db.prepare('SELECT * FROM conversations WHERE id=?').get(id); },
    getOwnedConversation(id, ownerId) { return db.prepare('SELECT * FROM conversations WHERE id=? AND owner_id=?').get(id, ownerId); },
    getSharedConversation(token) { return db.prepare('SELECT * FROM conversations WHERE share_enabled=1 AND share_token=?').get(token); },
    listConversations(ownerId) { return db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM turns t WHERE t.conversation_id=c.id) AS turn_count, (SELECT status FROM turns t WHERE t.conversation_id=c.id ORDER BY turn_no DESC LIMIT 1) AS latest_status FROM conversations c WHERE owner_id=? ORDER BY updated_at DESC`).all(ownerId); },
    listTurns(conversationId) { return db.prepare('SELECT * FROM turns WHERE conversation_id=? ORDER BY turn_no').all(conversationId); },
    getTurn(conversationId, turnNo) { return db.prepare('SELECT * FROM turns WHERE conversation_id=? AND turn_no=?').get(conversationId, turnNo); },
    getLastTurn(conversationId) { return db.prepare('SELECT * FROM turns WHERE conversation_id=? ORDER BY turn_no DESC LIMIT 1').get(conversationId); },
    updateTurnStatus(conversationId, turnNo, status, now, extra = {}) {
      const fields = ['status=?', 'updated_at=?']; const values = [status, now];
      for (const [key, value] of Object.entries(extra)) { fields.push(`${key}=?`); values.push(value); }
      values.push(conversationId, turnNo);
      db.prepare(`UPDATE turns SET ${fields.join(', ')} WHERE conversation_id=? AND turn_no=?`).run(...values);
      db.prepare('UPDATE conversations SET updated_at=? WHERE id=?').run(now, conversationId);
    },
    createUpload(id, ownerId, now) { db.prepare('INSERT INTO uploads(id,owner_id,status,created_at,updated_at) VALUES(?,?,?,?,?)').run(id, ownerId, 'open', now, now); },
    getUpload(id) { return db.prepare('SELECT * FROM uploads WHERE id=?').get(id); },
    getOwnedUpload(id, ownerId) { return db.prepare('SELECT * FROM uploads WHERE id=? AND owner_id=?').get(id, ownerId); },
    listUploadFiles(uploadId) { return db.prepare('SELECT * FROM upload_files WHERE upload_id=? ORDER BY created_at,id').all(uploadId); },
    deleteUpload(id) { db.prepare('DELETE FROM uploads WHERE id=?').run(id); },
    deleteConversation(id) { db.prepare('DELETE FROM conversations WHERE id=?').run(id); },
    close() { db.close(); }
  };
  return api;
}
