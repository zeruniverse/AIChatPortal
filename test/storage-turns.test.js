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
  appendTextEvent,
  attachmentBinPath,
  compressPendingTurnAttachments,
  deleteChatFiles,
  initializeAttachmentBin,
  initializeTextBinAt,
  materializeTurnAttachment,
  pendingTurnDir,
  readConversation,
  rewriteConversationText,
  textBinPath,
  truncateConversationArchive,
} from '../server/storage.js';

const execFileAsync = promisify(execFile);
const LIMIT = 70_000_000;
const CHAT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

async function makeUpload(chatDir, label, contents) {
  const directory = await fsp.mkdtemp(path.join(chatDir, '.upload-test-'));
  const tempPath = path.join(directory, `raw-${label}`);
  await fsp.writeFile(tempPath, contents);
  return {
    directory,
    files: [{ tempPath, originalName: `${label}.txt`, mimeType: 'text/plain' }],
  };
}

async function zipEntries(filePath) {
  const { stdout } = await execFileAsync('unzip', ['-Z1', filePath], { encoding: 'utf8' });
  return stdout.split(/\r?\n/).filter(Boolean);
}

async function zipEntryText(filePath, name) {
  const { stdout } = await execFileAsync('unzip', ['-p', filePath, name], { encoding: 'utf8' });
  return stdout;
}

test('每轮附件独立压缩，外层 ZIP 按 1.zip、2.zip 编号，并可分别下载', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-turn-archives-'));
  try {
    await initializeAttachmentBin(directory, CHAT_ID);

    const first = await makeUpload(directory, 'first', 'first attachment');
    await adoptPendingUpload({
      uploadDirectory: first.directory,
      chatDir: directory,
      chatId: CHAT_ID,
      turnNumber: 1,
      files: first.files,
    });
    const firstResult = await compressPendingTurnAttachments({
      chatDir: directory,
      chatId: CHAT_ID,
      turnNumber: 1,
      archiveVersion: 2,
      maxBytes: LIMIT,
    });
    assert.ok(firstResult.bytes > 0);
    assert.equal(fs.existsSync(pendingTurnDir(directory, CHAT_ID, 1)), false);

    const second = await makeUpload(directory, 'second', 'second attachment');
    await adoptPendingUpload({
      uploadDirectory: second.directory,
      chatDir: directory,
      chatId: CHAT_ID,
      turnNumber: 2,
      files: second.files,
    });
    await compressPendingTurnAttachments({
      chatDir: directory,
      chatId: CHAT_ID,
      turnNumber: 2,
      archiveVersion: 2,
      maxBytes: LIMIT,
    });

    const outer = attachmentBinPath(directory, CHAT_ID);
    assert.deepEqual(await zipEntries(outer), ['1.zip', '2.zip']);

    const turn1 = await materializeTurnAttachment({ chatDir: directory, chatId: CHAT_ID, turnNumber: 1, archiveVersion: 2 });
    const turn2 = await materializeTurnAttachment({ chatDir: directory, chatId: CHAT_ID, turnNumber: 2, archiveVersion: 2 });
    assert.equal(await zipEntryText(turn1, 'first.txt'), 'first attachment');
    assert.equal(await zipEntryText(turn2, 'second.txt'), 'second attachment');
    await fsp.rm(turn1, { force: true });
    await fsp.rm(turn2, { force: true });

    await truncateConversationArchive({
      chatDir: directory,
      chatId: CHAT_ID,
      throughTurn: 1,
      archiveVersion: 2,
      maxBytes: LIMIT,
    });
    assert.deepEqual(await zipEntries(outer), ['1.zip']);
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
});

test('附件压缩失败时保留原始待处理文件，避免编辑重试时静默丢附件', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-turn-failure-'));
  try {
    await initializeAttachmentBin(directory, CHAT_ID);
    const upload = await makeUpload(directory, 'large', 'not actually large but any ZIP is over one byte');
    await adoptPendingUpload({
      uploadDirectory: upload.directory,
      chatDir: directory,
      chatId: CHAT_ID,
      turnNumber: 1,
      files: upload.files,
    });
    await assert.rejects(
      compressPendingTurnAttachments({
        chatDir: directory,
        chatId: CHAT_ID,
        turnNumber: 1,
        archiveVersion: 2,
        maxBytes: 1,
      }),
      /超过 1 字节限制/,
    );
    assert.equal(fs.existsSync(pendingTurnDir(directory, CHAT_ID, 1)), true);
    assert.equal(fs.existsSync(path.join(pendingTurnDir(directory, CHAT_ID, 1), 'manifest.json')), true);
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
});

test('重写文字 bin 会永久移除被编辑轮旧回答和所有后续轮次', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-turn-text-'));
  const createdAt = '2026-08-30T00:00:00.000Z';
  try {
    await initializeTextBinAt(textBinPath(directory, CHAT_ID), CHAT_ID, {
      createdAt,
      modelId: 'model-1',
      modelLabel: '模型一',
      prompt: '第一问',
      turnId: 'turn-1',
      attachments: [{ name: 'first.txt' }],
    });
    await appendTextEvent(directory, CHAT_ID, { type: 'attempt_start', turnNumber: 1, attemptId: 'a1', createdAt });
    await appendTextEvent(directory, CHAT_ID, { type: 'assistant_delta', turnNumber: 1, attemptId: 'a1', sequence: 1, text: '旧第一答', createdAt });
    await appendTextEvent(directory, CHAT_ID, { type: 'turn_user', turnId: 'turn-2', turnNumber: 2, text: '第二问', attachments: [], createdAt });
    await appendTextEvent(directory, CHAT_ID, { type: 'attempt_start', turnNumber: 2, attemptId: 'a2', createdAt });
    await appendTextEvent(directory, CHAT_ID, { type: 'assistant_delta', turnNumber: 2, attemptId: 'a2', sequence: 1, text: '第二答', createdAt });

    const before = await readConversation(directory, CHAT_ID);
    await rewriteConversationText(directory, CHAT_ID, {
      meta: before.meta,
      turns: [{
        ...before.turns[0],
        prompt: '编辑后的第一问',
        answer: '',
        error: null,
        latestAttemptId: null,
      }],
    });
    const after = await readConversation(directory, CHAT_ID);
    assert.equal(after.turns.length, 1);
    assert.equal(after.turns[0].prompt, '编辑后的第一问');
    assert.equal(after.turns[0].answer, '');
    const raw = await fsp.readFile(textBinPath(directory, CHAT_ID), 'utf8');
    assert.doesNotMatch(raw, /旧第一答|第二问|第二答/);
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
});

test('删除对话会清除文字、外层附件、待压缩目录及所有临时轮次文件', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-delete-complete-'));
  try {
    await fsp.writeFile(textBinPath(directory, CHAT_ID), 'text');
    await fsp.writeFile(attachmentBinPath(directory, CHAT_ID), 'archive');
    await fsp.mkdir(pendingTurnDir(directory, CHAT_ID, 3), { recursive: true });
    await fsp.writeFile(path.join(pendingTurnDir(directory, CHAT_ID, 3), 'raw'), 'raw');
    await fsp.writeFile(path.join(directory, `${CHAT_ID}.turn-3.attachments.bin`), 'old');
    for (const root of ['.work', '.downloads', '.transport']) {
      await fsp.mkdir(path.join(directory, root, `${CHAT_ID}-temporary`), { recursive: true });
      await fsp.writeFile(path.join(directory, root, `${CHAT_ID}-temporary`, 'x'), 'x');
    }

    await deleteChatFiles(directory, CHAT_ID);
    assert.equal(fs.existsSync(textBinPath(directory, CHAT_ID)), false);
    assert.equal(fs.existsSync(attachmentBinPath(directory, CHAT_ID)), false);
    assert.equal(fs.existsSync(path.join(directory, '.pending', CHAT_ID)), false);
    assert.equal(fs.existsSync(path.join(directory, `${CHAT_ID}.turn-3.attachments.bin`)), false);
    for (const root of ['.work', '.downloads', '.transport']) {
      assert.equal(fs.existsSync(path.join(directory, root, `${CHAT_ID}-temporary`)), false);
    }
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
});
