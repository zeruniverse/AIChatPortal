import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  adoptPendingUpload,
  attachmentBinPath,
  compressPendingTurnAttachments,
  initializeAttachmentBin,
  materializeTurnAttachment,
  pendingTurnDir,
  truncateConversationArchive,
} from '../server/storage.js';

const execFileAsync = promisify(execFile);

async function zipEntries(filePath) {
  try {
    const { stdout } = await execFileAsync('unzip', ['-Z1', filePath], { encoding: 'utf8' });
    return stdout.split(/\r?\n/).filter(Boolean);
  } catch (error) {
    if (Number(error?.code) === 1 && (!String(error.stdout || '').trim() || /Empty zipfile/i.test(String(error.stdout)))) return [];
    throw error;
  }
}

async function stageTurn(chatDir, chatId, turnNo, files) {
  const uploadDirectory = await fsp.mkdtemp(path.join(chatDir, `.upload-${turnNo}-`));
  const records = [];
  for (const [index, file] of files.entries()) {
    const tempPath = path.join(uploadDirectory, `raw-${index}`);
    await fsp.writeFile(tempPath, file.content);
    records.push({ tempPath, originalName: file.name, mimeType: file.type || 'application/octet-stream' });
  }
  return adoptPendingUpload({ uploadDirectory, chatDir, chatId, turnNumber: turnNo, files: records });
}

test('每轮附件形成内层 ZIP，整个对话始终只有一个永久附件 bin', async () => {
  const chatDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'chat-multiturn-storage-'));
  const chatId = '11111111-1111-4111-8111-111111111111';
  try {
    await initializeAttachmentBin(chatDir, chatId);
    await stageTurn(chatDir, chatId, 1, [{ name: 'first.txt', content: 'first' }]);
    await compressPendingTurnAttachments({
      chatDir, chatId, turnNumber: 1, archiveVersion: 2, maxBytes: 70_000_000,
    });
    await stageTurn(chatDir, chatId, 2, [{ name: 'second.bin', content: Buffer.from([1, 2, 3]) }]);
    await compressPendingTurnAttachments({
      chatDir, chatId, turnNumber: 2, archiveVersion: 2, maxBytes: 70_000_000,
    });
    await stageTurn(chatDir, chatId, 3, []);
    await compressPendingTurnAttachments({
      chatDir, chatId, turnNumber: 3, archiveVersion: 2, maxBytes: 70_000_000,
    });

    const outer = attachmentBinPath(chatDir, chatId);
    assert.deepEqual(await zipEntries(outer), ['1.zip', '2.zip', '3.zip']);
    const rootFiles = (await fsp.readdir(chatDir)).filter((name) => name.endsWith('.attachments.bin'));
    assert.deepEqual(rootFiles, [`${chatId}.attachments.bin`]);

    const turn1 = await materializeTurnAttachment({ chatDir, chatId, turnNumber: 1, archiveVersion: 2 });
    const turn2 = await materializeTurnAttachment({ chatDir, chatId, turnNumber: 2, archiveVersion: 2 });
    const turn3 = await materializeTurnAttachment({ chatDir, chatId, turnNumber: 3, archiveVersion: 2 });
    assert.deepEqual(await zipEntries(turn1), ['first.txt']);
    assert.deepEqual(await zipEntries(turn2), ['second.bin']);
    assert.deepEqual(await zipEntries(turn3), []);
    await Promise.all([turn1, turn2, turn3].map((file) => fsp.rm(file, { force: true })));
  } finally {
    await fsp.rm(chatDir, { recursive: true, force: true });
  }
});

test('编辑截断附件归档时保留目标轮及之前轮次，永久删除之后轮次', async () => {
  const chatDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'chat-multiturn-truncate-'));
  const chatId = '22222222-2222-4222-8222-222222222222';
  try {
    await initializeAttachmentBin(chatDir, chatId);
    for (let turnNo = 1; turnNo <= 3; turnNo += 1) {
      await stageTurn(chatDir, chatId, turnNo, [{ name: `${turnNo}.txt`, content: `turn-${turnNo}` }]);
      await compressPendingTurnAttachments({ chatDir, chatId, turnNumber: turnNo, archiveVersion: 2, maxBytes: 70_000_000 });
    }
    await truncateConversationArchive({
      chatDir, chatId, throughTurn: 2, archiveVersion: 2, maxBytes: 70_000_000,
    });
    assert.deepEqual(await zipEntries(attachmentBinPath(chatDir, chatId)), ['1.zip', '2.zip']);
    const second = await materializeTurnAttachment({ chatDir, chatId, turnNumber: 2, archiveVersion: 2 });
    assert.deepEqual(await zipEntries(second), ['2.txt']);
    assert.equal(await materializeTurnAttachment({ chatDir, chatId, turnNumber: 3, archiveVersion: 2 }), null);
    await fsp.rm(second, { force: true });
  } finally {
    await fsp.rm(chatDir, { recursive: true, force: true });
  }
});

test('压缩被编辑操作取消时保留原始附件，供同一轮重新提交', async () => {
  const chatDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'chat-multiturn-cancel-'));
  const chatId = '33333333-3333-4333-8333-333333333333';
  const controller = new AbortController();
  try {
    await initializeAttachmentBin(chatDir, chatId);
    await stageTurn(chatDir, chatId, 1, [{ name: 'keep.txt', content: 'must survive cancellation' }]);
    controller.abort('edited');
    await assert.rejects(
      compressPendingTurnAttachments({
        chatDir, chatId, turnNumber: 1, archiveVersion: 2,
        maxBytes: 70_000_000, signal: controller.signal,
      }),
      /任务已取消/,
    );
    assert.equal(fs.existsSync(pendingTurnDir(chatDir, chatId, 1)), true);
    assert.equal(fs.existsSync(path.join(pendingTurnDir(chatDir, chatId, 1), 'manifest.json')), true);
  } finally {
    await fsp.rm(chatDir, { recursive: true, force: true });
  }
});
