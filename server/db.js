import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const VALID_STATUSES = new Set(['queued', 'running', 'completed', 'failed']);

function tableColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
}

export function createDatabase(chatDir, { legacyOwnerId = '' } = {}) {
  fs.mkdirSync(chatDir, { recursive: true });
  const dbPath = path.join(chatDir, 'sqlite.db');
  const db = new DatabaseSync(dbPath, {
    enableForeignKeyConstraints: true,
    timeout: 5000,
  });
  db.exec(`
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      title TEXT NOT NULL,
      prompt_preview TEXT NOT NULL,
      model_id TEXT NOT NULL,
      model_label TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      has_attachments INTEGER NOT NULL DEFAULT 0,
      attachment_count INTEGER NOT NULL DEFAULT 0,
      attachment_bytes INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      attempt_id TEXT,
      share_enabled INTEGER NOT NULL DEFAULT 0,
      share_token TEXT,
      version INTEGER NOT NULL DEFAULT 1
    );
  `);

  const columns = tableColumns(db, 'chats');
  if (!columns.has('owner_id')) db.exec("ALTER TABLE chats ADD COLUMN owner_id TEXT NOT NULL DEFAULT ''");
  if (!columns.has('share_enabled')) db.exec('ALTER TABLE chats ADD COLUMN share_enabled INTEGER NOT NULL DEFAULT 0');
  if (!columns.has('share_token')) db.exec('ALTER TABLE chats ADD COLUMN share_token TEXT');
  if (legacyOwnerId) {
    db.prepare("UPDATE chats SET owner_id=? WHERE owner_id='' OR owner_id IS NULL").run(legacyOwnerId);
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_chats_created_at ON chats(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chats_status ON chats(status);
    CREATE INDEX IF NOT EXISTS idx_chats_owner_created ON chats(owner_id, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_chats_share_token
      ON chats(share_token) WHERE share_token IS NOT NULL;
  `);

  const statements = {
    countUnfinished: db.prepare("SELECT COUNT(*) AS count FROM chats WHERE status IN ('queued','running')"),
    insert: db.prepare(`
      INSERT INTO chats (
        id, owner_id, title, prompt_preview, model_id, model_label, status,
        created_at, updated_at, has_attachments, attachment_count, attachment_bytes,
        share_enabled, share_token
      ) VALUES (
        @id, @ownerId, @title, @promptPreview, @modelId, @modelLabel, 'queued',
        @createdAt, @createdAt, @hasAttachments, @attachmentCount, @attachmentBytes,
        @shareEnabled, @shareToken
      )
    `),
    getInternal: db.prepare('SELECT * FROM chats WHERE id = ?'),
    getOwned: db.prepare('SELECT * FROM chats WHERE id = ? AND owner_id = ?'),
    getPublic: db.prepare('SELECT * FROM chats WHERE share_enabled=1 AND share_token = ?'),
    listOwned: db.prepare('SELECT * FROM chats WHERE owner_id=? ORDER BY created_at DESC LIMIT ? OFFSET ?'),
    countOwned: db.prepare('SELECT COUNT(*) AS count FROM chats WHERE owner_id=?'),
    listUnfinished: db.prepare("SELECT id FROM chats WHERE status IN ('queued','running') ORDER BY created_at ASC"),
    listAllIds: db.prepare('SELECT id FROM chats'),
    listOwnedIds: db.prepare('SELECT id FROM chats WHERE owner_id=?'),
    listIdsCreatedBefore: db.prepare('SELECT id FROM chats WHERE created_at < ? ORDER BY created_at ASC LIMIT ?'),
    deleteInternalOne: db.prepare('DELETE FROM chats WHERE id = ?'),
    resetRunning: db.prepare("UPDATE chats SET status='queued', started_at=NULL, updated_at=@now, error=NULL WHERE status='running'"),
    markRunning: db.prepare(`
      UPDATE chats
      SET status='running', started_at=@now, updated_at=@now, error=NULL,
          attempt_id=@attemptId, version=version+1
      WHERE id=@id
    `),
    markCompleted: db.prepare(`
      UPDATE chats
      SET status='completed', completed_at=@now, updated_at=@now, error=NULL,
          version=version+1
      WHERE id=@id
    `),
    markFailed: db.prepare(`
      UPDATE chats
      SET status='failed', completed_at=@now, updated_at=@now, error=@error,
          version=version+1
      WHERE id=@id
    `),
    setShare: db.prepare(`
      UPDATE chats
      SET share_enabled=@shareEnabled, share_token=@shareToken, updated_at=@now, version=version+1
      WHERE id=@id AND owner_id=@ownerId
    `),
    deleteOwnedOne: db.prepare('DELETE FROM chats WHERE id = ? AND owner_id = ?'),
    deleteOwnedAll: db.prepare('DELETE FROM chats WHERE owner_id = ?'),
  };

  function reserve(row, maxUnfinished) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const count = Number(statements.countUnfinished.get().count);
      if (count >= maxUnfinished) {
        db.exec('ROLLBACK');
        return false;
      }
      statements.insert.run(row);
      db.exec('COMMIT');
      return true;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* transaction may already be closed */ }
      throw error;
    }
  }

  function deleteInternalIds(ids) {
    if (!ids.length) return 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      let deleted = 0;
      for (const id of ids) deleted += Number(statements.deleteInternalOne.run(id).changes);
      db.exec('COMMIT');
      return deleted;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* transaction may already be closed */ }
      throw error;
    }
  }

  function normalize(row) {
    if (!row) return null;
    return {
      id: row.id,
      ownerId: row.owner_id,
      title: row.title,
      promptPreview: row.prompt_preview,
      modelId: row.model_id,
      modelLabel: row.model_label,
      status: VALID_STATUSES.has(row.status) ? row.status : 'failed',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      hasAttachments: Boolean(row.has_attachments),
      attachmentCount: Number(row.attachment_count),
      attachmentBytes: Number(row.attachment_bytes),
      error: row.error,
      attemptId: row.attempt_id,
      shared: Boolean(row.share_enabled && row.share_token),
      shareToken: row.share_enabled ? row.share_token : null,
      version: Number(row.version),
    };
  }

  return {
    dbPath,
    close: () => db.close(),
    resetInterrupted() {
      statements.resetRunning.run({ now: new Date().toISOString() });
    },
    reserveChat(row, maxUnfinished) {
      return reserve(row, maxUnfinished);
    },
    countUnfinished() {
      return Number(statements.countUnfinished.get().count);
    },
    getChatInternal(id) {
      return normalize(statements.getInternal.get(id));
    },
    getOwnedChat(id, ownerId) {
      return normalize(statements.getOwned.get(id, ownerId));
    },
    getPublicChat(shareToken) {
      return normalize(statements.getPublic.get(shareToken));
    },
    listChats(ownerId, limit = 100, offset = 0) {
      return {
        items: statements.listOwned.all(ownerId, limit, offset).map(normalize),
        total: Number(statements.countOwned.get(ownerId).count),
      };
    },
    listUnfinishedIds() {
      return statements.listUnfinished.all().map((row) => row.id);
    },
    listAllIds() {
      return statements.listAllIds.all().map((row) => row.id);
    },
    listOwnedIds(ownerId) {
      return statements.listOwnedIds.all(ownerId).map((row) => row.id);
    },
    listIdsCreatedBefore(cutoffIso, limit = 500) {
      return statements.listIdsCreatedBefore.all(cutoffIso, limit).map((row) => row.id);
    },
    deleteInternalIds(ids) {
      return deleteInternalIds(Array.from(new Set(ids)));
    },
    compact() {
      db.exec('VACUUM');
    },
    markRunning(id, attemptId) {
      statements.markRunning.run({ id, attemptId, now: new Date().toISOString() });
    },
    markCompleted(id) {
      statements.markCompleted.run({ id, now: new Date().toISOString() });
    },
    markFailed(id, error) {
      statements.markFailed.run({
        id,
        error: String(error || '未知错误').slice(0, 4000),
        now: new Date().toISOString(),
      });
    },
    setShare(id, ownerId, shareToken) {
      const result = statements.setShare.run({
        id,
        ownerId,
        shareEnabled: shareToken ? 1 : 0,
        shareToken: shareToken || null,
        now: new Date().toISOString(),
      });
      return Number(result.changes) > 0;
    },
    deleteOwnedChat(id, ownerId) {
      return Number(statements.deleteOwnedOne.run(id, ownerId).changes) > 0;
    },
    deleteOwnedAll(ownerId) {
      return Number(statements.deleteOwnedAll.run(ownerId).changes);
    },
  };
}
