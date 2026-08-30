import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { callProvider } from '../server/provider.js';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address())));
}
function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function configFor(url) {
  return {
    provider: { url, key: 'secret', extraHeaders: {}, systemPrompt: '' },
    limits: { maxProviderErrorBytes: 131072, maxAnswerChars: 10_000_000 },
  };
}

const model = { id: 'mock-model', request: {} };

test('解析 OpenAI-compatible SSE 分片', async () => {
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer secret');
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const payload = JSON.parse(body);
      assert.equal(payload.model, 'mock-model');
      assert.equal(payload.messages[0].content, 'hello');
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"你"}}]}\n\n');
      setTimeout(() => {
        res.write('data: {"choices":[{"delta":{"content":"好"}}]}\n\n');
        res.end('data: [DONE]\n\n');
      }, 30);
    });
  });
  const address = await listen(server);
  let answer = '';
  try {
    await callProvider({
      config: configFor(`http://127.0.0.1:${address.port}/v1/chat/completions`),
      model,
      prompt: 'hello',
      hasAttachments: false,
      onDelta: async (text) => { answer += text; },
    });
    assert.equal(answer, '你好');
  } finally {
    await close(server);
  }
});

test('解析非流式 JSON 回答', async () => {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '完成' } }] }));
    });
  });
  const address = await listen(server);
  let answer = '';
  try {
    await callProvider({
      config: configFor(`http://127.0.0.1:${address.port}/chat/completions`),
      model,
      prompt: 'hello',
      hasAttachments: false,
      onDelta: async (text) => { answer += text; },
    });
    assert.equal(answer, '完成');
  } finally {
    await close(server);
  }
});


test('流式回答超过配置字符上限时会停止', async () => {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: {"choices":[{"delta":{"content":"123456"}}]}\n\ndata: [DONE]\n\n');
    });
  });
  const address = await listen(server);
  const config = configFor(`http://127.0.0.1:${address.port}/chat/completions`);
  config.limits.maxAnswerChars = 5;
  try {
    await assert.rejects(
      callProvider({
        config,
        model,
        prompt: 'hello',
        hasAttachments: false,
        onDelta: async () => {},
      }),
      /超过 5 字符/,
    );
  } finally {
    await close(server);
  }
});

test('带附件请求的图片字节严格等于彩色 a.jpg 后拼接外层附件包', async () => {
  const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const directory = await mkdtemp(join(tmpdir(), 'provider-attachment-'));
  const attachmentPath = join(directory, 'all_att.zip');
  const attachmentBytes = Buffer.from('PK\u0003\u0004mock-zip-tail', 'binary');
  await writeFile(attachmentPath, attachmentBytes);
  let captured;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      captured = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '收到' } }] }));
    });
  });
  const address = await listen(server);
  try {
    await callProvider({
      config: configFor(`http://127.0.0.1:${address.port}/chat/completions`),
      model,
      prompt: '读取附件',
      attachmentPath,
      hasAttachments: true,
      onDelta: async () => {},
    });
    assert.equal(captured.messages[0].role, 'system');
    assert.match(captured.messages[0].content, /cat x\.jpg att\.zip > xa\.jpg/);
    const dataUrl = captured.messages[1].content[1].image_url.url;
    const decoded = Buffer.from(dataUrl.split(',')[1], 'base64');
    const here = dirname(fileURLToPath(import.meta.url));
    const carrier = await readFile(join(here, '..', 'server', 'assets', 'a.jpg'));
    const compatibilityAlias = await readFile(join(here, '..', 'server', 'assets', 'x.jpg'));
    assert.deepEqual(compatibilityAlias, carrier);
    assert.deepEqual(decoded, Buffer.concat([carrier, attachmentBytes]));
  } finally {
    await close(server);
    await rm(directory, { recursive: true, force: true });
  }
});

test('HTTP provider 错误优先显示可读原因', async () => {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(402, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          message: 'insufficient credit',
          type: 'payment_required',
          code: 'insufficient_credit',
        },
      }));
    });
  });
  const address = await listen(server);
  try {
    await assert.rejects(
      callProvider({
        config: configFor(`http://127.0.0.1:${address.port}/chat/completions`),
        model,
        prompt: 'hello',
        hasAttachments: false,
        onDelta: async () => {},
      }),
      /provider HTTP 402：insufficient credit（type: payment_required；code: insufficient_credit）/,
    );
  } finally {
    await close(server);
  }
});

test('SSE provider 错误直接保留错误原因', async () => {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: {"error":{"message":"insufficient credit","code":"insufficient_credit"}}\n\n');
    });
  });
  const address = await listen(server);
  try {
    await assert.rejects(
      callProvider({
        config: configFor(`http://127.0.0.1:${address.port}/chat/completions`),
        model,
        prompt: 'hello',
        hasAttachments: false,
        onDelta: async () => {},
      }),
      /provider 错误：insufficient credit（code: insufficient_credit）/,
    );
  } finally {
    await close(server);
  }
});

test('SSE 只有 DONE 而没有文本时按 provider 空回答报错', async () => {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: [DONE]\n\n');
    });
  });
  const address = await listen(server);
  try {
    await assert.rejects(
      callProvider({
        config: configFor(`http://127.0.0.1:${address.port}/chat/completions`),
        model,
        prompt: 'hello',
        hasAttachments: false,
        onDelta: async () => {},
      }),
      /SSE 响应为空|没有可显示的文本/,
    );
  } finally {
    await close(server);
  }
});
