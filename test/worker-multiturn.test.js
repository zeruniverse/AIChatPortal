import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { createDatabase } from '../server/db.js';
import { ChatEvents } from '../server/events.js';
import { WorkerPool } from '../server/worker.js';
import {
  adoptPendingUpload,
  attachmentBinPath,
  initializeAttachmentBin,
  initializeTextBin,
  appendTextEvent,
} from '../server/storage.js';

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CARRIER_PATH = path.resolve(HERE, '../server/assets/a.jpg');

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function waitFor(check, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('等待异步任务完成超时');
}

async function stageTurn(chatDir, chatId, turnNo, files) {
  const uploadDirectory = await fsp.mkdtemp(path.join(chatDir, `.upload-${turnNo}-`));
  const records = [];
  for (const [index, file] of files.entries()) {
    const tempPath = path.join(uploadDirectory, `raw-${index}`);
    await fsp.writeFile(tempPath, file.content);
    records.push({
      tempPath,
      originalName: file.name,
      mimeType: file.type || 'application/octet-stream',
    });
  }
  const manifest = await adoptPendingUpload({ uploadDirectory, chatDir, chatId, turnNumber: turnNo, files: records });
  return { manifest, pendingDir: path.join(chatDir, '.pending', chatId, String(turnNo)) };
}

async function zipEntries(filePath) {
  try {
    const { stdout } = await execFileAsync('unzip', ['-Z1', filePath], { encoding: 'utf8' });
    return stdout.split(/\r?\n/).filter(Boolean);
  } catch (error) {
    if (Number(error?.code) === 1 && !String(error?.stdout || '').trim()) return [];
    throw error;
  }
}

test('Worker 真正提交追问历史，并把各轮附件作为编号内层 ZIP 隐藏在图片后', async () => {
  const chatDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'chat-worker-follow-up-'));
  const capturedBodies = [];
  let responseNumber = 0;
  const provider = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      capturedBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      responseNumber += 1;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        choices: [{ message: { content: `模型回答${responseNumber}` } }],
      }));
    });
  });

  const port = await listen(provider);
  const database = createDatabase(chatDir, { legacyOwnerId: 'owner-1' });
  const events = new ChatEvents();
  const config = {
    chatDir,
    provider: {
      url: `http://127.0.0.1:${port}/v1/chat/completions`,
      key: 'provider-test-key',
      extraHeaders: {},
      systemPrompt: '',
    },
    models: [{ id: 'model-a', label: '模型 A', request: {} }],
    limits: {
      maxParallelTasks: 10,
      maxCompressedAttachmentBytes: 70_000_000,
      maxProviderErrorBytes: 128 * 1024,
      maxAnswerChars: 1_000_000,
    },
  };
  const worker = new WorkerPool({ config, database, events });
  const chatId = '44444444-4444-4444-8444-444444444444';
  const createdAt = new Date().toISOString();

  try {
    await initializeAttachmentBin(chatDir, chatId);
    const firstUpload = await stageTurn(chatDir, chatId, 1, [
      { name: 'first.txt', content: 'FIRST ATTACHMENT' },
    ]);
    await initializeTextBin(chatDir, chatId, {
      createdAt,
      modelId: 'model-a',
      modelLabel: '模型 A',
      prompt: '第一次问题',
      turnId: randomUUID(),
      attachments: firstUpload.manifest,
    });
    const firstTaskToken = randomUUID();
    assert.equal(database.reserveInitial({
      chat: {
        id: chatId,
        ownerId: 'owner-1',
        title: '第一次问题',
        promptPreview: '第一次问题',
        modelId: 'model-a',
        modelLabel: '模型 A',
        createdAt,
        hasAttachments: 1,
        attachmentCount: firstUpload.manifest.length,
        shareEnabled: 0,
        shareToken: null,
        archiveVersion: 2,
      },
      turn: {
        chatId,
        turnNo: 1,
        createdAt,
        hasAttachments: 1,
        attachmentCount: firstUpload.manifest.length,
        attachmentBytes: 0,
        attachmentReady: 0,
        taskToken: firstTaskToken,
        pendingDir: firstUpload.pendingDir,
      },
    }, 10), true);

    worker.start();
    await waitFor(() => database.getTurn(chatId, 1)?.status === 'completed');

    const secondCreatedAt = new Date(Date.now() + 1_000).toISOString();
    const secondUpload = await stageTurn(chatDir, chatId, 2, [
      { name: 'second.bin', content: Buffer.from([0, 1, 2, 3, 4]) },
    ]);
    const secondTaskToken = randomUUID();
    const followUp = database.reserveFollowUp(chatId, 'owner-1', {
      createdAt: secondCreatedAt,
      hasAttachments: 1,
      attachmentCount: secondUpload.manifest.length,
      attachmentBytes: 0,
      attachmentReady: 0,
      taskToken: secondTaskToken,
      pendingDir: secondUpload.pendingDir,
    }, 10);
    assert.deepEqual(followUp, { ok: true, turnNo: 2 });
    await appendTextEvent(chatDir, chatId, {
      type: 'turn_user',
      turnId: randomUUID(),
      turnNumber: 2,
      text: '第二次问题',
      createdAt: secondCreatedAt,
      attachments: secondUpload.manifest,
    });
    worker.enqueue(chatId, 2, secondTaskToken);
    await waitFor(() => database.getTurn(chatId, 2)?.status === 'completed');

    assert.equal(capturedBodies.length, 2);
    const firstUser = capturedBodies[0].messages.find((message) => message.role === 'user');
    const secondUser = capturedBodies[1].messages.find((message) => message.role === 'user');
    assert.equal(firstUser.content[0].text, '第一次问题');
    assert.match(secondUser.content[0].text, /^这是一次用户的追问，内容是 第二次问题/);
    assert.match(secondUser.content[0].text, /第一次提问：\n第一次问题/);
    assert.match(secondUser.content[0].text, /第一次回答：\n模型回答1/);
    assert.match(secondUser.content[0].text, /1\.zip是用户第一次提问时的附件打包zip/);

    const imageUrl = secondUser.content.find((part) => part.type === 'image_url').image_url.url;
    const polyglot = Buffer.from(imageUrl.slice(imageUrl.indexOf(',') + 1), 'base64');
    const carrier = await fsp.readFile(CARRIER_PATH);
    assert.equal(polyglot.subarray(0, carrier.length).compare(carrier), 0);
    const capturedOuter = path.join(chatDir, 'captured-att.zip');
    await fsp.writeFile(capturedOuter, polyglot.subarray(carrier.length));
    assert.deepEqual(await zipEntries(capturedOuter), ['1.zip', '2.zip']);

    const extracted = path.join(chatDir, 'captured-extracted');
    await fsp.mkdir(extracted);
    await execFileAsync('unzip', ['-qq', capturedOuter, '-d', extracted]);
    assert.deepEqual(await zipEntries(path.join(extracted, '1.zip')), ['first.txt']);
    assert.deepEqual(await zipEntries(path.join(extracted, '2.zip')), ['second.bin']);
    assert.deepEqual(await zipEntries(attachmentBinPath(chatDir, chatId)), ['1.zip', '2.zip']);
  } finally {
    await worker.stop().catch(() => {});
    database.close();
    await new Promise((resolve) => provider.close(resolve));
    await fsp.rm(chatDir, { recursive: true, force: true });
  }
});
