import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDatabase } from '../server/db.js';
import { StorageCleanup } from '../server/cleanup.js';
import { AsyncMutex } from '../server/mutex.js';

const DAY = 24 * 60 * 60 * 1000;

function row(id, createdAt, ownerId = 'owner-a', shareToken = null) {
  return {
    id,
    ownerId,
    title: id,
    promptPreview: id,
    modelId: 'model-1',
    modelLabel: '模型一',
    createdAt,
    hasAttachments: 1,
    attachmentCount: 1,
    attachmentBytes: 10,
    shareEnabled: shareToken ? 1 : 0,
    shareToken,
  };
}

async function makeBins(directory, id, bytes = 16) {
  await Promise.all([
    fsp.writeFile(path.join(directory, `${id}.text.bin`), 'x'.repeat(bytes)),
    fsp.writeFile(path.join(directory, `${id}.attachments.bin`), 'y'.repeat(bytes)),
  ]);
}

function dependencies(directory, database) {
  const cancelled = [];
  const emitted = [];
  return {
    cancelled,
    emitted,
    cleanup: new StorageCleanup({
      chatDir: directory,
      database,
      workers: {
        async cancelMany(ids) { cancelled.push(...ids); },
      },
      events: {
        emit(id, payload) { emitted.push({ id, payload }); },
      },
      mutex: new AsyncMutex(),
      logger: { log() {}, error() {} },
    }),
  };
}

test('自动清理始终删除创建超过 7 天的问题', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-cleanup-age-'));
  const database = createDatabase(directory);
  const now = Date.parse('2026-08-30T12:00:00.000Z');
  try {
    database.reserveChat(row('old-8d', new Date(now - 8 * DAY).toISOString()), 10);
    database.reserveChat(row('old-2d', new Date(now - 2 * DAY).toISOString()), 10);
    database.reserveChat(row('recent', new Date(now - 2 * 60 * 60 * 1000).toISOString()), 10);
    await Promise.all(['old-8d', 'old-2d', 'recent'].map((id) => makeBins(directory, id)));

    const deps = dependencies(directory, database);
    deps.cleanup.now = () => now;
    deps.cleanup.maxStorageBytes = Number.MAX_SAFE_INTEGER;
    const result = await deps.cleanup.run('test');

    assert.equal(result.expiredDeleted, 1);
    assert.equal(result.pressureDeleted, 0);
    assert.equal(database.getChatInternal('old-8d'), null);
    assert.ok(database.getChatInternal('old-2d'));
    assert.ok(database.getChatInternal('recent'));
    assert.equal(fs.existsSync(path.join(directory, 'old-8d.text.bin')), false);
    assert.deepEqual(deps.cancelled, ['old-8d']);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('启动检查发现 chat 目录超过 3GB 阈值时删除所有 24 小时前的问题', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-cleanup-pressure-'));
  const database = createDatabase(directory);
  const now = Date.parse('2026-08-30T12:00:00.000Z');
  const shareToken = 's'.repeat(43);
  try {
    database.reserveChat(row('old-2d', new Date(now - 2 * DAY).toISOString(), 'owner-a', shareToken), 10);
    database.reserveChat(row('recent', new Date(now - 2 * 60 * 60 * 1000).toISOString()), 10);
    await Promise.all(['old-2d', 'recent'].map((id) => makeBins(directory, id, 64)));

    const deps = dependencies(directory, database);
    deps.cleanup.now = () => now;
    deps.cleanup.maxStorageBytes = 1;
    const result = await deps.cleanup.run('startup');

    assert.equal(result.expiredDeleted, 0);
    assert.equal(result.pressureDeleted, 1);
    assert.equal(database.getChatInternal('old-2d'), null);
    assert.equal(database.getPublicChat(shareToken), null);
    assert.ok(database.getChatInternal('recent'));
    assert.equal(fs.existsSync(path.join(directory, 'old-2d.attachments.bin')), false);
    assert.deepEqual(deps.emitted, [{ id: 'old-2d', payload: { type: 'deleted', reason: 'storage-pressure' } }]);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
