import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { callProvider } from './provider.js';
import { visibleAnswer } from './answer.js';
import { ensureDir, now, redactSecrets, removePath } from './utils.js';

function runCommand(command, args, { cwd, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    const abort = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', reject);
    child.on('close', (code, sig) => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
      if (code === 0) resolve();
      else reject(new Error(`${command} 失败（${sig || code}）：${stderr.trim()}`));
    });
  });
}

function turnText(textData, turnNo) {
  return textData.turns.find((turn) => turn.turnNo === turnNo);
}

function buildPrompt(textData, turnNo) {
  const current = turnText(textData, turnNo);
  if (turnNo === 1) return current.question;
  const history = [];
  for (const turn of textData.turns.filter((item) => item.turnNo < turnNo).sort((a, b) => a.turnNo - b.turnNo)) {
    history.push(`第${numberName(turn.turnNo)}次提问：\n${turn.question}`);
    history.push(`第${numberName(turn.turnNo)}次回答：\n${visibleAnswer(turn.answer || '') || turn.answer || ''}`);
  }
  return `这是一次用户的追问，内容是 ${current.question}。之前的提问/回答历史为：\n\n${history.join('\n\n')}`;
}

function numberName(n) {
  const names = ['零','一','二','三','四','五','六','七','八','九','十'];
  return n <= 10 ? names[n] : String(n);
}

export function createWorker({ config, db, storage, emitUpdate }) {
  const running = new Map();
  let pumping = false;

  async function compressTurn(turn, signal) {
    const finalPath = storage.attachmentPath(turn.conversation_id, turn.turn_no);
    try {
      const stat = await fs.promises.stat(finalPath);
      if (stat.size > 0) {
        if (stat.size > config.limits.maxCompressedAttachmentBytes) throw new Error(`本轮附件压缩后为 ${stat.size.toLocaleString('en-US')} 字节，超过 ${config.limits.maxCompressedAttachmentBytes.toLocaleString('en-US')} 字节限制`);
        db.updateTurnStatus(turn.conversation_id, turn.turn_no, 'compressing', now(), { attachment_ready: 1, attachment_size: stat.size });
        if (turn.upload_id) await cleanupUpload(turn.upload_id, turn.conversation_id, turn.turn_no);
        return finalPath;
      }
    } catch {}
    if (!turn.upload_id) throw new Error('本轮附件不存在，无法继续处理');
    const upload = db.getUpload(turn.upload_id);
    if (!upload || upload.status !== 'bound') throw new Error('本轮上传暂存已丢失');
    const files = db.listUploadFiles(turn.upload_id);
    if (!files.length || files.some((file) => file.status !== 'complete' || file.received_size !== file.size)) throw new Error('本轮附件尚未完整上传');
    const sourceDir = path.join(storage.uploadPath(turn.upload_id), 'files');
    const work = storage.workPath(turn.conversation_id, turn.turn_no, turn.attempt);
    await removePath(work);
    await ensureDir(work);
    const tempArchive = path.join(work, 'turn.tar.xz');
    await runCommand('tar', ['-I', 'xz -8', '-cf', tempArchive, '.'], { cwd: sourceDir, signal });
    const stat = await fs.promises.stat(tempArchive);
    if (stat.size > config.limits.maxCompressedAttachmentBytes) throw new Error(`本轮附件压缩后为 ${stat.size.toLocaleString('en-US')} 字节，超过 ${config.limits.maxCompressedAttachmentBytes.toLocaleString('en-US')} 字节限制`);
    await fs.promises.rename(tempArchive, finalPath);
    db.updateTurnStatus(turn.conversation_id, turn.turn_no, 'compressing', now(), { attachment_ready: 1, attachment_size: stat.size, upload_id: null });
    await cleanupUpload(turn.upload_id, turn.conversation_id, turn.turn_no);
    await removePath(work);
    return finalPath;
  }

  async function cleanupUpload(uploadId) {
    await removePath(storage.uploadPath(uploadId));
    db.transaction(() => {
      db.raw.prepare('UPDATE turns SET upload_id=NULL WHERE upload_id=?').run(uploadId);
      db.deleteUpload(uploadId);
    });
  }

  async function buildAggregate(turn, signal) {
    const turns = db.listTurns(turn.conversation_id).filter((item) => item.turn_no <= turn.turn_no && item.attachment_ready === 1);
    if (!turns.length) return null;
    const work = storage.workPath(turn.conversation_id, turn.turn_no, turn.attempt);
    const stage = path.join(work, 'aggregate');
    await removePath(work);
    await ensureDir(stage);
    const names = [];
    for (const item of turns) {
      const source = storage.attachmentPath(item.conversation_id, item.turn_no);
      const name = `${item.turn_no}.tar.xz`;
      const dest = path.join(stage, name);
      try { await fs.promises.link(source, dest); }
      catch { await fs.promises.copyFile(source, dest); }
      names.push(name);
    }
    const aggregate = path.join(work, 'att.tar.xz');
    await runCommand('tar', ['-I', 'xz -8', '-cf', aggregate, ...names], { cwd: stage, signal });
    const stat = await fs.promises.stat(aggregate);
    if (stat.size > config.limits.maxCompressedAttachmentBytes) throw new Error(`多轮对话 context 附件压缩包为 ${stat.size.toLocaleString('en-US')} 字节，超过 ${config.limits.maxCompressedAttachmentBytes.toLocaleString('en-US')} 字节限制`);
    return { aggregate, work };
  }

  async function processTurn(initial) {
    const key = `${initial.conversation_id}:${initial.turn_no}`;
    const controller = new AbortController();
    let resolveDone;
    const done = new Promise((resolve) => { resolveDone = resolve; });
    running.set(key, { controller, attempt: initial.attempt, done });
    let workToDelete = null;
    try {
      let turn = db.getTurn(initial.conversation_id, initial.turn_no);
      if (!turn || turn.status !== 'pending' || turn.attempt !== initial.attempt) return;
      if (turn.has_attachments && !turn.attachment_ready) {
        db.updateTurnStatus(turn.conversation_id, turn.turn_no, 'compressing', now());
        emitUpdate(turn.conversation_id);
        await compressTurn(turn, controller.signal);
      }
      turn = db.getTurn(initial.conversation_id, initial.turn_no);
      if (!turn || turn.attempt !== initial.attempt) return;
      if (turn.attachment_ready && turn.upload_id) {
        await cleanupUpload(turn.upload_id);
        turn = db.getTurn(initial.conversation_id, initial.turn_no);
        if (!turn || turn.attempt !== initial.attempt) return;
      }
      db.updateTurnStatus(turn.conversation_id, turn.turn_no, 'generating', now());
      const textData = await storage.readText(turn.conversation_id);
      const target = turnText(textData, turn.turn_no);
      if (!target) throw new Error('文字记录损坏：找不到当前轮次');
      target.answer = '';
      target.updatedAt = now();
      await storage.writeText(turn.conversation_id, textData);
      emitUpdate(turn.conversation_id);

      const aggregateInfo = await buildAggregate(turn, controller.signal);
      workToDelete = aggregateInfo?.work || null;
      const prompt = buildPrompt(textData, turn.turn_no);
      let full = '';
      let lastFlush = 0;
      await callProvider({
        config,
        model: turn.model_id,
        prompt,
        imagePaths: aggregateInfo ? [path.join(storage.chatDir, '..', 'server', 'assets', 'a.jpg'), aggregateInfo.aggregate] : [],
        signal: controller.signal,
        onRequestBodySent: async () => {
          if (workToDelete) {
            const target = workToDelete;
            workToDelete = null;
            await removePath(target);
          }
        },
        onChunk: async (chunk) => {
          full += chunk;
          const current = db.getTurn(turn.conversation_id, turn.turn_no);
          if (!current || current.attempt !== turn.attempt || current.status !== 'generating') throw new DOMException('Aborted', 'AbortError');
          const stamp = now();
          if (stamp - lastFlush >= 500) {
            const latest = await storage.readText(turn.conversation_id);
            const item = turnText(latest, turn.turn_no);
            if (item) { item.answer = full; item.updatedAt = stamp; await storage.writeText(turn.conversation_id, latest); }
            lastFlush = stamp;
            emitUpdate(turn.conversation_id);
          }
        }
      });
      const latest = await storage.readText(turn.conversation_id);
      const item = turnText(latest, turn.turn_no);
      if (item) { item.answer = full; item.updatedAt = now(); await storage.writeText(turn.conversation_id, latest); }
      const current = db.getTurn(turn.conversation_id, turn.turn_no);
      if (current && current.attempt === turn.attempt) db.updateTurnStatus(turn.conversation_id, turn.turn_no, 'completed', now());
      emitUpdate(turn.conversation_id);
    } catch (error) {
      if (error?.name !== 'AbortError') {
        const current = db.getTurn(initial.conversation_id, initial.turn_no);
        if (current && current.attempt === initial.attempt) {
          const message = redactSecrets(error?.message || String(error), config);
          const textData = await storage.readText(initial.conversation_id).catch(() => null);
          const item = textData && turnText(textData, initial.turn_no);
          if (item) { item.answer = message; item.updatedAt = now(); await storage.writeText(initial.conversation_id, textData); }
          db.updateTurnStatus(initial.conversation_id, initial.turn_no, 'error', now());
          emitUpdate(initial.conversation_id);
        }
      }
    } finally {
      if (workToDelete) await removePath(workToDelete);
      await removePath(storage.workPath(initial.conversation_id, initial.turn_no, initial.attempt));
      running.delete(key);
      resolveDone();
      setImmediate(pump);
    }
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      const capacity = config.limits.maxConcurrentTasks - running.size;
      if (capacity <= 0) return;
      const pending = db.listPending(capacity * 2);
      for (const turn of pending) {
        const key = `${turn.conversation_id}:${turn.turn_no}`;
        if (running.has(key) || running.size >= config.limits.maxConcurrentTasks) continue;
        processTurn(turn);
      }
    } finally { pumping = false; }
  }

  async function cancelConversation(conversationId, fromTurn = 1) {
    const waits = [];
    for (const [key, task] of running) {
      const [id, turnTextNo] = key.split(':');
      if (id === conversationId && Number(turnTextNo) >= fromTurn) {
        task.controller.abort();
        waits.push(task.done);
      }
    }
    await Promise.allSettled(waits);
  }

  return { pump, cancelConversation, running };
}
