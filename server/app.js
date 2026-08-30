import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import { loadConfig } from './config.js';
import { createAuth } from './auth.js';
import { createDatabase } from './db.js';
import { ChatEvents } from './events.js';
import { WorkerPool } from './worker.js';
import { AsyncMutex } from './mutex.js';
import { StorageCleanup } from './cleanup.js';
import { parseMultipartRequest } from './upload.js';
import {
  attachmentBinPath,
  cleanupStorageArtifacts,
  createAttachmentArchive,
  deleteChatFiles,
  initializeTextBinAt,
  readTextBin,
  textBinPath,
} from './storage.js';

const config = loadConfig();
await fsp.mkdir(config.chatDir, { recursive: true, mode: 0o700 });
const database = createDatabase(config.chatDir, { legacyOwnerId: config.auth.users[0].id });
await cleanupStorageArtifacts(config.chatDir, new Set(database.listAllIds()));
const auth = createAuth(config);
const events = new ChatEvents();
const workers = new WorkerPool({ config, database, events });
const app = express();
const commitMutex = new AsyncMutex();
const cleanup = new StorageCleanup({
  chatDir: config.chatDir,
  database,
  workers,
  events,
  mutex: commitMutex,
});
await cleanup.run('startup');
const deleteGenerations = new Map();
let submissionsInProgress = 0;

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({
  strictTransportSecurity: false,
  referrerPolicy: { policy: 'no-referrer' },
  crossOriginResourcePolicy: { policy: 'same-origin' },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      styleSrc: ["'self'"],
      scriptSrc: ["'self'"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: null,
    },
  },
}));
app.use(express.json({ limit: '32kb' }));
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

function validateId(req, res, next) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.params.id)) {
    res.status(400).json({ error: '无效的对话 ID' });
    return;
  }
  next();
}

function validateShareToken(req, res, next) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(req.params.shareToken)) {
    res.status(404).json({ error: '分享链接不存在或已关闭' });
    return;
  }
  next();
}

function createShareToken() {
  return randomBytes(32).toString('base64url');
}

function normalizeTitle(prompt) {
  const singleLine = prompt.replace(/\s+/g, ' ').trim();
  return singleLine.slice(0, 80) || '新问题';
}

function generationFor(ownerId) {
  return deleteGenerations.get(ownerId) || 0;
}

function bumpGeneration(ownerId) {
  const next = generationFor(ownerId) + 1;
  deleteGenerations.set(ownerId, next);
  return next;
}

function acquireSubmissionSlot() {
  if (database.countUnfinished() + submissionsInProgress >= config.limits.maxParallelTasks) {
    return false;
  }
  submissionsInProgress += 1;
  return true;
}

function releaseSubmissionSlot() {
  submissionsInProgress = Math.max(0, submissionsInProgress - 1);
}

function httpErrorStatus(error) {
  if (['RAW_UPLOAD_LIMIT', 'COMPRESSED_LIMIT', 'FIELD_LIMIT', 'FILES_LIMIT', 'PARTS_LIMIT'].includes(error?.code)) {
    return 413;
  }
  if (error?.code === 'DELETE_ALL_CONFLICT') return 409;
  return 400;
}

function ownerChatDto(chat) {
  if (!chat) return null;
  return {
    id: chat.id,
    title: chat.title,
    promptPreview: chat.promptPreview,
    modelId: chat.modelId,
    modelLabel: chat.modelLabel,
    status: chat.status,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    startedAt: chat.startedAt,
    completedAt: chat.completedAt,
    hasAttachments: chat.hasAttachments,
    attachmentCount: chat.attachmentCount,
    attachmentBytes: chat.attachmentBytes,
    error: chat.error,
    attemptId: chat.attemptId,
    shared: chat.shared,
    shareUrl: chat.shared ? `/share/${chat.shareToken}` : null,
    version: chat.version,
  };
}

function publicChatDto(chat) {
  if (!chat) return null;
  return {
    title: chat.title,
    modelLabel: chat.modelLabel,
    status: chat.status,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    completedAt: chat.completedAt,
    hasAttachments: chat.hasAttachments,
    attachmentCount: chat.attachmentCount,
    attachmentBytes: chat.attachmentBytes,
    error: chat.error,
    attemptId: chat.attemptId,
    version: chat.version,
  };
}

function streamChatEvents(req, res, { initialChat, resolveAccess, publicView = false }) {
  res.status(200);
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  let ready = false;
  let closed = false;
  const pending = [];
  const send = (event, payload) => {
    if (closed || res.destroyed) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
  };
  const closeUnavailable = () => {
    send('update', { type: publicView ? 'share_unavailable' : 'deleted' });
    cleanup();
    res.end();
  };
  const deliver = (payload) => {
    const current = resolveAccess();
    if (!current) {
      closeUnavailable();
      return;
    }
    if (ready) send('update', payload);
    else pending.push(payload);
  };
  const unsubscribe = events.subscribe(initialChat.id, deliver);
  const heartbeat = setInterval(() => {
    if (!closed && !res.destroyed) res.write(': heartbeat\n\n');
  }, 15_000);
  req.once('close', cleanup);

  void (async () => {
    const text = await readTextBin(config.chatDir, initialChat.id);
    const current = resolveAccess();
    if (!current) {
      closeUnavailable();
      return;
    }
    send('snapshot', {
      chat: publicView ? publicChatDto(current) : ownerChatDto(current),
      prompt: text.prompt,
      answer: current.status === 'failed' ? (current.error || '模型调用失败') : text.answer,
      deltaSequence: text.deltaSequence,
    });
    ready = true;
    for (const payload of pending.splice(0)) deliver(payload);
  })().catch((error) => {
    if (!res.destroyed) {
      send('server_error', { error: '无法读取任务状态' });
      res.end();
    }
    cleanup();
    console.error(error);
  });
}

function sendAttachmentArchive(res, chat, filenamePrefix) {
  if (!chat.hasAttachments) return res.status(404).json({ error: '该问题没有附件' });
  const archivePath = attachmentBinPath(config.chatDir, chat.id);
  if (!fs.existsSync(archivePath)) return res.status(404).json({ error: '附件包不存在' });
  res.set({
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${filenamePrefix}-attachments.zip"`,
    'Cache-Control': 'private, no-store',
  });
  return res.sendFile(archivePath);
}

// Public service and authentication endpoints.
app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/auth/login', (req, res) => {
  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  const user = auth.findByToken(token);
  if (!user) return res.status(401).json({ error: 'token 无效' });
  auth.setSession(res, user);
  return res.json({ user });
});

app.post('/api/auth/logout', (_req, res) => {
  auth.clearSession(res);
  res.status(204).end();
});

app.get('/api/auth/me', auth.requireAuth, (req, res) => {
  res.json({ user: req.user });
});

app.get('/api/public/shares/:shareToken', validateShareToken, async (req, res, next) => {
  try {
    const chat = database.getPublicChat(req.params.shareToken);
    if (!chat) return res.status(404).json({ error: '分享链接不存在或已关闭' });
    const text = await readTextBin(config.chatDir, chat.id);
    return res.json({
      ...publicChatDto(chat),
      prompt: text.prompt,
      answer: chat.status === 'failed' ? (chat.error || '模型调用失败') : text.answer,
      deltaSequence: text.deltaSequence,
    });
  } catch (error) {
    return next(error);
  }
});

app.get('/api/public/shares/:shareToken/events', validateShareToken, (req, res) => {
  const initialChat = database.getPublicChat(req.params.shareToken);
  if (!initialChat) return res.status(404).json({ error: '分享链接不存在或已关闭' });
  streamChatEvents(req, res, {
    initialChat,
    publicView: true,
    resolveAccess: () => database.getPublicChat(req.params.shareToken),
  });
  return undefined;
});

app.get('/api/public/shares/:shareToken/attachments', validateShareToken, (req, res) => {
  const chat = database.getPublicChat(req.params.shareToken);
  if (!chat) return res.status(404).json({ error: '分享链接不存在或已关闭' });
  return sendAttachmentArchive(res, chat, 'shared-question');
});

// Everything below this middleware is a private API scoped to the logged-in token.
app.use('/api', auth.requireAuth);

app.get('/api/config', (_req, res) => {
  res.json({
    models: config.models.map(({ id, label }) => ({ id, label })),
    limits: {
      maxParallelTasks: config.limits.maxParallelTasks,
      maxCompressedAttachmentBytes: config.limits.maxCompressedAttachmentBytes,
      maxRawUploadBytes: config.limits.maxRawUploadBytes,
      maxFiles: config.limits.maxFiles,
      maxPromptChars: config.limits.maxPromptChars,
    },
  });
});

app.get('/api/chats', (req, res) => {
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 100, 1), 200);
  const offset = Math.max(Number.parseInt(req.query.offset, 10) || 0, 0);
  const result = database.listChats(req.user.id, limit, offset);
  res.json({ ...result, items: result.items.map(ownerChatDto) });
});

app.get('/api/chats/:id', validateId, async (req, res, next) => {
  try {
    const chat = database.getOwnedChat(req.params.id, req.user.id);
    if (!chat) return res.status(404).json({ error: '记录不存在' });
    const text = await readTextBin(config.chatDir, req.params.id);
    return res.json({
      ...ownerChatDto(chat),
      prompt: text.prompt,
      answer: chat.status === 'failed' ? (chat.error || '模型调用失败') : text.answer,
      deltaSequence: text.deltaSequence,
    });
  } catch (error) {
    return next(error);
  }
});

app.get('/api/chats/:id/events', validateId, (req, res) => {
  const initialChat = database.getOwnedChat(req.params.id, req.user.id);
  if (!initialChat) return res.status(404).json({ error: '记录不存在' });
  streamChatEvents(req, res, {
    initialChat,
    resolveAccess: () => database.getOwnedChat(req.params.id, req.user.id),
  });
  return undefined;
});

app.get('/api/chats/:id/attachments', validateId, (req, res) => {
  const chat = database.getOwnedChat(req.params.id, req.user.id);
  if (!chat) return res.status(404).json({ error: '记录不存在' });
  return sendAttachmentArchive(res, chat, req.params.id);
});

app.patch('/api/chats/:id/share', validateId, (req, res) => {
  const chat = database.getOwnedChat(req.params.id, req.user.id);
  if (!chat) return res.status(404).json({ error: '记录不存在' });
  if (typeof req.body?.enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled 必须是布尔值' });
  }
  const shareToken = req.body.enabled ? (chat.shareToken || createShareToken()) : null;
  database.setShare(chat.id, req.user.id, shareToken);
  const updated = database.getOwnedChat(chat.id, req.user.id);
  const dto = ownerChatDto(updated);
  events.emit(chat.id, { type: 'share', shared: updated.shared, shareUrl: dto.shareUrl });
  return res.json(dto);
});

app.post('/api/chats', async (req, res) => {
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('multipart/form-data')) {
    return res.status(415).json({ error: '请使用 multipart/form-data 提交' });
  }
  if (!acquireSubmissionSlot()) {
    req.resume();
    return res.status(429).json({ error: `当前已有 ${config.limits.maxParallelTasks} 个进行中任务或上传，请稍后再提交` });
  }

  const id = randomUUID();
  const ownerId = req.user.id;
  const generationAtStart = generationFor(ownerId);
  let upload;
  try {
    upload = await parseMultipartRequest(req, {
      chatDir: config.chatDir,
      maxRawUploadBytes: config.limits.maxRawUploadBytes,
      maxFiles: config.limits.maxFiles,
      maxPromptChars: config.limits.maxPromptChars,
    });

    const prompt = String(upload.fields.prompt || '').trim();
    const modelId = String(upload.fields.modelId || '').trim();
    const shareEnabled = ['1', 'true', 'on', 'yes'].includes(String(upload.fields.shareEnabled || '').toLowerCase());
    if (!prompt) throw new Error('问题不能为空');
    if (prompt.length > config.limits.maxPromptChars) throw new Error('问题文字过长');
    const model = config.models.find((candidate) => candidate.id === modelId);
    if (!model) throw new Error('请选择有效模型');

    if (generationAtStart !== generationFor(ownerId)) {
      throw Object.assign(
        new Error('提交期间执行了“删除全部”，本次问题未保存，请重新提交'),
        { code: 'DELETE_ALL_CONFLICT' },
      );
    }

    const stagedAttachmentPath = path.join(upload.directory, 'attachments.bin');
    const stagedTextPath = path.join(upload.directory, 'text.bin');
    const archiveResult = await createAttachmentArchive({
      files: upload.files,
      destination: stagedAttachmentPath,
      maxBytes: config.limits.maxCompressedAttachmentBytes,
    });
    const createdAt = new Date().toISOString();
    await initializeTextBinAt(stagedTextPath, id, {
      createdAt,
      modelId: model.id,
      modelLabel: model.label,
      prompt,
      attachments: upload.files.map((file, index) => ({
        name: archiveResult.names[index],
        originalName: file.originalName,
        mimeType: file.mimeType,
      })),
    });

    const reserved = await commitMutex.runExclusive(async () => {
      if (generationAtStart !== generationFor(ownerId)) {
        throw Object.assign(
          new Error('提交期间执行了“删除全部”，本次问题未保存，请重新提交'),
          { code: 'DELETE_ALL_CONFLICT' },
        );
      }
      const finalAttachmentPath = attachmentBinPath(config.chatDir, id);
      const finalTextPath = textBinPath(config.chatDir, id);
      try {
        await fsp.rename(stagedAttachmentPath, finalAttachmentPath);
        await fsp.rename(stagedTextPath, finalTextPath);
        const shareToken = shareEnabled ? createShareToken() : null;
        const didReserve = database.reserveChat({
          id,
          ownerId,
          title: normalizeTitle(prompt),
          promptPreview: prompt.slice(0, 240),
          modelId: model.id,
          modelLabel: model.label,
          createdAt,
          hasAttachments: upload.files.length ? 1 : 0,
          attachmentCount: upload.files.length,
          attachmentBytes: upload.files.length ? archiveResult.bytes : 0,
          shareEnabled: shareToken ? 1 : 0,
          shareToken,
        }, config.limits.maxParallelTasks);
        if (!didReserve) {
          await deleteChatFiles(config.chatDir, id);
          return null;
        }
        workers.enqueue(id);
        return database.getOwnedChat(id, ownerId);
      } catch (error) {
        await deleteChatFiles(config.chatDir, id).catch(() => {});
        throw error;
      }
    });

    if (!reserved) {
      return res.status(429).json({ error: `当前已有 ${config.limits.maxParallelTasks} 个未完成任务，请稍后再提交` });
    }
    return res.status(202).json({ id, status: 'queued', shared: reserved.shared, shareUrl: ownerChatDto(reserved).shareUrl });
  } catch (error) {
    await deleteChatFiles(config.chatDir, id).catch(() => {});
    if (req.aborted || res.destroyed) return undefined;
    return res.status(httpErrorStatus(error)).json({ error: String(error?.message || error) });
  } finally {
    releaseSubmissionSlot();
    await upload?.cleanup?.().catch(() => {});
  }
});

app.delete('/api/chats/:id', validateId, async (req, res, next) => {
  try {
    if (!database.getOwnedChat(req.params.id, req.user.id)) return res.status(404).json({ error: '记录不存在' });
    await workers.cancel(req.params.id);
    database.deleteOwnedChat(req.params.id, req.user.id);
    await deleteChatFiles(config.chatDir, req.params.id);
    events.emit(req.params.id, { type: 'deleted' });
    return res.status(204).end();
  } catch (error) {
    return next(error);
  }
});

app.delete('/api/chats', async (req, res, next) => {
  const ownerId = req.user.id;
  bumpGeneration(ownerId);
  try {
    const deleted = await commitMutex.runExclusive(async () => {
      const ids = database.listOwnedIds(ownerId);
      await workers.cancelMany(ids);
      const count = database.deleteOwnedAll(ownerId);
      await Promise.all(ids.map((id) => deleteChatFiles(config.chatDir, id)));
      for (const id of ids) events.emit(id, { type: 'deleted' });
      return count;
    });
    return res.json({ deleted });
  } catch (error) {
    return next(error);
  }
});

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'API 路径不存在' });
});

if (fs.existsSync(config.distDir)) {
  app.use(express.static(config.distDir, {
    index: false,
    maxAge: '1h',
    etag: true,
  }));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
    res.set('Cache-Control', 'no-cache');
    return res.sendFile(path.join(config.distDir, 'index.html'));
  });
} else {
  app.use((req, res, next) => {
    if (req.method !== 'GET') return next();
    return res.status(503).type('text/plain').send('前端尚未构建。请运行 npm run build。');
  });
}

app.use((error, _req, res, _next) => {
  console.error(error);
  if (res.headersSent) return;
  if (error?.type === 'entity.parse.failed') {
    res.status(400).json({ error: '请求 JSON 格式无效' });
    return;
  }
  if (error?.type === 'entity.too.large') {
    res.status(413).json({ error: '请求体过大' });
    return;
  }
  res.status(500).json({ error: '服务器内部错误' });
});

const server = app.listen(config.listen.port, config.listen.host, () => {
  console.log(`HTTP server listening on http://${config.listen.host}:${config.listen.port}`);
  console.log(`Model provider: ${new URL(config.provider.url).protocol}//${new URL(config.provider.url).host}`);
  console.log(`Data directory: ${config.chatDir}`);
  console.log('Automatic cleanup: every 10 minutes; 7-day retention; delete chats older than 24 hours when chat storage exceeds 3,000,000,000 bytes.');
  workers.start();
  cleanup.start();
});
server.requestTimeout = 0;
server.headersTimeout = 65_000;
server.keepAliveTimeout = 60_000;

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; stopping HTTP server and preserving unfinished tasks for restart.`);
  server.close();
  await cleanup.stop();
  await workers.stop();
  database.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
