import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function listen(server, port = 0) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function freePort() {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(check, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw lastError || new Error('等待条件满足超时');
}

function authHeaders(cookie, extra = {}) {
  return { Cookie: cookie, ...extra };
}

async function json(response) {
  const body = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${body.error || JSON.stringify(body)}`);
  return body;
}

async function zipEntries(buffer, directory, name) {
  const filePath = path.join(directory, name);
  await fsp.writeFile(filePath, buffer);
  const { stdout } = await execFileAsync('unzip', ['-Z1', filePath], { encoding: 'utf8' });
  return stdout.split(/\r?\n/).filter(Boolean);
}

const dependenciesAvailable = fs.existsSync(path.join(ROOT, 'node_modules', 'express', 'package.json'))
  && fs.existsSync(path.join(ROOT, 'node_modules', 'helmet', 'package.json'));

test('HTTP API 完成登录、首问、追问、分享下载和编辑截断的真实联调', { timeout: 30_000, skip: !dependenciesAvailable }, async () => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'chat-app-integration-'));
  const chatDir = path.join(directory, 'chat');
  await fsp.mkdir(chatDir);
  const providerRequests = [];
  const provider = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      providerRequests.push(body);
      const user = body.messages.findLast((message) => message.role === 'user');
      const text = typeof user.content === 'string'
        ? user.content
        : user.content.find((part) => part.type === 'text')?.text || '';
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: `MOCK:${text.slice(0, 120)}` } }] }));
    });
  });
  const providerPort = await listen(provider);
  const appPort = await freePort();
  const token = 'integration-login-token-1234567890';
  const configPath = path.join(directory, 'config.json');
  await fsp.writeFile(configPath, JSON.stringify({
    listen: { host: '127.0.0.1', port: appPort },
    auth: {
      sessionSecret: 'integration-session-secret-12345678901234567890',
      cookieSecure: false,
      users: [{ id: 'integration-user', label: '集成用户', token }],
    },
    provider: {
      url: `http://127.0.0.1:${providerPort}/v1/chat/completions`,
      key: 'integration-provider-key',
      extraHeaders: {},
      systemPrompt: '',
    },
    models: [1, 2, 3, 4].map((number) => ({ id: `model-${number}`, label: `模型 ${number}`, request: {} })),
    limits: {
      maxParallelTasks: 10,
      maxCompressedAttachmentBytes: 70000000,
      maxRawUploadBytes: 536870912,
      maxFiles: 100,
      maxPromptChars: 100000,
      maxAnswerChars: 1000000,
      maxProviderErrorBytes: 131072,
    },
  }, null, 2));

  let output = '';
  const child = spawn(process.execPath, ['server/app.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      CONFIG_PATH: configPath,
      CHAT_DIR: chatDir,
      HOST: '127.0.0.1',
      PORT: String(appPort),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const base = `http://127.0.0.1:${appPort}`;

  try {
    await waitFor(async () => (await fetch(`${base}/api/health`)).ok);
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';', 1)[0];
    assert.match(cookie, /^model_chat_session=/);

    const initialForm = new FormData();
    initialForm.append('prompt', '第一次问题');
    initialForm.append('modelId', 'model-1');
    initialForm.append('shareEnabled', 'true');
    initialForm.append('clientId', '55555555-5555-4555-8555-555555555555');
    initialForm.append('attachments', new Blob(['FIRST'], { type: 'text/plain' }), 'first.txt');
    const initial = await json(await fetch(`${base}/api/chats`, {
      method: 'POST', headers: authHeaders(cookie), body: initialForm,
    }));
    assert.equal(initial.turns.length, 1);
    assert.equal(initial.turns[0].prompt, '第一次问题');
    assert.equal(initial.turns[0].hasAttachments, true);
    assert.match(initial.shareUrl, /^\/share\/[A-Za-z0-9_-]{43}$/);

    const completedFirst = await waitFor(async () => {
      const payload = await json(await fetch(`${base}/api/chats/${initial.id}`, { headers: authHeaders(cookie) }));
      return payload.turns[0].status === 'completed' ? payload : null;
    });
    assert.equal(completedFirst.turns[0].attachmentReady, true);

    const followForm = new FormData();
    followForm.append('prompt', '第二次问题');
    followForm.append('attachments', new Blob(['SECOND'], { type: 'application/octet-stream' }), 'second.bin');
    const followed = await json(await fetch(`${base}/api/chats/${initial.id}/turns`, {
      method: 'POST', headers: authHeaders(cookie), body: followForm,
    }));
    assert.equal(followed.turns.length, 2);
    assert.equal(followed.turns[1].prompt, '第二次问题');

    const completedSecond = await waitFor(async () => {
      const payload = await json(await fetch(`${base}/api/chats/${initial.id}`, { headers: authHeaders(cookie) }));
      return payload.turns[1]?.status === 'completed' ? payload : null;
    });
    assert.equal(completedSecond.turns[1].attachmentReady, true);
    assert.match(completedSecond.turns[1].answer, /这是一次用户的追问/);
    assert.equal(providerRequests.length, 2);

    const allPrivate = await fetch(`${base}/api/chats/${initial.id}/attachments`, { headers: authHeaders(cookie) });
    assert.equal(allPrivate.status, 200);
    assert.deepEqual(
      await zipEntries(Buffer.from(await allPrivate.arrayBuffer()), directory, 'private-all.zip'),
      ['1.zip', '2.zip'],
    );

    const shareToken = initial.shareUrl.split('/').at(-1);
    const publicConversation = await json(await fetch(`${base}/api/public/shares/${shareToken}`));
    assert.equal(publicConversation.turns.length, 2);
    assert.equal('id' in publicConversation, false);
    const publicTurn2 = await fetch(`${base}/api/public/shares/${shareToken}/turns/2/attachments`);
    assert.equal(publicTurn2.status, 200);
    assert.deepEqual(
      await zipEntries(Buffer.from(await publicTurn2.arrayBuffer()), directory, 'public-turn2.zip'),
      ['second.bin'],
    );

    const edited = await json(await fetch(`${base}/api/chats/${initial.id}/turns/1`, {
      method: 'PUT',
      headers: authHeaders(cookie, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ prompt: '编辑后的第一次问题' }),
    }));
    assert.equal(edited.turns.length, 1);
    assert.equal(edited.turns[0].prompt, '编辑后的第一次问题');
    assert.equal(edited.turns[0].hasAttachments, true);

    const completedEdit = await waitFor(async () => {
      const payload = await json(await fetch(`${base}/api/chats/${initial.id}`, { headers: authHeaders(cookie) }));
      return payload.turns.length === 1 && payload.turns[0].status === 'completed' ? payload : null;
    });
    assert.equal(completedEdit.turns[0].attachmentReady, true);
    const afterEditAll = await fetch(`${base}/api/chats/${initial.id}/attachments`, { headers: authHeaders(cookie) });
    assert.deepEqual(
      await zipEntries(Buffer.from(await afterEditAll.arrayBuffer()), directory, 'after-edit.zip'),
      ['1.zip'],
    );
    const removedTurn = await fetch(`${base}/api/chats/${initial.id}/turns/2/attachments`, { headers: authHeaders(cookie) });
    assert.equal(removedTurn.status, 404);

    const sharedAfterEdit = await json(await fetch(`${base}/api/public/shares/${shareToken}`));
    assert.equal(sharedAfterEdit.turns.length, 1);
    assert.equal(sharedAfterEdit.turns[0].prompt, '编辑后的第一次问题');
  } catch (error) {
    throw new Error(`${error.message}\n应用输出：\n${output}`);
  } finally {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    if (!child.killed) child.kill('SIGKILL');
    await new Promise((resolve) => provider.close(resolve));
    await fsp.rm(directory, { recursive: true, force: true });
  }
});
