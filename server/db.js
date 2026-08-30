import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const VALID_STATUSES = new Set(['queued', 'preparing', 'running', 'completed', 'failed']);
const UNFINISHED = "('queued','preparing','running')";

function tableColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
}

function normalizeStatus(status) {
  return VALID_STATUSES.has(status) ? status : 'failed';
}

function normalizeChat(row) {
  if (!row) return null;
  return {
    id: row.id,
    ownerId: row.owner_id,
    title: row.title,
    promptPreview: row.prompt_preview,
    modelId: row.model_id,
    modelLabel: row.model_label,
    status: normalizeStatus(row.status),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    hasAttachments: Boolean(row.has_attachments),
    attachmentCount: Number(row.attachment_count || 0),
    attachmentBytes: Number(row.attachment_bytes || 0),
    turnCount: Number(row.turn_count || 1),
    error: row.error,
    attemptId: row.attempt_id,
    shared: Boolean(row.share_enabled && row.share_token),
    shareToken: row.share_enabled ? row.share_token : null,
    version: Number(row.version || 1),
    archiveVersion: Number(row.archive_version || 1),
  };
}

function normalizeTurn(row) {
  if (!row) return null;
  return {
    chatId: row.chat_id,
    turnNo: Number(row.turn_no),
    status: normalizeStatus(row.status),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    hasAttachments: Boolean(row.has_attachments),
    attachmentCount: Number(row.attachment_count || 0),
    attachmentBytes: Number(row.attachment_bytes || 0),
    attachmentReady: Boolean(row.attachment_ready),
    error: row.error,
    attemptId: row.attempt_id,
    taskToken: row.task_token,
    pendingDir: row.pending_dir,
    revision: Number(row.revision || 1),
  };
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
      turn_count INTEGER NOT NULL DEFAULT 1,
      error TEXT,
      attempt_id TEXT,
      share_enabled INTEGER NOT NULL DEFAULT 0,
      share_token TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      archive_version INTEGER NOT NULL DEFAULT 1
    );
  `);

  const chatColumns = tableColumns(db, 'chats');
  if (!chatColumns.has('owner_id')) db.exec("ALTER TABLE chats ADD COLUMN owner_id TEXT NOT NULL DEFAULT ''");
  if (!chatColumns.has('share_enabled')) db.exec('ALTER TABLE chats ADD COLUMN share_enabled INTEGER NOT NULL DEFAULT 0');
  if (!chatColumns.has('share_token')) db.exec('ALTER TABLE chats ADD COLUMN share_token TEXT');
  if (!chatColumns.has('turn_count')) db.exec('ALTER TABLE chats ADD COLUMN turn_count INTEGER NOT NULL DEFAULT 1');
  if (!chatColumns.has('archive_version')) db.exec('ALTER TABLE chats ADD COLUMN archive_version INTEGER NOT NULL DEFAULT 1');
  if (legacyOwnerId) db.prepare("UPDATE chats SET owner_id=? WHERE owner_id='' OR owner_id IS NULL").run(legacyOwnerId);

  db.exec(`
    CREATE TABLE IF NOT EXISTS turns (
      chat_id TEXT NOT NULL,
      turn_no INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      has_attachments INTEGER NOT NULL DEFAULT 0,
      attachment_count INTEGER NOT NULL DEFAULT 0,
      attachment_bytes INTEGER NOT NULL DEFAULT 0,
      attachment_ready INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      attempt_id TEXT,
      task_token TEXT NOT NULL,
      pending_dir TEXT,
      revision INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY(chat_id, turn_no),
      FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE
    );
  `);

  db.exec(`
    INSERT INTO turns (
      chat_id, turn_no, status, created_at, updated_at, started_at, completed_at,
      has_attachments, attachment_count, attachment_bytes, attachment_ready,
      error, attempt_id, task_token, pending_dir, revision
    )
    SELECT c.id, 1,
      CASE WHEN c.status IN ('queued','running','completed','failed') THEN c.status ELSE 'failed' END,
      c.created_at, c.updated_at, c.started_at, c.completed_at,
      c.has_attachments, c.attachment_count, c.attachment_bytes, 1,
      c.error, c.attempt_id, 'legacy-' || c.id, NULL, 1
    FROM chats c
    WHERE NOT EXISTS (SELECT 1 FROM turns t WHERE t.chat_id=c.id);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_chats_created_at ON chats(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chats_owner_created ON chats(owner_id, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_chats_share_token
      ON chats(share_token) WHERE share_token IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_turns_status ON turns(status);
    CREATE INDEX IF NOT EXISTS idx_turns_chat ON turns(chat_id, turn_no);
  `);

  const q = {
    countUnfinished: db.prepare(`SELECT COUNT(*) AS count FROM turns WHERE status IN ${UNFINISHED}`),
    insertChat: db.prepare(`
      INSERT INTO chats (
        id, owner_id, title, prompt_preview, model_id, model_label, status,
        created_at, updated_at, has_attachments, attachment_count, attachment_bytes,
        turn_count, share_enabled, share_token, archive_version
      ) VALUES (
        @id, @ownerId, @title, @promptPreview, @modelId, @modelLabel, 'queued',
        @createdAt, @createdAt, @hasAttachments, @attachmentCount, 0,
        1, @shareEnabled, @shareToken, @archiveVersion
      )
    `),
    insertTurn: db.prepare(`
      INSERT INTO turns (
        chat_id, turn_no, status, created_at, updated_at,
        has_attachments, attachment_count, attachment_bytes, attachment_ready,
        task_token, pending_dir
      ) VALUES (
        @chatId, @turnNo, 'queued', @createdAt, @createdAt,
        @hasAttachments, @attachmentCount, @attachmentBytes, @attachmentReady,
        @taskToken, @pendingDir
      )
    `),
    getInternal: db.prepare('SELECT * FROM chats WHERE id=?'),
    getOwned: db.prepare('SELECT * FROM chats WHERE id=? AND owner_id=?'),
    getPublic: db.prepare('SELECT * FROM chats WHERE share_enabled=1 AND share_token=?'),
    getTurn: db.prepare('SELECT * FROM turns WHERE chat_id=? AND turn_no=?'),
    listTurns: db.prepare('SELECT * FROM turns WHERE chat_id=? ORDER BY turn_no ASC'),
    listOwned: db.prepare('SELECT * FROM chats WHERE owner_id=? ORDER BY created_at DESC LIMIT ? OFFSET ?'),
    countOwned: db.prepare('SELECT COUNT(*) AS count FROM chats WHERE owner_id=?'),
    listUnfinished: db.prepare(`
      SELECT chat_id, turn_no, task_token FROM turns
      WHERE status IN ${UNFINISHED}
      ORDER BY created_at ASC
    `),
    listAllIds: db.prepare('SELECT id FROM chats'),
    listOwnedIds: db.prepare('SELECT id FROM chats WHERE owner_id=?'),
    listIdsCreatedBefore: db.prepare('SELECT id FROM chats WHERE created_at < ? ORDER BY created_at ASC LIMIT ?'),
    deleteInternalOne: db.prepare('DELETE FROM chats WHERE id=?'),
    deleteOwnedOne: db.prepare('DELETE FROM chats WHERE id=? AND owner_id=?'),
    deleteOwnedAll: db.prepare('DELETE FROM chats WHERE owner_id=?'),
    setShare: db.prepare(`
      UPDATE chats SET share_enabled=@shareEnabled, share_token=@shareToken,
        updated_at=@now, version=version+1
      WHERE id=@id AND owner_id=@ownerId
    `),
    resetInterrupted: db.prepare(`
      UPDATE turns SET status='queued', started_at=NULL, completed_at=NULL,
        updated_at=@now, error=NULL, attempt_id=NULL, revision=revision+1
      WHERE status IN ('preparing','running')
    `),
    markPreparing: db.prepare(`
      UPDATE turns SET status='preparing', updated_at=@now, started_at=@now,
        completed_at=NULL, error=NULL, attempt_id=NULL, revision=revision+1
      WHERE chat_id=@chatId AND turn_no=@turnNo AND task_token=@taskToken
    `),
    markRunning: db.prepare(`
      UPDATE turns SET status='running', updated_at=@now, started_at=@now,
        completed_at=NULL, error=NULL, attempt_id=@attemptId, revision=revision+1
      WHERE chat_id=@chatId AND turn_no=@turnNo AND task_token=@taskToken
    `),
    markCompleted: db.prepare(`
      UPDATE turns SET status='completed', updated_at=@now, completed_at=@now,
        error=NULL, revision=revision+1
      WHERE chat_id=@chatId AND turn_no=@turnNo AND task_token=@taskToken
    `),
    markFailed: db.prepare(`
      UPDATE turns SET status='failed', updated_at=@now, completed_at=@now,
        error=@error, revision=revision+1
      WHERE chat_id=@chatId AND turn_no=@turnNo AND task_token=@taskToken
    `),
    markAttachmentReady: db.prepare(`
      UPDATE turns SET attachment_ready=1, attachment_bytes=@bytes,
        pending_dir=NULL, updated_at=@now, revision=revision+1
      WHERE chat_id=@chatId AND turn_no=@turnNo AND task_token=@taskToken
    `),
    hasUnfinishedInChat: db.prepare(`SELECT COUNT(*) AS count FROM turns WHERE chat_id=? AND status IN ${UNFINISHED}`),
    maxTurnNo: db.prepare('SELECT COALESCE(MAX(turn_no),0) AS value FROM turns WHERE chat_id=?'),
    deleteTurnsAfter: db.prepare('DELETE FROM turns WHERE chat_id=? AND turn_no>?'),
    deleteTurnByToken: db.prepare('DELETE FROM turns WHERE chat_id=? AND turn_no=? AND task_token=?'),
    updateEditedTurn: db.prepare(`
      UPDATE turns SET status='queued', created_at=@createdAt, updated_at=@createdAt,
        started_at=NULL, completed_at=NULL, error=NULL, attempt_id=NULL,
        task_token=@taskToken, revision=revision+1
      WHERE chat_id=@chatId AND turn_no=@turnNo
    `),
    markArchiveVersion: db.prepare(`
      UPDATE chats SET archive_version=@archiveVersion, updated_at=@now, version=version+1
      WHERE id=@id
    `),
    countUnfinishedExcludingEditRange: db.prepare(`
      SELECT COUNT(*) AS count FROM turns
      WHERE status IN ${UNFINISHED} AND NOT (chat_id=? AND turn_no>=?)
    `),
  };

  function syncChat(chatId, { incrementVersion = true } = {}) {
    const latest = q.getTurn.get(chatId, Number(q.maxTurnNo.get(chatId).value));
    if (!latest) return;
    const totals = db.prepare(`
      SELECT COUNT(*) AS turn_count,
        COALESCE(SUM(has_attachments),0) AS has_attachments,
        COALESCE(SUM(attachment_count),0) AS attachment_count,
        COALESCE(SUM(attachment_bytes),0) AS attachment_bytes
      FROM turns WHERE chat_id=?
    `).get(chatId);
    db.prepare(`
      UPDATE chats SET
        status=@status, updated_at=@updatedAt, started_at=@startedAt,
        completed_at=@completedAt, error=@error, attempt_id=@attemptId,
        has_attachments=@hasAttachments, attachment_count=@attachmentCount,
        attachment_bytes=@attachmentBytes, turn_count=@turnCount,
        version=version+@versionIncrement
      WHERE id=@chatId
    `).run({
      chatId,
      status: latest.status,
      updatedAt: latest.updated_at,
      startedAt: latest.started_at,
      completedAt: latest.completed_at,
      error: latest.error,
      attemptId: latest.attempt_id,
      hasAttachments: Number(totals.has_attachments) > 0 ? 1 : 0,
      attachmentCount: Number(totals.attachment_count),
      attachmentBytes: Number(totals.attachment_bytes),
      turnCount: Number(totals.turn_count),
      versionIncrement: incrementVersion ? 1 : 0,
    });
  }

  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw error;
    }
  }

  function reserveInitial({ chat, turn }, maxUnfinished) {
    return transaction(() => {
      if (Number(q.countUnfinished.get().count) >= maxUnfinished) return false;
      q.insertChat.run({
        id: chat.id,
        ownerId: chat.ownerId,
        title: chat.title,
        promptPreview: chat.promptPreview,
        modelId: chat.modelId,
        modelLabel: chat.modelLabel,
        createdAt: chat.createdAt,
        hasAttachments: chat.hasAttachments,
        attachmentCount: chat.attachmentCount,
        shareEnabled: chat.shareEnabled,
        shareToken: chat.shareToken,
        archiveVersion: chat.archiveVersion || 2,
      });
      q.insertTurn.run({
        chatId: turn.chatId,
        turnNo: turn.turnNo,
        createdAt: turn.createdAt,
        hasAttachments: turn.hasAttachments,
        attachmentCount: turn.attachmentCount,
        attachmentBytes: turn.attachmentBytes,
        attachmentReady: turn.attachmentReady,
        taskToken: turn.taskToken,
        pendingDir: turn.pendingDir,
      });
      return true;
    });
  }

  function reserveFollowUp(chatId, ownerId, turn, maxUnfinished) {
    return transaction(() => {
      const chat = q.getOwned.get(chatId, ownerId);
      if (!chat) return { ok: false, reason: 'not_found' };
      if (Number(q.hasUnfinishedInChat.get(chatId).count) > 0) return { ok: false, reason: 'chat_busy' };
      const latestTurnNo = Number(q.maxTurnNo.get(chatId).value);
      const latestTurn = latestTurnNo > 0 ? q.getTurn.get(chatId, latestTurnNo) : null;
      if (!latestTurn || !Number(latestTurn.attachment_ready)) {
        return { ok: false, reason: 'attachment_not_ready' };
      }
      if (Number(q.countUnfinished.get().count) >= maxUnfinished) return { ok: false, reason: 'limit' };
      const turnNo = latestTurnNo + 1;
      q.insertTurn.run({
        chatId,
        turnNo,
        createdAt: turn.createdAt,
        hasAttachments: turn.hasAttachments,
        attachmentCount: turn.attachmentCount,
        attachmentBytes: turn.attachmentBytes,
        attachmentReady: turn.attachmentReady,
        taskToken: turn.taskToken,
        pendingDir: turn.pendingDir,
      });
      syncChat(chatId);
      return { ok: true, turnNo };
    });
  }

  function editTurn(chatId, ownerId, turnNo, { createdAt, taskToken, title, promptPreview }, maxUnfinished) {
    return transaction(() => {
      const chat = q.getOwned.get(chatId, ownerId);
      if (!chat) return { ok: false, reason: 'not_found' };
      const existing = q.getTurn.get(chatId, turnNo);
      if (!existing) return { ok: false, reason: 'turn_not_found' };
      const otherUnfinished = Number(q.countUnfinishedExcludingEditRange.get(chatId, turnNo).count);
      if (otherUnfinished >= maxUnfinished) return { ok: false, reason: 'limit' };
      q.deleteTurnsAfter.run(chatId, turnNo);
      q.updateEditedTurn.run({ chatId, turnNo, createdAt, taskToken });
      if (turnNo === 1) {
        db.prepare(`UPDATE chats SET title=?, prompt_preview=? WHERE id=?`).run(title, promptPreview, chatId);
      }
      syncChat(chatId);
      return { ok: true, turn: normalizeTurn(q.getTurn.get(chatId, turnNo)) };
    });
  }

  function updateTurn(method, chatId, turnNo, taskToken, extra = {}) {
    const result = method.run({
      chatId,
      turnNo,
      taskToken,
      now: new Date().toISOString(),
      ...extra,
    });
    if (Number(result.changes) > 0) syncChat(chatId);
    return Number(result.changes) > 0;
  }

  function deleteInternalIds(ids) {
    if (!ids.length) return 0;
    return transaction(() => {
      let deleted = 0;
      for (const id of new Set(ids)) deleted += Number(q.deleteInternalOne.run(id).changes);
      return deleted;
    });
  }

  return {
    dbPath,
    close: () => db.close(),
    compact: () => db.exec('VACUUM'),
    resetInterrupted() {
      transaction(() => {
        const affected = q.resetInterrupted.run({ now: new Date().toISOString() });
        for (const row of db.prepare(`SELECT DISTINCT chat_id FROM turns WHERE status='queued'`).all()) syncChat(row.chat_id);
        return affected;
      });
    },
    countUnfinished: () => Number(q.countUnfinished.get().count),
    reserveInitial,
    reserveFollowUp,
    editTurn,
    removeTurn(chatId, turnNo, taskToken) {
      return transaction(() => {
        const changed = Number(q.deleteTurnByToken.run(chatId, turnNo, taskToken).changes);
        if (changed) syncChat(chatId);
        return changed > 0;
      });
    },
    getChatInternal: (id) => normalizeChat(q.getInternal.get(id)),
    getOwnedChat: (id, ownerId) => normalizeChat(q.getOwned.get(id, ownerId)),
    getPublicChat: (shareToken) => normalizeChat(q.getPublic.get(shareToken)),
    getTurn: (chatId, turnNo) => normalizeTurn(q.getTurn.get(chatId, turnNo)),
    getConversationInternal(id) {
      const chat = normalizeChat(q.getInternal.get(id));
      if (!chat) return null;
      return { chat, turns: q.listTurns.all(id).map(normalizeTurn) };
    },
    getOwnedConversation(id, ownerId) {
      const chat = normalizeChat(q.getOwned.get(id, ownerId));
      if (!chat) return null;
      return { chat, turns: q.listTurns.all(id).map(normalizeTurn) };
    },
    getPublicConversation(shareToken) {
      const chat = normalizeChat(q.getPublic.get(shareToken));
      if (!chat) return null;
      return { chat, turns: q.listTurns.all(chat.id).map(normalizeTurn) };
    },
    listChats(ownerId, limit = 100, offset = 0) {
      return {
        items: q.listOwned.all(ownerId, limit, offset).map(normalizeChat),
        total: Number(q.countOwned.get(ownerId).count),
      };
    },
    listUnfinishedTasks() {
      return q.listUnfinished.all().map((row) => ({
        chatId: row.chat_id,
        turnNo: Number(row.turn_no),
        taskToken: row.task_token,
      }));
    },
    listUnfinishedIds() {
      return [...new Set(q.listUnfinished.all().map((row) => row.chat_id))];
    },
    listAllIds: () => q.listAllIds.all().map((row) => row.id),
    listOwnedIds: (ownerId) => q.listOwnedIds.all(ownerId).map((row) => row.id),
    listIdsCreatedBefore: (cutoffIso, limit = 500) => q.listIdsCreatedBefore.all(cutoffIso, limit).map((row) => row.id),
    deleteInternalIds,
    deleteOwnedChat: (id, ownerId) => Number(q.deleteOwnedOne.run(id, ownerId).changes) > 0,
    deleteOwnedAll: (ownerId) => Number(q.deleteOwnedAll.run(ownerId).changes),
    setShare(id, ownerId, shareToken) {
      return Number(q.setShare.run({
        id,
        ownerId,
        shareEnabled: shareToken ? 1 : 0,
        shareToken: shareToken || null,
        now: new Date().toISOString(),
      }).changes) > 0;
    },
    markPreparing: (chatId, turnNo, taskToken) => updateTurn(q.markPreparing, chatId, turnNo, taskToken),
    markRunning(chatId, turnNo, taskToken, attemptId) {
      if (arguments.length === 2) {
        const legacyTurn = normalizeTurn(q.getTurn.get(chatId, 1));
        return legacyTurn ? updateTurn(q.markRunning, chatId, 1, legacyTurn.taskToken, { attemptId: turnNo }) : false;
      }
      return updateTurn(q.markRunning, chatId, turnNo, taskToken, { attemptId });
    },
    markCompleted: (chatId, turnNo, taskToken) => updateTurn(q.markCompleted, chatId, turnNo, taskToken),
    markFailed: (chatId, turnNo, taskToken, error) => updateTurn(q.markFailed, chatId, turnNo, taskToken, {
      error: String(error || '未知错误').slice(0, 4000),
    }),
    markAttachmentReady: (chatId, turnNo, taskToken, bytes) => updateTurn(q.markAttachmentReady, chatId, turnNo, taskToken, { bytes }),
    markArchiveVersion(id, archiveVersion = 2) {
      return Number(q.markArchiveVersion.run({ id, archiveVersion, now: new Date().toISOString() }).changes) > 0;
    },

    // Backward-compatible helpers retained for upgrades and existing test tooling.
    reserveChat(row, maxUnfinished) {
      const taskToken = `compat-${randomUUID()}`;
      return reserveInitial({
        chat: row,
        turn: {
          chatId: row.id,
          turnNo: 1,
          createdAt: row.createdAt,
          hasAttachments: row.hasAttachments,
          attachmentCount: row.attachmentCount,
          attachmentBytes: row.attachmentBytes || 0,
          attachmentReady: 1,
          taskToken,
          pendingDir: null,
        },
      }, maxUnfinished);
    },
    markRunningLegacy(id, attemptId) {
      const turn = normalizeTurn(q.getTurn.get(id, 1));
      if (turn) return updateTurn(q.markRunning, id, 1, turn.taskToken, { attemptId });
      return false;
    },
  };
}
