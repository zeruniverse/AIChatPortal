import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReadStream } from 'node:fs';
import { loadConfig } from './config.js';
import { createStorage } from './storage.js';
import { createDb } from './db.js';
import { createAuth } from './auth.js';
import { createWorker } from './worker.js';
import { migrateLegacyStorage } from './migration.js';
import { contentDisposition, ensureDir, isTerminal, json, now, pathSize, randomId, randomToken, readJson, removePath, safeFilename, text, titleFromQuestion } from './utils.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = loadConfig(rootDir);
const storage = createStorage(rootDir);
await storage.init();
const db = createDb(storage.dbPath, { defaultOwnerId: config.auth.legacyOwnerId || config.auth.users[0].id, defaultModelId: config.models[0].id, validModelIds: new Set(config.models.map((model) => model.id)) });
await migrateLegacyStorage({ db, storage, config });
const auth = createAuth(config);
const modelIds = new Set(config.models.map((model) => model.id));
const sseClients = new Map();

const conversationLockTails = new Map();
async function withConversationLock(conversationId, fn) {
  const previous = conversationLockTails.get(conversationId) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  conversationLockTails.set(conversationId, tail);
  await previous;
  try { return await fn(); }
  finally {
    release();
    if (conversationLockTails.get(conversationId) === tail) conversationLockTails.delete(conversationId);
  }
}

function setSecurityHeaders(res) {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: http: https:; media-src 'self' data: blob: http: https:; connect-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.removeHeader('Cross-Origin-Opener-Policy');
  res.removeHeader('Cross-Origin-Embedder-Policy');
  res.removeHeader('Origin-Agent-Cluster');
  res.removeHeader('Strict-Transport-Security');
}

function emitUpdate(conversationId) {
  const clients = sseClients.get(conversationId);
  if (!clients) return;
  const conversation = db.getConversation(conversationId);
  for (const client of [...clients]) {
    if (!conversation || (client.public && (!conversation.share_enabled || conversation.share_token !== client.token))) {
      client.res.write('event: unavailable\ndata: {}\n\n');
      client.res.end();
      clients.delete(client);
    } else {
      client.res.write(`event: update\ndata: {"at":${Date.now()}}\n\n`);
    }
  }
  if (!clients.size) sseClients.delete(conversationId);
}

const worker = createWorker({ config, db, storage, emitUpdate });

function userOr401(req, res) {
  const user = auth.currentUser(req);
  if (!user) json(res, 401, { error: '请先登录' });
  return user;
}

function requireModel(modelId) {
  if (!modelIds.has(modelId)) {
    const error = new Error('模型不存在');
    error.statusCode = 400;
    throw error;
  }
}

function uniqueStoredNameFromList(existingNames, originalName) {
  const existing = new Set(existingNames);
  const safe = safeFilename(originalName);
  if (!existing.has(safe)) return safe;
  const ext = path.extname(safe);
  const base = path.basename(safe, ext);
  let n = 2;
  while (existing.has(`${base} (${n})${ext}`)) n += 1;
  return `${base} (${n})${ext}`;
}

function validateUploadForSubmit(uploadId, ownerId) {
  if (!uploadId) return { hasAttachments: 0, upload: null };
  const upload = db.getOwnedUpload(uploadId, ownerId);
  if (!upload || upload.status !== 'open') {
    const error = new Error('附件上传会话不存在或已提交'); error.statusCode = 400; throw error;
  }
  const files = db.listUploadFiles(uploadId);
  if (!files.length) return { hasAttachments: 0, upload };
  if (files.some((file) => file.status !== 'complete' || file.received_size !== file.size)) {
    const error = new Error('必须等待所有附件上传完成后再提交'); error.statusCode = 409; throw error;
  }
  return { hasAttachments: 1, upload };
}

function bindUploadInTransaction(uploadId, ownerId, conversationId, turnNo) {
  const upload = db.getOwnedUpload(uploadId, ownerId);
  if (!upload || upload.status !== 'open') { const error = new Error('附件上传会话已被使用或删除'); error.statusCode = 409; throw error; }
  const files = db.listUploadFiles(uploadId);
  if (!files.length || files.some((file) => file.status !== 'complete' || file.received_size !== file.size)) { const error = new Error('附件上传状态已变化，请重新选择附件'); error.statusCode = 409; throw error; }
  const result = db.raw.prepare("UPDATE uploads SET status='bound',conversation_id=?,turn_no=?,updated_at=? WHERE id=? AND owner_id=? AND status='open'").run(conversationId, turnNo, now(), uploadId, ownerId);
  if (result.changes !== 1) { const error = new Error('附件上传会话已被使用'); error.statusCode = 409; throw error; }
}

async function snapshot(conversation) {
  const turns = db.listTurns(conversation.id);
  const textData = await storage.readText(conversation.id);
  const textMap = new Map((textData?.turns || []).map((item) => [item.turnNo, item]));
  return {
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.created_at,
    updatedAt: conversation.updated_at,
    shareEnabled: Boolean(conversation.share_enabled),
    shareToken: conversation.share_enabled ? conversation.share_token : null,
    turns: turns.map((turn) => {
      const content = textMap.get(turn.turn_no) || {};
      return {
        turnNo: turn.turn_no,
        question: content.question || '',
        answer: content.answer || '',
        modelId: turn.model_id,
        status: turn.status,
        hasAttachments: Boolean(turn.has_attachments),
        attachmentReady: Boolean(turn.attachment_ready),
        attachmentSize: turn.attachment_size,
        createdAt: turn.created_at,
        updatedAt: turn.updated_at
      };
    })
  };
}

async function deleteConversationFully(conversationId) {
  return withConversationLock(conversationId, async () => {
    await worker.cancelConversation(conversationId, 1);
    const turns = db.listTurns(conversationId);
    const uploadIds = turns.map((turn) => turn.upload_id).filter(Boolean);
    db.transaction(() => db.deleteConversation(conversationId));
    await Promise.all(uploadIds.map((id) => removePath(storage.uploadPath(id))));
    for (const id of uploadIds) db.deleteUpload(id);
    await storage.deleteConversationFiles(conversationId);
    emitUpdate(conversationId);
  });
}

function addSse(req, res, conversation, isPublic = false, token = null) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('event: ready\ndata: {}\n\n');
  const client = { res, public: isPublic, token };
  if (!sseClients.has(conversation.id)) sseClients.set(conversation.id, new Set());
  sseClients.get(conversation.id).add(client);
  const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15_000);
  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.get(conversation.id)?.delete(client);
  });
}

async function streamDownload(res, filePath, filename) {
  let stat;
  try { stat = await fs.promises.stat(filePath); }
  catch { return json(res, 404, { error: '附件包不存在' }); }
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Length': stat.size,
    'Content-Disposition': contentDisposition(filename),
    'Cache-Control': 'private, no-store'
  });
  createReadStream(filePath).pipe(res);
}

async function handleApi(req, res, url) {
  const pathname = url.pathname;
  if (req.method === 'GET' && pathname === '/api/health') return json(res, 200, { ok: true, version: '6.0.2' });
  if (req.method === 'GET' && pathname === '/api/config') return json(res, 200, { models: config.models, limits: { maxFilesPerTurn: config.limits.maxFilesPerTurn, maxCompressedAttachmentBytes: config.limits.maxCompressedAttachmentBytes } });
  if (req.method === 'GET' && pathname === '/api/auth/me') {
    const user = auth.currentUser(req);
    return json(res, 200, { authenticated: Boolean(user), user: user ? { id: user.id, label: user.label || user.id } : null });
  }
  if (req.method === 'POST' && pathname === '/api/auth/login') {
    const body = await readJson(req);
    const user = auth.findByToken(body.token);
    if (!user) return json(res, 401, { error: 'token 无效' });
    return json(res, 200, { authenticated: true, user: { id: user.id, label: user.label || user.id } }, { 'Set-Cookie': auth.cookie(auth.encodeSession(user)) });
  }
  if (req.method === 'POST' && pathname === '/api/auth/logout') return json(res, 200, { ok: true }, { 'Set-Cookie': auth.cookie('', true) });

  let match;
  if (req.method === 'POST' && pathname === '/api/uploads') {
    const user = userOr401(req, res); if (!user) return;
    const id = randomId();
    db.createUpload(id, user.id, now());
    await ensureDir(path.join(storage.uploadPath(id), 'files'));
    return json(res, 201, { id });
  }
  if (req.method === 'GET' && (match = pathname.match(/^\/api\/uploads\/([^/]+)$/))) {
    const user = userOr401(req, res); if (!user) return;
    const upload = db.getOwnedUpload(match[1], user.id);
    if (!upload) return json(res, 404, { error: '上传会话不存在' });
    const files = db.listUploadFiles(upload.id).map((f) => ({ id: f.id, name: f.original_name, size: f.size, receivedSize: f.received_size, type: f.mime, status: f.status }));
    return json(res, 200, { id: upload.id, status: upload.status, files });
  }
  if (req.method === 'POST' && (match = pathname.match(/^\/api\/uploads\/([^/]+)\/files$/))) {
    const user = userOr401(req, res); if (!user) return;
    const upload = db.getOwnedUpload(match[1], user.id);
    if (!upload || upload.status !== 'open') return json(res, 404, { error: '上传会话不存在或已提交' });
    const body = await readJson(req);
    const size = Number(body.size);
    if (!body.name || !Number.isSafeInteger(size) || size < 0) return json(res, 400, { error: '文件信息无效' });
    const fileId = randomId();
    const stamp = now();
    const storedName = db.transaction(() => {
      const freshUpload = db.getOwnedUpload(upload.id, user.id);
      if (!freshUpload || freshUpload.status !== 'open') { const error = new Error('上传会话不存在或已提交'); error.statusCode = 404; throw error; }
      const files = db.listUploadFiles(upload.id);
      if (files.length >= config.limits.maxFilesPerTurn) { const error = new Error(`每轮最多 ${config.limits.maxFilesPerTurn} 个文件`); error.statusCode = 413; throw error; }
      if (config.limits.maxRawUploadBytesPerTurn > 0 && freshUpload.total_raw_size + size > config.limits.maxRawUploadBytesPerTurn) { const error = new Error('本轮附件原始总大小超过服务器限制'); error.statusCode = 413; throw error; }
      const name = uniqueStoredNameFromList(files.map((item) => item.stored_name), body.name);
      db.raw.prepare('INSERT INTO upload_files(id,upload_id,original_name,stored_name,size,mime,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(fileId, upload.id, String(body.name), name, size, String(body.type || ''), 'pending', stamp, stamp);
      db.raw.prepare('UPDATE uploads SET total_raw_size=total_raw_size+?, updated_at=? WHERE id=?').run(size, stamp, upload.id);
      return name;
    });
    return json(res, 201, { id: fileId, name: body.name, storedName, size, type: body.type || '' });
  }
  if (req.method === 'PUT' && (match = pathname.match(/^\/api\/uploads\/([^/]+)\/files\/([^/]+)$/))) {
    const user = userOr401(req, res); if (!user) { req.resume(); return; }
    const upload = db.getOwnedUpload(match[1], user.id);
    const file = db.raw.prepare('SELECT * FROM upload_files WHERE id=? AND upload_id=?').get(match[2], match[1]);
    if (!upload || upload.status !== 'open' || !file) { req.resume(); return json(res, 404, { error: '上传目标不存在' }); }
    if (!['pending','failed'].includes(file.status)) { req.resume(); return json(res, 409, { error: '文件已上传或正在上传' }); }
    const dir = path.join(storage.uploadPath(upload.id), 'files');
    await ensureDir(dir);
    const finalPath = path.join(dir, file.stored_name);
    const partPath = `${finalPath}.part`;
    db.raw.prepare("UPDATE upload_files SET status='uploading',received_size=0,updated_at=? WHERE id=?").run(now(), file.id);
    let received = 0;
    const output = fs.createWriteStream(partPath, { flags: 'w', mode: 0o600 });
    try {
      for await (const chunk of req) {
        received += chunk.length;
        if (received > file.size) throw Object.assign(new Error('上传字节数超过声明大小'), { statusCode: 400 });
        if (!output.write(chunk)) await new Promise((resolve) => output.once('drain', resolve));
      }
      await new Promise((resolve, reject) => output.end((error) => error ? reject(error) : resolve()));
      if (received !== file.size) throw Object.assign(new Error('附件上传不完整'), { statusCode: 400 });
      await fs.promises.rename(partPath, finalPath);
      db.raw.prepare("UPDATE upload_files SET status='complete',received_size=?,updated_at=? WHERE id=?").run(received, now(), file.id);
      db.raw.prepare('UPDATE uploads SET updated_at=? WHERE id=?').run(now(), upload.id);
      return json(res, 200, { ok: true, receivedSize: received });
    } catch (error) {
      output.destroy();
      await removePath(partPath);
      db.raw.prepare("UPDATE upload_files SET status='failed',received_size=?,updated_at=? WHERE id=?").run(received, now(), file.id);
      throw error;
    }
  }
  if (req.method === 'DELETE' && (match = pathname.match(/^\/api\/uploads\/([^/]+)\/files\/([^/]+)$/))) {
    const user = userOr401(req, res); if (!user) return;
    const upload = db.getOwnedUpload(match[1], user.id);
    const file = db.raw.prepare('SELECT * FROM upload_files WHERE id=? AND upload_id=?').get(match[2], match[1]);
    if (!upload || upload.status !== 'open' || !file) return json(res, 404, { error: '文件不存在' });
    await Promise.all([removePath(path.join(storage.uploadPath(upload.id), 'files', file.stored_name)), removePath(path.join(storage.uploadPath(upload.id), 'files', `${file.stored_name}.part`))]);
    db.transaction(() => {
      db.raw.prepare('DELETE FROM upload_files WHERE id=?').run(file.id);
      db.raw.prepare('UPDATE uploads SET total_raw_size=MAX(0,total_raw_size-?),updated_at=? WHERE id=?').run(file.size, now(), upload.id);
    });
    return json(res, 200, { ok: true });
  }
  if (req.method === 'DELETE' && (match = pathname.match(/^\/api\/uploads\/([^/]+)$/))) {
    const user = userOr401(req, res); if (!user) return;
    const upload = db.getOwnedUpload(match[1], user.id);
    if (!upload || upload.status !== 'open') return json(res, 404, { error: '上传会话不存在' });
    await removePath(storage.uploadPath(upload.id));
    db.deleteUpload(upload.id);
    return json(res, 200, { ok: true });
  }

  if (req.method === 'GET' && pathname === '/api/conversations') {
    const user = userOr401(req, res); if (!user) return;
    return json(res, 200, { conversations: db.listConversations(user.id).map((c) => ({ id: c.id, title: c.title, createdAt: c.created_at, updatedAt: c.updated_at, turnCount: c.turn_count, latestStatus: c.latest_status, shareEnabled: Boolean(c.share_enabled) })) });
  }
  if (req.method === 'POST' && pathname === '/api/conversations') {
    const user = userOr401(req, res); if (!user) return;
    const body = await readJson(req);
    const question = String(body.question || '').trim();
    if (!question) return json(res, 400, { error: '问题不能为空' });
    requireModel(body.modelId);
    const uploadInfo = validateUploadForSubmit(body.uploadId, user.id);
    const id = randomId(); const stamp = now(); const share = Boolean(body.shareEnabled); const shareToken = share ? randomToken(32) : null;
    db.transaction(() => {
      if (db.activeCount() >= config.limits.maxConcurrentTasks) { const error = new Error(`系统已有 ${config.limits.maxConcurrentTasks} 个任务正在等待或生成，请稍后再试`); error.statusCode = 429; throw error; }
      db.raw.prepare('INSERT INTO conversations(id,owner_id,title,share_enabled,share_token,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(id, user.id, titleFromQuestion(question), share ? 1 : 0, shareToken, stamp, stamp);
      db.raw.prepare('INSERT INTO turns(conversation_id,turn_no,model_id,status,has_attachments,upload_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(id, 1, body.modelId, 'pending', uploadInfo.hasAttachments, uploadInfo.hasAttachments ? body.uploadId : null, stamp, stamp);
      if (uploadInfo.hasAttachments) bindUploadInTransaction(body.uploadId, user.id, id, 1);
    });
    try { await storage.writeText(id, { version: 2, conversationId: id, turns: [{ turnNo: 1, question, answer: '', createdAt: stamp, updatedAt: stamp }] }); }
    catch (error) {
      db.transaction(() => {
        db.deleteConversation(id);
        if (uploadInfo.hasAttachments) db.raw.prepare("UPDATE uploads SET status='open',conversation_id=NULL,turn_no=NULL,updated_at=? WHERE id=?").run(now(), body.uploadId);
      });
      throw error;
    }
    worker.pump();
    return json(res, 201, { id, url: `/chat/${id}` });
  }
  if (req.method === 'GET' && (match = pathname.match(/^\/api\/conversations\/([^/]+)$/))) {
    const user = userOr401(req, res); if (!user) return;
    const conversation = db.getOwnedConversation(match[1], user.id);
    if (!conversation) return json(res, 404, { error: '对话不存在' });
    return json(res, 200, await snapshot(conversation));
  }
  if (req.method === 'POST' && (match = pathname.match(/^\/api\/conversations\/([^/]+)\/turns$/))) {
    const user = userOr401(req, res); if (!user) return;
    const body = await readJson(req); const question = String(body.question || '').trim();
    if (!question) return json(res, 400, { error: '追问不能为空' });
    requireModel(body.modelId);
    return withConversationLock(match[1], async () => {
      const conversation = db.getOwnedConversation(match[1], user.id);
      if (!conversation) return json(res, 404, { error: '对话不存在' });
      const uploadInfo = validateUploadForSubmit(body.uploadId, user.id);
      const last = db.getLastTurn(conversation.id);
      if (!last || !isTerminal(last.status)) return json(res, 409, { error: '上一轮尚未完成，暂时不能追问' });
      const turnNo = last.turn_no + 1; const stamp = now();
      const oldText = await storage.readText(conversation.id);
      const newText = JSON.parse(JSON.stringify(oldText));
      newText.turns.push({ turnNo, question, answer: '', createdAt: stamp, updatedAt: stamp });
      await storage.writeText(conversation.id, newText);
      try {
        db.transaction(() => {
          const freshLast = db.getLastTurn(conversation.id);
          if (!freshLast || freshLast.turn_no !== last.turn_no || !isTerminal(freshLast.status)) { const error = new Error('对话状态已变化，请刷新后重试'); error.statusCode = 409; throw error; }
          if (db.activeCount() >= config.limits.maxConcurrentTasks) { const error = new Error(`系统已有 ${config.limits.maxConcurrentTasks} 个任务正在等待或生成，请稍后再试`); error.statusCode = 429; throw error; }
          db.raw.prepare('INSERT INTO turns(conversation_id,turn_no,model_id,status,has_attachments,upload_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(conversation.id, turnNo, body.modelId, 'pending', uploadInfo.hasAttachments, uploadInfo.hasAttachments ? body.uploadId : null, stamp, stamp);
          db.raw.prepare('UPDATE conversations SET updated_at=? WHERE id=?').run(stamp, conversation.id);
          if (uploadInfo.hasAttachments) bindUploadInTransaction(body.uploadId, user.id, conversation.id, turnNo);
        });
      } catch (error) { await storage.writeText(conversation.id, oldText); throw error; }
      emitUpdate(conversation.id); worker.pump();
      return json(res, 201, { turnNo });
    });
  }
  if (req.method === 'PATCH' && (match = pathname.match(/^\/api\/conversations\/([^/]+)\/turns\/(\d+)$/))) {
    const user = userOr401(req, res); if (!user) return;
    const turnNo = Number(match[2]);
    const body = await readJson(req); const question = String(body.question || '').trim();
    if (!question) return json(res, 400, { error: '问题不能为空' });
    requireModel(body.modelId);
    return withConversationLock(match[1], async () => {
      const conversation = db.getOwnedConversation(match[1], user.id);
      if (!conversation) return json(res, 404, { error: '对话不存在' });
      const current = db.getTurn(conversation.id, turnNo);
      if (!current) return json(res, 404, { error: '轮次不存在' });
      await worker.cancelConversation(conversation.id, turnNo);
      const removedTurns = db.listTurns(conversation.id).filter((turn) => turn.turn_no > turnNo);
      const oldText = await storage.readText(conversation.id);
      const newText = JSON.parse(JSON.stringify(oldText));
      newText.turns = newText.turns.filter((turn) => turn.turnNo <= turnNo).map((turn) => turn.turnNo === turnNo ? { ...turn, question, answer: '', updatedAt: now() } : turn);
      await storage.writeText(conversation.id, newText);
      try {
        db.transaction(() => {
          const activeTotal = db.activeCount();
          const activeRemoved = db.raw.prepare("SELECT COUNT(*) AS count FROM turns WHERE conversation_id=? AND turn_no>=? AND status IN ('pending','compressing','generating')").get(conversation.id, turnNo).count;
          if (activeTotal - activeRemoved >= config.limits.maxConcurrentTasks) { const error = new Error('系统任务已满，暂时无法重新提交编辑'); error.statusCode = 429; throw error; }
          db.raw.prepare('DELETE FROM turns WHERE conversation_id=? AND turn_no>?').run(conversation.id, turnNo);
          db.raw.prepare("UPDATE turns SET model_id=?,status='pending',attempt=attempt+1,updated_at=? WHERE conversation_id=? AND turn_no=?").run(body.modelId, now(), conversation.id, turnNo);
          db.raw.prepare('UPDATE conversations SET title=CASE WHEN ?=1 THEN ? ELSE title END,updated_at=? WHERE id=?').run(turnNo, titleFromQuestion(question), now(), conversation.id);
        });
      } catch (error) { await storage.writeText(conversation.id, oldText); throw error; }
      for (const turn of removedTurns) {
        if (turn.upload_id) { await removePath(storage.uploadPath(turn.upload_id)); db.deleteUpload(turn.upload_id); }
        await removePath(storage.attachmentPath(conversation.id, turn.turn_no));
      }
      const workEntries = await fs.promises.readdir(storage.workDir).catch(() => []);
      await Promise.all(workEntries.filter((name) => name.startsWith(`${conversation.id}-`) && Number(name.split('-').at(-2)) > turnNo).map((name) => removePath(path.join(storage.workDir, name))));
      emitUpdate(conversation.id); worker.pump();
      return json(res, 200, { ok: true });
    });
  }
  if (req.method === 'POST' && (match = pathname.match(/^\/api\/conversations\/([^/]+)\/share$/))) {
    const user = userOr401(req, res); if (!user) return;
    const body = await readJson(req); const enabled = Boolean(body.enabled);
    return withConversationLock(match[1], async () => {
      const conversation = db.getOwnedConversation(match[1], user.id);
      if (!conversation) return json(res, 404, { error: '对话不存在' });
      const token = enabled ? randomToken(32) : null;
      db.raw.prepare('UPDATE conversations SET share_enabled=?,share_token=?,updated_at=? WHERE id=?').run(enabled ? 1 : 0, token, now(), conversation.id);
      emitUpdate(conversation.id);
      return json(res, 200, { shareEnabled: enabled, shareToken: token });
    });
  }
  if (req.method === 'GET' && (match = pathname.match(/^\/api\/conversations\/([^/]+)\/events$/))) {
    const user = userOr401(req, res); if (!user) return;
    const conversation = db.getOwnedConversation(match[1], user.id);
    if (!conversation) return json(res, 404, { error: '对话不存在' });
    return addSse(req, res, conversation, false, null);
  }
  if (req.method === 'GET' && (match = pathname.match(/^\/api\/conversations\/([^/]+)\/turns\/(\d+)\/attachments$/))) {
    const user = userOr401(req, res); if (!user) return;
    const conversation = db.getOwnedConversation(match[1], user.id); const turnNo = Number(match[2]);
    if (!conversation) return json(res, 404, { error: '对话不存在' });
    const turn = db.getTurn(conversation.id, turnNo);
    if (!turn?.has_attachments) return json(res, 404, { error: '本轮没有附件' });
    if (!turn.attachment_ready) return json(res, 409, { error: '本轮附件仍在压缩，暂不可下载' });
    return streamDownload(res, storage.attachmentPath(conversation.id, turnNo), `conversation-${conversation.id}-turn-${turnNo}-attachments.zip`);
  }
  if (req.method === 'DELETE' && pathname === '/api/conversations') {
    const user = userOr401(req, res); if (!user) return;
    const conversations = db.listConversations(user.id);
    for (const conversation of conversations) await deleteConversationFully(conversation.id);
    return json(res, 200, { deleted: conversations.length });
  }
  if (req.method === 'DELETE' && (match = pathname.match(/^\/api\/conversations\/([^/]+)$/))) {
    const user = userOr401(req, res); if (!user) return;
    const conversation = db.getOwnedConversation(match[1], user.id);
    if (!conversation) return json(res, 404, { error: '对话不存在' });
    await deleteConversationFully(conversation.id);
    return json(res, 200, { ok: true });
  }

  if (req.method === 'GET' && (match = pathname.match(/^\/api\/public\/shares\/([^/]+)$/))) {
    const conversation = db.getSharedConversation(match[1]);
    if (!conversation) return json(res, 404, { error: '分享链接不存在或已关闭' });
    const data = await snapshot(conversation); delete data.shareToken; delete data.id;
    return json(res, 200, data);
  }
  if (req.method === 'GET' && (match = pathname.match(/^\/api\/public\/shares\/([^/]+)\/events$/))) {
    const conversation = db.getSharedConversation(match[1]);
    if (!conversation) return json(res, 404, { error: '分享链接不存在或已关闭' });
    return addSse(req, res, conversation, true, match[1]);
  }
  if (req.method === 'GET' && (match = pathname.match(/^\/api\/public\/shares\/([^/]+)\/turns\/(\d+)\/attachments$/))) {
    const conversation = db.getSharedConversation(match[1]); const turnNo = Number(match[2]);
    if (!conversation) return json(res, 404, { error: '分享链接不存在或已关闭' });
    const turn = db.getTurn(conversation.id, turnNo);
    if (!turn?.has_attachments) return json(res, 404, { error: '本轮没有附件' });
    if (!turn.attachment_ready) return json(res, 409, { error: '本轮附件仍在压缩，暂不可下载' });
    return streamDownload(res, storage.attachmentPath(conversation.id, turnNo), `shared-turn-${turnNo}-attachments.zip`);
  }
  return json(res, 404, { error: '接口不存在' });
}

const mimeTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon' };
async function serveStatic(res, pathname, headOnly = false) {
  const dist = path.join(rootDir, 'dist');
  let relative = decodeURIComponent(pathname).replace(/^\/+/, '');
  let target = path.join(dist, relative || 'index.html');
  const relativeTarget = path.relative(dist, target);
  if (relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget)) return text(res, 403, 'Forbidden');
  let stat;
  try { stat = await fs.promises.stat(target); if (stat.isDirectory()) target = path.join(target, 'index.html'); }
  catch { target = path.join(dist, 'index.html'); }
  try { stat = await fs.promises.stat(target); }
  catch { return text(res, 503, '前端尚未构建，请先运行 npm run build。'); }
  res.writeHead(200, { 'Content-Type': mimeTypes[path.extname(target)] || 'application/octet-stream', 'Content-Length': stat.size, 'Cache-Control': path.basename(target) === 'index.html' ? 'no-cache' : 'public, max-age=31536000, immutable' });
  if (headOnly) res.end(); else createReadStream(target).pipe(res);
}

const server = http.createServer(async (req, res) => {
  setSecurityHeaders(res);
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else if (req.method === 'GET' || req.method === 'HEAD') await serveStatic(res, url.pathname, req.method === 'HEAD');
    else json(res, 405, { error: 'Method Not Allowed' });
  } catch (error) {
    console.error(error);
    if (!res.headersSent) json(res, error.statusCode || 500, { error: error.statusCode ? error.message : '服务器内部错误' });
    else res.destroy();
  }
});
server.requestTimeout = 0;
server.timeout = 0;
server.headersTimeout = 60_000;
server.keepAliveTimeout = 75_000;

let cleanupRunning = false;
async function runCleanup() {
  if (cleanupRunning) return;
  cleanupRunning = true;
  try {
    const stamp = now();
    const orphanCutoff = stamp - config.cleanup.orphanUploadHours * 3600_000;
    const orphans = db.raw.prepare("SELECT id FROM uploads WHERE status='open' AND updated_at<?").all(orphanCutoff);
    for (const upload of orphans) { await removePath(storage.uploadPath(upload.id)); db.deleteUpload(upload.id); }

    let deleted = 0;
    const sevenDayCutoff = stamp - config.cleanup.maxAgeDays * 86400_000;
    while (true) {
      const expired = db.raw.prepare('SELECT id FROM conversations WHERE created_at<? ORDER BY created_at LIMIT 500').all(sevenDayCutoff);
      if (!expired.length) break;
      for (const conversation of expired) { await deleteConversationFully(conversation.id); deleted += 1; }
    }

    const total = await pathSize(storage.chatDir);
    if (total > config.cleanup.maxChatBytes) {
      const pressureCutoff = stamp - config.cleanup.pressureAgeHours * 3600_000;
      while (true) {
        const old = db.raw.prepare('SELECT id FROM conversations WHERE created_at<? ORDER BY created_at LIMIT 500').all(pressureCutoff);
        if (!old.length) break;
        for (const conversation of old) { await deleteConversationFully(conversation.id); deleted += 1; }
      }
    }
    if (deleted) db.raw.exec('VACUUM; PRAGMA wal_checkpoint(TRUNCATE);');
  } catch (error) { console.error('cleanup failed', error); }
  finally { cleanupRunning = false; }
}

server.listen(config.port, config.host, () => {
  console.log(`Chat app listening on http://${config.host}:${config.port}`);
  worker.pump();
  runCleanup();
});
setInterval(runCleanup, config.cleanup.intervalMinutes * 60_000).unref();

for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => server.close(() => { db.close(); process.exit(0); }));
