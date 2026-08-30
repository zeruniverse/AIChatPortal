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
  adoptPendingUpload,
  appendTextEvent,
  attachmentBinPath,
  cleanupStorageArtifacts,
  deleteChatFiles,
  deleteTurnFilesFrom,
  initializeAttachmentBin,
  initializeTextBinAt,
  readConversation,
  rewriteConversationText,
  materializeTurnAttachment,
  truncateConversationArchive,
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
const cleanup = new StorageCleanup({ chatDir: config.chatDir, database, workers, events, mutex: commitMutex });
await cleanup.run('startup');
const deleteGenerations = new Map();
let submissionsInProgress = 0;

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({
  // These isolation headers are ignored or noisy on ordinary HTTP IP origins.
  // The application does not need cross-origin isolation, so omit them uniformly
  // for HTML, API, static assets and redirects.
  crossOriginOpenerPolicy: false,
  crossOriginEmbedderPolicy: false,
  originAgentCluster: false,
  strictTransportSecurity: false,
  referrerPolicy: { policy: 'no-referrer' },
  crossOriginResourcePolicy: { policy: 'same-origin' },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"], imgSrc: ["'self'", 'data:', 'blob:'], styleSrc: ["'self'"],
      scriptSrc: ["'self'"], connectSrc: ["'self'"], objectSrc: ["'none'"],
      baseUri: ["'self'"], frameAncestors: ["'none'"], upgradeInsecureRequests: null,
    },
  },
}));
app.use((_req, res, next) => {
  // Defensive removal keeps every response uniform even if Helmet defaults
  // change in a future dependency update.
  res.removeHeader('Cross-Origin-Opener-Policy');
  res.removeHeader('Cross-Origin-Embedder-Policy');
  res.removeHeader('Origin-Agent-Cluster');
  res.removeHeader('Strict-Transport-Security');
  next();
});
app.use(express.json({ limit: '256kb' }));
app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function validateId(req, res, next) {
  if (!ID_RE.test(req.params.id)) return res.status(400).json({ error: '无效的对话 ID' });
  return next();
}
function validateTurnNo(req, res, next) {
  const value = Number(req.params.turnNo);
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000) return res.status(400).json({ error: '无效的轮次' });
  req.turnNo = value;
  return next();
}
function validateShareToken(req, res, next) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(req.params.shareToken)) return res.status(404).json({ error: '分享链接不存在或已关闭' });
  return next();
}
function createShareToken() { return randomBytes(32).toString('base64url'); }
function normalizeTitle(prompt) { return prompt.replace(/\s+/g, ' ').trim().slice(0, 80) || '新问题'; }
function generationFor(ownerId) { return deleteGenerations.get(ownerId) || 0; }
function bumpGeneration(ownerId) { const next = generationFor(ownerId) + 1; deleteGenerations.set(ownerId, next); return next; }
function acquireSubmissionSlot() {
  if (database.countUnfinished() + submissionsInProgress >= config.limits.maxParallelTasks) return false;
  submissionsInProgress += 1;
  return true;
}
function releaseSubmissionSlot() { submissionsInProgress = Math.max(0, submissionsInProgress - 1); }
function httpErrorStatus(error) {
  if (['RAW_UPLOAD_LIMIT', 'COMPRESSED_LIMIT', 'FIELD_LIMIT', 'FILES_LIMIT', 'PARTS_LIMIT'].includes(error?.code)) return 413;
  if (error?.code === 'DELETE_ALL_CONFLICT') return 409;
  return 400;
}

function chatDto(chat) {
  return {
    id: chat.id, title: chat.title, promptPreview: chat.promptPreview,
    modelId: chat.modelId, modelLabel: chat.modelLabel, status: chat.status,
    createdAt: chat.createdAt, updatedAt: chat.updatedAt, completedAt: chat.completedAt,
    hasAttachments: chat.hasAttachments, attachmentCount: chat.attachmentCount,
    attachmentBytes: chat.attachmentBytes, turnCount: chat.turnCount,
    error: chat.error, shared: chat.shared,
    shareUrl: chat.shared ? `/share/${chat.shareToken}` : null, version: chat.version,
  };
}
function publicChatDto(chat) {
  const dto = chatDto(chat);
  delete dto.id;
  delete dto.modelId;
  delete dto.shareUrl;
  return dto;
}

async function conversationDto(conversation, { publicView = false } = {}) {
  if (!conversation) return null;
  const text = await readConversation(config.chatDir, conversation.chat.id);
  const byNo = new Map(text.turns.map((turn) => [turn.turnNumber, turn]));
  const turns = conversation.turns.map((turn) => {
    const content = byNo.get(turn.turnNo) || {};
    return {
      turnNo: turn.turnNo,
      prompt: content.prompt || '',
      answer: turn.status === 'failed' ? (turn.error || content.error || '模型调用失败') : (content.answer || ''),
      status: turn.status,
      createdAt: turn.createdAt,
      updatedAt: turn.updatedAt,
      completedAt: turn.completedAt,
      hasAttachments: turn.hasAttachments,
      attachmentCount: turn.attachmentCount,
      attachmentBytes: turn.attachmentBytes,
      attachmentReady: turn.attachmentReady,
      error: turn.error,
      attemptId: turn.attemptId || content.latestAttemptId || null,
      deltaSequence: content.deltaSequence || 0,
    };
  });
  return { ...(publicView ? publicChatDto(conversation.chat) : chatDto(conversation.chat)), turns };
}

function streamConversationEvents(req, res, { initial, resolveAccess, publicView = false }) {
  res.status(200);
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  let closed = false;
  let ready = false;
  const pending = [];
  const send = (event, payload) => {
    if (closed || res.destroyed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  };
  const stop = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
  };
  const deliver = (payload) => {
    if (!resolveAccess()) {
      send('update', { type: publicView ? 'share_unavailable' : 'deleted' });
      stop();
      res.end();
      return;
    }
    if (ready) send('update', payload); else pending.push(payload);
  };
  const unsubscribe = events.subscribe(initial.chat.id, deliver);
  const heartbeat = setInterval(() => { if (!closed && !res.destroyed) res.write(': heartbeat\n\n'); }, 15_000);
  req.once('close', stop);
  void conversationDto(initial, { publicView }).then((payload) => {
    if (!resolveAccess()) return deliver({ type: 'deleted' });
    send('snapshot', payload);
    ready = true;
    for (const item of pending.splice(0)) deliver(item);
  }).catch((error) => {
    console.error(error);
    send('server_error', { error: '无法读取对话状态' });
    stop();
    res.end();
  });
}

async function sendTurnAttachment(res, conversation, turnNo, filenamePrefix) {
  const turn = conversation.turns.find((candidate) => candidate.turnNo === turnNo);
  if (!turn) return res.status(404).json({ error: '轮次不存在' });
  if (!turn.hasAttachments) return res.status(404).json({ error: '该轮没有附件' });
  if (!turn.attachmentReady) return res.status(409).json({ error: '附件仍在压缩，暂时不能下载' });
  const temporary = await materializeTurnAttachment({
    chatDir: config.chatDir,
    chatId: conversation.chat.id,
    turnNumber: turnNo,
    archiveVersion: conversation.chat.archiveVersion,
  });
  if (!temporary) return res.status(404).json({ error: '附件包不存在' });
  res.set({ 'Cache-Control': 'private, no-store' });
  return new Promise((resolve, reject) => {
    res.download(temporary, `${filenamePrefix}-turn-${turnNo}-attachments.zip`, async (error) => {
      await fsp.rm(temporary, { force: true }).catch(() => {});
      if (error && !res.headersSent) reject(error); else resolve();
    });
  });
}

function sendAllAttachments(res, conversation, filenamePrefix) {
  const attached = conversation.turns.filter((turn) => turn.hasAttachments);
  if (!attached.length) return res.status(404).json({ error: '该对话没有附件' });
  if (attached.some((turn) => !turn.attachmentReady)) return res.status(409).json({ error: '仍有附件正在压缩，暂时不能下载全部附件' });
  const archivePath = attachmentBinPath(config.chatDir, conversation.chat.id);
  if (!fs.existsSync(archivePath)) return res.status(404).json({ error: '附件包不存在' });
  res.set({ 'Cache-Control': 'private, no-store' });
  return res.download(archivePath, `${filenamePrefix}-all-attachments.zip`);
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.post('/api/auth/login', (req, res) => {
  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  const user = auth.findByToken(token);
  if (!user) return res.status(401).json({ error: 'token 无效' });
  auth.setSession(res, user);
  return res.json({ user });
});
app.post('/api/auth/logout', (_req, res) => { auth.clearSession(res); res.status(204).end(); });
app.get('/api/auth/me', (req, res) => {
  const user = auth.userFromRequest(req);
  if (!user) return res.json({ authenticated: false, user: null });
  auth.setSession(res, user);
  return res.json({ authenticated: true, user });
});

app.get('/api/public/shares/:shareToken', validateShareToken, async (req, res, next) => {
  try {
    const conversation = database.getPublicConversation(req.params.shareToken);
    if (!conversation) return res.status(404).json({ error: '分享链接不存在或已关闭' });
    return res.json(await conversationDto(conversation, { publicView: true }));
  } catch (error) { return next(error); }
});
app.get('/api/public/shares/:shareToken/events', validateShareToken, (req, res) => {
  const initial = database.getPublicConversation(req.params.shareToken);
  if (!initial) return res.status(404).json({ error: '分享链接不存在或已关闭' });
  streamConversationEvents(req, res, {
    initial, publicView: true,
    resolveAccess: () => database.getPublicConversation(req.params.shareToken),
  });
  return undefined;
});
app.get('/api/public/shares/:shareToken/turns/:turnNo/attachments', validateShareToken, validateTurnNo, async (req, res, next) => {
  try {
    const conversation = database.getPublicConversation(req.params.shareToken);
    if (!conversation) return res.status(404).json({ error: '分享链接不存在或已关闭' });
    return await sendTurnAttachment(res, conversation, req.turnNo, 'shared-conversation');
  } catch (error) { return next(error); }
});
app.get('/api/public/shares/:shareToken/attachments', validateShareToken, async (req, res, next) => {
  try {
    const conversation = database.getPublicConversation(req.params.shareToken);
    if (!conversation) return res.status(404).json({ error: '分享链接不存在或已关闭' });
    return await sendAllAttachments(res, conversation, 'shared-conversation');
  } catch (error) { return next(error); }
});

app.use('/api', auth.requireAuth);
app.get('/api/config', (_req, res) => res.json({
  models: config.models.map(({ id, label }) => ({ id, label })),
  limits: {
    maxParallelTasks: config.limits.maxParallelTasks,
    maxCompressedAttachmentBytes: config.limits.maxCompressedAttachmentBytes,
    maxRawUploadBytes: config.limits.maxRawUploadBytes,
    maxFiles: config.limits.maxFiles,
    maxPromptChars: config.limits.maxPromptChars,
  },
}));
app.get('/api/chats', (req, res) => {
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 100, 1), 200);
  const offset = Math.max(Number.parseInt(req.query.offset, 10) || 0, 0);
  const result = database.listChats(req.user.id, limit, offset);
  res.json({ ...result, items: result.items.map(chatDto) });
});
app.get('/api/chats/:id', validateId, async (req, res, next) => {
  try {
    const conversation = database.getOwnedConversation(req.params.id, req.user.id);
    if (!conversation) return res.status(404).json({ error: '记录不存在' });
    return res.json(await conversationDto(conversation));
  } catch (error) { return next(error); }
});
app.get('/api/chats/:id/events', validateId, (req, res) => {
  const initial = database.getOwnedConversation(req.params.id, req.user.id);
  if (!initial) return res.status(404).json({ error: '记录不存在' });
  streamConversationEvents(req, res, {
    initial, resolveAccess: () => database.getOwnedConversation(req.params.id, req.user.id),
  });
  return undefined;
});
app.get('/api/chats/:id/turns/:turnNo/attachments', validateId, validateTurnNo, async (req, res, next) => {
  try {
    const conversation = database.getOwnedConversation(req.params.id, req.user.id);
    if (!conversation) return res.status(404).json({ error: '记录不存在' });
    return await sendTurnAttachment(res, conversation, req.turnNo, req.params.id);
  } catch (error) { return next(error); }
});
app.get('/api/chats/:id/attachments', validateId, async (req, res, next) => {
  try {
    const conversation = database.getOwnedConversation(req.params.id, req.user.id);
    if (!conversation) return res.status(404).json({ error: '记录不存在' });
    return await sendAllAttachments(res, conversation, req.params.id);
  } catch (error) { return next(error); }
});
app.patch('/api/chats/:id/share', validateId, (req, res) => {
  const chat = database.getOwnedChat(req.params.id, req.user.id);
  if (!chat) return res.status(404).json({ error: '记录不存在' });
  if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'enabled 必须是布尔值' });
  const shareToken = req.body.enabled ? (chat.shareToken || createShareToken()) : null;
  database.setShare(chat.id, req.user.id, shareToken);
  const updated = database.getOwnedChat(chat.id, req.user.id);
  const dto = chatDto(updated);
  events.emit(chat.id, { type: 'share', shared: updated.shared, shareUrl: dto.shareUrl });
  return res.json(dto);
});

async function parseChatMultipart(req) {
  return parseMultipartRequest(req, {
    chatDir: config.chatDir,
    maxRawUploadBytes: config.limits.maxRawUploadBytes,
    maxFiles: config.limits.maxFiles,
    maxPromptChars: config.limits.maxPromptChars,
  });
}
function requireMultipart(req, res) {
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('multipart/form-data')) {
    res.status(415).json({ error: '请使用 multipart/form-data 提交' });
    return false;
  }
  return true;
}
function validatePromptModel(upload, { requireModel = false } = {}) {
  const prompt = String(upload.fields.prompt || '').trim();
  if (!prompt) throw new Error('问题不能为空');
  if (prompt.length > config.limits.maxPromptChars) throw new Error('问题文字过长');
  const modelId = String(upload.fields.modelId || '').trim();
  const model = requireModel ? config.models.find((candidate) => candidate.id === modelId) : null;
  if (requireModel && !model) throw new Error('请选择有效模型');
  return { prompt, model };
}

app.post('/api/chats', async (req, res) => {
  if (!requireMultipart(req, res)) return undefined;
  if (!acquireSubmissionSlot()) { req.resume(); return res.status(429).json({ error: `当前已有 ${config.limits.maxParallelTasks} 个进行中任务或上传，请稍后再提交` }); }
  const ownerId = req.user.id;
  const generationAtStart = generationFor(ownerId);
  let upload;
  let id;
  let adopted = false;
  try {
    upload = await parseChatMultipart(req);
    const requestedId = String(upload.fields.clientId || '').trim();
    id = requestedId && ID_RE.test(requestedId) ? requestedId : randomUUID();
    const { prompt, model } = validatePromptModel(upload, { requireModel: true });
    const shareEnabled = ['1', 'true', 'on', 'yes'].includes(String(upload.fields.shareEnabled || '').toLowerCase());
    const createdAt = new Date().toISOString();
    const taskToken = randomUUID();
    const turnId = randomUUID();
    const result = await commitMutex.runExclusive(async () => {
      if (generationAtStart !== generationFor(ownerId)) throw Object.assign(new Error('提交期间执行了“删除全部”，本次问题未保存，请重新提交'), { code: 'DELETE_ALL_CONFLICT' });
      if (database.getChatInternal(id) || fs.existsSync(textBinPath(config.chatDir, id))) throw new Error('对话 ID 已存在，请重新提交');
      const manifest = await adoptPendingUpload({
        uploadDirectory: upload.directory, chatDir: config.chatDir, chatId: id, turnNumber: 1, files: upload.files,
      });
      adopted = true;
      const finalText = textBinPath(config.chatDir, id);
      await initializeTextBinAt(finalText, id, {
        createdAt, modelId: model.id, modelLabel: model.label, prompt, turnId,
        attachments: manifest.map((file) => ({ name: file.zipName, originalName: file.originalName, mimeType: file.mimeType })),
      });
      await initializeAttachmentBin(config.chatDir, id);
      const shareToken = shareEnabled ? createShareToken() : null;
      const reserved = database.reserveInitial({
        chat: {
          id, ownerId, title: normalizeTitle(prompt), promptPreview: prompt.slice(0, 240),
          modelId: model.id, modelLabel: model.label, createdAt,
          hasAttachments: upload.files.length ? 1 : 0, attachmentCount: upload.files.length,
          shareEnabled: shareToken ? 1 : 0, shareToken, archiveVersion: 2,
        },
        turn: {
          chatId: id, turnNo: 1, createdAt,
          hasAttachments: upload.files.length ? 1 : 0, attachmentCount: upload.files.length,
          attachmentBytes: 0, attachmentReady: 0, taskToken,
          pendingDir: path.join(config.chatDir, '.pending', id, '1'),
        },
      }, config.limits.maxParallelTasks);
      if (!reserved) { await deleteChatFiles(config.chatDir, id); return null; }
      workers.enqueue(id, 1, taskToken);
      return database.getOwnedConversation(id, ownerId);
    });
    if (!result) return res.status(429).json({ error: `当前已有 ${config.limits.maxParallelTasks} 个未完成任务，请稍后再提交` });
    return res.status(202).json(await conversationDto(result));
  } catch (error) {
    if (adopted && id) await deleteChatFiles(config.chatDir, id).catch(() => {});
    if (req.aborted || res.destroyed) return undefined;
    return res.status(httpErrorStatus(error)).json({ error: String(error?.message || error) });
  } finally {
    releaseSubmissionSlot();
    if (!adopted) await upload?.cleanup?.().catch(() => {});
  }
});

app.post('/api/chats/:id/turns', validateId, async (req, res) => {
  if (!requireMultipart(req, res)) return undefined;
  if (!database.getOwnedChat(req.params.id, req.user.id)) { req.resume(); return res.status(404).json({ error: '记录不存在' }); }
  if (!acquireSubmissionSlot()) { req.resume(); return res.status(429).json({ error: `当前已有 ${config.limits.maxParallelTasks} 个进行中任务或上传，请稍后再提交` }); }
  const ownerId = req.user.id;
  const generationAtStart = generationFor(ownerId);
  let upload;
  let adopted = false;
  let adoptedTurnNo = null;
  try {
    upload = await parseChatMultipart(req);
    const { prompt } = validatePromptModel(upload);
    const createdAt = new Date().toISOString();
    const taskToken = randomUUID();
    const turnId = randomUUID();
    const result = await commitMutex.runExclusive(async () => {
      if (generationAtStart !== generationFor(ownerId)) throw Object.assign(new Error('提交期间执行了“删除全部”，本次追问未保存，请重新提交'), { code: 'DELETE_ALL_CONFLICT' });
      const current = database.getOwnedConversation(req.params.id, ownerId);
      if (!current) return { error: 'not_found' };
      const nextTurnNo = (current.turns.at(-1)?.turnNo || 0) + 1;
      const manifest = await adoptPendingUpload({
        uploadDirectory: upload.directory, chatDir: config.chatDir,
        chatId: req.params.id, turnNumber: nextTurnNo, files: upload.files,
      });
      adopted = true;
      adoptedTurnNo = nextTurnNo;
      const reserved = database.reserveFollowUp(req.params.id, ownerId, {
        createdAt, hasAttachments: upload.files.length ? 1 : 0,
        attachmentCount: upload.files.length, attachmentBytes: 0, attachmentReady: 0,
        taskToken, pendingDir: path.join(config.chatDir, '.pending', req.params.id, String(nextTurnNo)),
      }, config.limits.maxParallelTasks);
      if (!reserved.ok) {
        await deleteTurnFilesFrom(config.chatDir, req.params.id, nextTurnNo);
        return { error: reserved.reason };
      }
      try {
        await appendTextEvent(config.chatDir, req.params.id, {
          type: 'turn_user', turnId, turnNumber: reserved.turnNo, text: prompt, createdAt,
          attachments: manifest.map((file) => ({ name: file.zipName, originalName: file.originalName, mimeType: file.mimeType })),
        });
      } catch (error) {
        database.removeTurn(req.params.id, reserved.turnNo, taskToken);
        await deleteTurnFilesFrom(config.chatDir, req.params.id, reserved.turnNo);
        throw error;
      }
      workers.enqueue(req.params.id, reserved.turnNo, taskToken);
      events.emit(req.params.id, { type: 'conversation_reset', fromTurnNo: reserved.turnNo });
      return { conversation: database.getOwnedConversation(req.params.id, ownerId), turnNo: reserved.turnNo };
    });
    if (result.error === 'not_found') return res.status(404).json({ error: '记录不存在' });
    if (result.error === 'chat_busy') return res.status(409).json({ error: '当前对话仍有一轮正在处理，请等待完成后再追问' });
    if (result.error === 'attachment_not_ready') return res.status(409).json({ error: '上一轮附件尚未成功压缩，不能继续追问；请编辑该轮重试或删除对话' });
    if (result.error === 'limit') return res.status(429).json({ error: `当前已有 ${config.limits.maxParallelTasks} 个未完成任务，请稍后再提交` });
    return res.status(202).json(await conversationDto(result.conversation));
  } catch (error) {
    if (adopted && adoptedTurnNo) await deleteTurnFilesFrom(config.chatDir, req.params.id, adoptedTurnNo).catch(() => {});
    if (req.aborted || res.destroyed) return undefined;
    return res.status(httpErrorStatus(error)).json({ error: String(error?.message || error) });
  } finally {
    releaseSubmissionSlot();
    if (!adopted) await upload?.cleanup?.().catch(() => {});
  }
});

app.put('/api/chats/:id/turns/:turnNo', validateId, validateTurnNo, async (req, res, next) => {
  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
  if (!prompt) return res.status(400).json({ error: '问题不能为空' });
  if (prompt.length > config.limits.maxPromptChars) return res.status(400).json({ error: '问题文字过长' });
  const ownerId = req.user.id;
  try {
    const result = await commitMutex.runExclusive(async () => {
      const before = database.getOwnedConversation(req.params.id, ownerId);
      if (!before) return { error: 'not_found' };
      const selectedMeta = before.turns.find((turn) => turn.turnNo === req.turnNo);
      if (!selectedMeta) return { error: 'turn_not_found' };

      const restartTasks = before.turns
        .filter((turn) => turn.turnNo >= req.turnNo && ['queued', 'preparing', 'running'].includes(turn.status))
        .map((turn) => ({ chatId: req.params.id, turnNo: turn.turnNo, taskToken: turn.taskToken }));
      await workers.cancelFrom(req.params.id, req.turnNo, 'edited');

      const textPath = textBinPath(config.chatDir, req.params.id);
      const archivePath = attachmentBinPath(config.chatDir, req.params.id);
      const backupDirectory = path.join(config.chatDir, '.work', `${req.params.id}-edit-backup-${randomUUID()}`);
      const textBackup = path.join(backupDirectory, 'conversation.text.bin');
      const archiveBackup = path.join(backupDirectory, 'conversation.attachments.bin');
      await fsp.mkdir(backupDirectory, { recursive: true, mode: 0o700 });
      await fsp.copyFile(textPath, textBackup);
      let hadArchive = false;
      try {
        await fsp.copyFile(archivePath, archiveBackup);
        hadArchive = true;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }

      const restoreFiles = async () => {
        const restoredText = `${textPath}.restore-${process.pid}-${randomUUID()}`;
        await fsp.copyFile(textBackup, restoredText);
        await fsp.rename(restoredText, textPath);
        if (hadArchive) {
          const restoredArchive = `${archivePath}.restore-${process.pid}-${randomUUID()}`;
          await fsp.copyFile(archiveBackup, restoredArchive);
          await fsp.rename(restoredArchive, archivePath);
        } else {
          await fsp.rm(archivePath, { force: true });
        }
      };
      const restartCancelledTasks = () => {
        for (const task of restartTasks) workers.enqueue(task.chatId, task.turnNo, task.taskToken);
      };

      try {
        const text = await readConversation(config.chatDir, req.params.id);
        const textByNo = new Map(text.turns.map((turn) => [turn.turnNumber, turn]));
        const selectedText = textByNo.get(req.turnNo);
        if (!selectedText) throw new Error('找不到要编辑的问题文字');

        const compactTurns = before.turns.filter((turn) => turn.turnNo < req.turnNo).map((turn) => {
          const content = textByNo.get(turn.turnNo) || {};
          return {
            turnId: content.turnId || randomUUID(),
            turnNumber: turn.turnNo,
            prompt: content.prompt || '',
            answer: turn.status === 'failed' ? '' : (content.answer || ''),
            error: turn.status === 'failed' ? (turn.error || content.error || '模型调用失败') : null,
            attachments: content.attachments || [],
            createdAt: turn.createdAt,
            completedAt: turn.completedAt,
            latestAttemptId: content.latestAttemptId,
          };
        });
        compactTurns.push({
          turnId: selectedText.turnId || randomUUID(),
          turnNumber: req.turnNo,
          prompt,
          answer: '',
          error: null,
          attachments: selectedText.attachments || [],
          createdAt: selectedMeta.createdAt,
          latestAttemptId: null,
        });

        // Build the replacement text and the truncated attachment archive before
        // committing the SQLite edit. Both files can be restored from backups if
        // any pre-commit step fails.
        await rewriteConversationText(config.chatDir, req.params.id, { meta: text.meta, turns: compactTurns });
        await truncateConversationArchive({
          chatDir: config.chatDir,
          chatId: req.params.id,
          throughTurn: req.turnNo,
          archiveVersion: before.chat.archiveVersion,
          maxBytes: config.limits.maxCompressedAttachmentBytes,
        });

        const taskToken = randomUUID();
        const edited = database.editTurn(req.params.id, ownerId, req.turnNo, {
          createdAt: selectedMeta.createdAt,
          taskToken,
          title: normalizeTitle(prompt),
          promptPreview: prompt.slice(0, 240),
        }, config.limits.maxParallelTasks);
        if (!edited.ok) {
          await restoreFiles();
          restartCancelledTasks();
          return { error: edited.reason };
        }

        // The authoritative outer ZIP has already been truncated. Remove raw
        // pending directories and prerelease per-turn files for deleted rounds.
        await deleteTurnFilesFrom(config.chatDir, req.params.id, req.turnNo + 1).catch((cleanupError) => {
          console.error(`[edit:${req.params.id}:${req.turnNo}] failed to remove obsolete turn artifacts`, cleanupError);
        });
        workers.enqueue(req.params.id, req.turnNo, taskToken);
        events.emit(req.params.id, { type: 'conversation_reset', fromTurnNo: req.turnNo });
        return { conversation: database.getOwnedConversation(req.params.id, ownerId) };
      } catch (error) {
        await restoreFiles().catch((restoreError) => {
          console.error(`[edit:${req.params.id}:${req.turnNo}] rollback failed`, restoreError);
        });
        restartCancelledTasks();
        throw error;
      } finally {
        await fsp.rm(backupDirectory, { recursive: true, force: true }).catch(() => {});
      }
    });
    if (result.error === 'not_found') return res.status(404).json({ error: '记录不存在' });
    if (result.error === 'turn_not_found') return res.status(404).json({ error: '轮次不存在' });
    if (result.error === 'limit') return res.status(429).json({ error: `当前已有 ${config.limits.maxParallelTasks} 个未完成任务，请稍后再编辑` });
    return res.status(202).json(await conversationDto(result.conversation));
  } catch (error) { return next(error); }
});

app.delete('/api/chats/:id', validateId, async (req, res, next) => {
  try {
    const deleted = await commitMutex.runExclusive(async () => {
      if (!database.getOwnedChat(req.params.id, req.user.id)) return false;
      await workers.cancel(req.params.id);
      if (!database.deleteOwnedChat(req.params.id, req.user.id)) return false;
      await deleteChatFiles(config.chatDir, req.params.id);
      events.emit(req.params.id, { type: 'deleted' });
      return true;
    });
    if (!deleted) return res.status(404).json({ error: '记录不存在' });
    return res.status(204).end();
  } catch (error) { return next(error); }
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
  } catch (error) { return next(error); }
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'API 路径不存在' }));
if (fs.existsSync(config.distDir)) {
  app.use(express.static(config.distDir, { index: false, maxAge: '1h', etag: true }));
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
  if (error?.type === 'entity.parse.failed') return res.status(400).json({ error: '请求 JSON 格式无效' });
  if (error?.type === 'entity.too.large') return res.status(413).json({ error: '请求体过大' });
  return res.status(500).json({ error: '服务器内部错误' });
});

const server = app.listen(config.listen.port, config.listen.host, () => {
  console.log(`HTTP server listening on http://${config.listen.host}:${config.listen.port}`);
  console.log(`Model provider: ${new URL(config.provider.url).protocol}//${new URL(config.provider.url).host}`);
  console.log(`Data directory: ${config.chatDir}`);
  console.log('Automatic cleanup: every 10 minutes; 7-day retention; delete conversations older than 24 hours when chat storage exceeds 3,000,000,000 bytes.');
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
