import { randomUUID } from 'node:crypto';
import {
  appendTextEvent,
  compressPendingTurnAttachments,
  createTextEventWriter,
  readConversation,
  attachmentBinPath,
  ensureConversationArchiveV2,
} from './storage.js';
import { ATTACHMENT_INSTRUCTION, callProvider } from './provider.js';
import { buildProviderPrompt } from './prompts.js';
import { redactProviderSecrets } from './redact.js';

function taskKey(chatId, turnNo) {
  return `${chatId}:${turnNo}`;
}

function mergedTurns(metadataTurns, textTurns) {
  const textByNumber = new Map(textTurns.map((turn) => [turn.turnNumber, turn]));
  return metadataTurns.map((turn) => {
    const text = textByNumber.get(turn.turnNo) || {};
    return {
      ...turn,
      prompt: text.prompt || '',
      answer: turn.status === 'failed' ? '' : (text.answer || ''),
      error: turn.error || text.error || null,
      latestAttemptId: text.latestAttemptId || turn.attemptId || null,
      deltaSequence: text.deltaSequence || 0,
      attachments: text.attachments || [],
    };
  });
}

export class WorkerPool {
  constructor({ config, database, events }) {
    this.config = config;
    this.database = database;
    this.events = events;
    this.queue = [];
    this.queued = new Map();
    this.active = new Map();
    this.stopping = false;
  }

  start() {
    this.database.resetInterrupted();
    for (const task of this.database.listUnfinishedTasks()) this.enqueue(task.chatId, task.turnNo, task.taskToken);
  }

  enqueue(chatId, turnNo, taskToken) {
    if (this.stopping) return;
    const key = taskKey(chatId, turnNo);
    const queued = this.queued.get(key);
    if (queued?.taskToken === taskToken || this.active.get(key)?.taskToken === taskToken) return;
    if (queued) this.queue = this.queue.filter((task) => taskKey(task.chatId, task.turnNo) !== key);
    const task = { chatId, turnNo, taskToken };
    this.queue.push(task);
    this.queued.set(key, task);
    this.pump();
  }

  pump() {
    while (!this.stopping && this.active.size < this.config.limits.maxParallelTasks && this.queue.length) {
      const task = this.queue.shift();
      const key = taskKey(task.chatId, task.turnNo);
      this.queued.delete(key);
      const current = this.database.getTurn(task.chatId, task.turnNo);
      if (!current || current.taskToken !== task.taskToken) continue;
      const controller = new AbortController();
      const promise = this.run(task, controller)
        .catch((error) => console.error(`[worker:${key}]`, error))
        .finally(() => {
          const active = this.active.get(key);
          if (active?.taskToken === task.taskToken) this.active.delete(key);
          this.pump();
        });
      this.active.set(key, { ...task, controller, promise });
    }
  }

  async run(task, controller) {
    const { chatId, turnNo, taskToken } = task;
    const original = this.database.getConversationInternal(chatId);
    const turn = original?.turns.find((candidate) => candidate.turnNo === turnNo);
    if (!original || !turn || turn.taskToken !== taskToken) return;
    const model = this.config.models.find((candidate) => candidate.id === original.chat.modelId);
    if (!model) {
      const message = `配置中已找不到模型：${original.chat.modelId}`;
      this.database.markFailed(chatId, turnNo, taskToken, message);
      await appendTextEvent(this.config.chatDir, chatId, {
        type: 'attempt_error', turnNumber: turnNo, attemptId: null, error: message, createdAt: new Date().toISOString(),
      }).catch(() => {});
      this.events.emit(chatId, { type: 'turn_status', turnNo, status: 'failed', error: message });
      return;
    }

    let writer = null;
    let attemptId = null;
    let deltaSequence = 0;
    try {
      if (!this.database.markPreparing(chatId, turnNo, taskToken)) return;
      this.events.emit(chatId, { type: 'turn_status', turnNo, status: 'preparing' });

      let currentTurn = this.database.getTurn(chatId, turnNo);
      if (!currentTurn.attachmentReady) {
        const archive = await compressPendingTurnAttachments({
          chatDir: this.config.chatDir,
          chatId,
          turnNumber: turnNo,
          archiveVersion: original.chat.archiveVersion,
          maxBytes: this.config.limits.maxCompressedAttachmentBytes,
          signal: controller.signal,
        });
        if (controller.signal.aborted) throw Object.assign(new Error('任务已取消'), { name: 'AbortError' });
        if (!this.database.markAttachmentReady(chatId, turnNo, taskToken, currentTurn.hasAttachments ? archive.bytes : 0)) return;
        this.database.markArchiveVersion(chatId, 2);
        this.events.emit(chatId, {
          type: 'attachment_ready', turnNo, attachmentBytes: currentTurn.hasAttachments ? archive.bytes : 0,
        });
        currentTurn = this.database.getTurn(chatId, turnNo);
      }

      const currentConversation = this.database.getConversationInternal(chatId);
      const textConversation = await readConversation(this.config.chatDir, chatId);
      const turns = mergedTurns(currentConversation.turns, textConversation.turns);
      const current = turns.find((candidate) => candidate.turnNo === turnNo);
      if (!current) throw new Error('找不到当前轮次文本');
      const previous = turns.filter((candidate) => candidate.turnNo < turnNo);
      const throughCurrent = turns.filter((candidate) => candidate.turnNo <= turnNo);
      const hasAnyAttachments = throughCurrent.some((candidate) => candidate.hasAttachments);
      const providerPrompt = buildProviderPrompt({
        turnNo,
        currentPrompt: current.prompt,
        history: previous,
        hasAnyAttachments,
      });

      if (hasAnyAttachments && currentConversation.chat.archiveVersion < 2) {
        await ensureConversationArchiveV2({
          chatDir: this.config.chatDir,
          chatId,
          throughTurn: turnNo,
          archiveVersion: currentConversation.chat.archiveVersion,
          maxBytes: this.config.limits.maxCompressedAttachmentBytes,
          signal: controller.signal,
        });
        this.database.markArchiveVersion(chatId, 2);
      }
      if (controller.signal.aborted) throw Object.assign(new Error('任务已取消'), { name: 'AbortError' });

      attemptId = randomUUID();
      if (!this.database.markRunning(chatId, turnNo, taskToken, attemptId)) return;
      writer = await createTextEventWriter(this.config.chatDir, chatId);
      await writer.write({
        type: 'attempt_start', turnNumber: turnNo, attemptId,
        createdAt: new Date().toISOString(),
        attachmentInstruction: hasAnyAttachments ? ATTACHMENT_INSTRUCTION : '',
      });
      this.events.emit(chatId, { type: 'turn_status', turnNo, status: 'running', attemptId });

      await callProvider({
        config: this.config,
        model,
        prompt: providerPrompt,
        attachmentPath: hasAnyAttachments ? attachmentBinPath(this.config.chatDir, chatId) : null,
        hasAttachments: hasAnyAttachments,
        signal: controller.signal,
        onDelta: async (text) => {
          const latest = this.database.getTurn(chatId, turnNo);
          if (!latest || latest.taskToken !== taskToken) return;
          deltaSequence += 1;
          await writer.write({
            type: 'assistant_delta', turnNumber: turnNo, attemptId,
            sequence: deltaSequence, text, createdAt: new Date().toISOString(),
          });
          this.events.emit(chatId, { type: 'delta', turnNo, attemptId, sequence: deltaSequence, text });
        },
      });

      const latest = this.database.getTurn(chatId, turnNo);
      if (!latest || latest.taskToken !== taskToken) return;
      await writer.write({ type: 'attempt_done', turnNumber: turnNo, attemptId, createdAt: new Date().toISOString() });
      await writer.close();
      writer = null;
      this.database.markCompleted(chatId, turnNo, taskToken);
      this.events.emit(chatId, { type: 'turn_status', turnNo, status: 'completed', attemptId });
    } catch (error) {
      const reason = controller.signal.aborted ? controller.signal.reason : null;
      const latest = this.database.getTurn(chatId, turnNo);
      if (['shutdown', 'deleted', 'edited'].includes(reason) || !latest || latest.taskToken !== taskToken) return;
      const message = redactProviderSecrets(error?.message || error, this.config);
      const errorEvent = {
        type: 'attempt_error', turnNumber: turnNo, attemptId,
        error: message, createdAt: new Date().toISOString(),
      };
      if (writer) await writer.write(errorEvent).catch(() => {});
      else await appendTextEvent(this.config.chatDir, chatId, errorEvent).catch(() => {});
      this.database.markFailed(chatId, turnNo, taskToken, message);
      this.events.emit(chatId, { type: 'turn_status', turnNo, status: 'failed', attemptId, error: message });
    } finally {
      await writer?.close().catch((error) => console.error(`[worker:${chatId}:${turnNo}] writer close failed`, error));
    }
  }

  async cancelTask(chatId, turnNo, reason = 'deleted') {
    const key = taskKey(chatId, turnNo);
    this.queue = this.queue.filter((task) => taskKey(task.chatId, task.turnNo) !== key);
    this.queued.delete(key);
    const active = this.active.get(key);
    if (active) {
      active.controller.abort(reason);
      await active.promise.catch(() => {});
    }
  }

  async cancelFrom(chatId, fromTurnNo, reason = 'edited') {
    const turnNumbers = new Set([
      ...this.queue.filter((task) => task.chatId === chatId && task.turnNo >= fromTurnNo).map((task) => task.turnNo),
      ...[...this.active.values()].filter((task) => task.chatId === chatId && task.turnNo >= fromTurnNo).map((task) => task.turnNo),
    ]);
    await Promise.all([...turnNumbers].map((turnNo) => this.cancelTask(chatId, turnNo, reason)));
  }

  async cancel(chatId, reason = 'deleted') {
    await this.cancelFrom(chatId, 1, reason);
  }

  async cancelMany(ids, reason = 'deleted') {
    await Promise.all([...ids].map((id) => this.cancel(id, reason)));
  }

  async cancelAll(reason = 'deleted') {
    const ids = new Set([
      ...this.queue.map((task) => task.chatId),
      ...[...this.active.values()].map((task) => task.chatId),
    ]);
    await this.cancelMany(ids, reason);
  }

  async stop() {
    this.stopping = true;
    await this.cancelAll('shutdown');
  }
}
