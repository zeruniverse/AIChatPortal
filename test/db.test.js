import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createDatabase } from '../server/db.js';

function row(id, ownerId = 'owner-a', shareToken = null) {
  return {
    id,
    ownerId,
    title: id,
    promptPreview: id,
    modelId: 'model-1',
    modelLabel: '模型一',
    createdAt: new Date().toISOString(),
    hasAttachments: 0,
    attachmentCount: 0,
    attachmentBytes: 0,
    shareEnabled: shareToken ? 1 : 0,
    shareToken,
  };
}

test('事务式任务占位不会突破全系统并发上限', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-db-test-'));
  const database = createDatabase(directory);
  try {
    for (let index = 0; index < 10; index += 1) {
      assert.equal(database.reserveChat(row(`id-${index}`, index % 2 ? 'owner-a' : 'owner-b'), 10), true);
    }
    assert.equal(database.reserveChat(row('id-overflow'), 10), false);
    assert.equal(database.countUnfinished(), 10);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('重启恢复只把 running 改回 queued', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-db-restart-'));
  const database = createDatabase(directory);
  try {
    database.reserveChat(row('running-task'), 10);
    database.markRunning('running-task', 'attempt-1');
    database.resetInterrupted();
    assert.equal(database.getChatInternal('running-task').status, 'queued');
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('不同 owner 的历史、详情和删除全部互相隔离', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-db-owner-'));
  const database = createDatabase(directory);
  try {
    database.reserveChat(row('a-1', 'owner-a'), 10);
    database.reserveChat(row('b-1', 'owner-b'), 10);
    assert.deepEqual(database.listChats('owner-a').items.map((item) => item.id), ['a-1']);
    assert.equal(database.getOwnedChat('b-1', 'owner-a'), null);
    assert.equal(database.deleteOwnedAll('owner-a'), 1);
    assert.equal(database.getChatInternal('a-1'), null);
    assert.equal(database.getChatInternal('b-1').ownerId, 'owner-b');
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('分享 token 只在开启时可公开查询，关闭后立即失效', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-db-share-'));
  const database = createDatabase(directory);
  try {
    const shareToken = 'x'.repeat(43);
    database.reserveChat(row('share-1', 'owner-a'), 10);
    assert.equal(database.getPublicChat(shareToken), null);
    assert.equal(database.setShare('share-1', 'owner-a', shareToken), true);
    assert.equal(database.getPublicChat(shareToken).id, 'share-1');
    assert.equal(database.setShare('share-1', 'owner-b', null), false);
    assert.equal(database.getPublicChat(shareToken).id, 'share-1');
    assert.equal(database.setShare('share-1', 'owner-a', null), true);
    assert.equal(database.getPublicChat(shareToken), null);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('旧版 SQLite 自动补充 owner 和分享字段，并把旧记录归给第一个用户', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-db-migrate-'));
  const dbPath = path.join(directory, 'sqlite.db');
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE chats (
      id TEXT PRIMARY KEY,
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
      version INTEGER NOT NULL DEFAULT 1
    );
    INSERT INTO chats (
      id, title, prompt_preview, model_id, model_label, status, created_at, updated_at
    ) VALUES ('legacy-1', 'old', 'old', 'model-1', '模型一', 'completed', '2026-01-01', '2026-01-01');
  `);
  legacy.close();

  const database = createDatabase(directory, { legacyOwnerId: 'first-user' });
  try {
    const migrated = database.getOwnedChat('legacy-1', 'first-user');
    assert.equal(migrated.ownerId, 'first-user');
    assert.equal(migrated.shared, false);
    assert.equal(database.getOwnedChat('legacy-1', 'other-user'), null);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});


test('按创建时间列出并批量删除记录', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-db-cleanup-'));
  const database = createDatabase(directory);
  try {
    const old = row('old', 'owner-a');
    old.createdAt = '2026-08-20T00:00:00.000Z';
    const recent = row('recent', 'owner-a');
    recent.createdAt = '2026-08-29T00:00:00.000Z';
    database.reserveChat(old, 10);
    database.reserveChat(recent, 10);
    assert.deepEqual(database.listIdsCreatedBefore('2026-08-25T00:00:00.000Z'), ['old']);
    assert.equal(database.deleteInternalIds(['old', 'old']), 1);
    assert.equal(database.getChatInternal('old'), null);
    assert.ok(database.getChatInternal('recent'));
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
