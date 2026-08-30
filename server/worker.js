import { randomUUID } from 'node:crypto';
import {
  appendTextEvent,
  attachmentBinPath,
  createTextEventWriter,
  readTextBin,
} from './storage.js';
import { ATTACHMENT_INSTRUCTION, callProvider } from './provider.js';
import { redactProviderSecrets } from './redact.js';

export class WorkerPool {
  constructor({ config, database, events }) {
    this.config = config;
    this.database = database;
    this.events = events;
    this.queue = [];
    this.queued = new Set();
    this.active = new Map();
    this.stopping = false;
  }

  start() {
    this.database.resetInterrupted();
    for (const id of this.database.listUnfinishedIds()) this.enqueue(id);
  }

  enqueue(id) {
    if (this.stopping || this.queued.has(id) || this.active.has(id)) return;
    this.queue.push(id);
    this.queued.add(id);
    this.pump();
  }

  pump() {
    while (!this.stopping
      && this.active.size < this.config.limits.maxParallelTasks
      && this.queue.length > 0) {
      const id = this.queue.shift();
      this.queued.delete(id);
      const controller = new AbortController();
      const task = this.run(id, controller)
        .catch((error) => console.error(`[worker:${id}]`, error))
        .finally(() => {
          this.active.delete(id);
          this.pump();
        });
      this.active.set(id, { controller, task });
    }
  }

  async run(id, controller) {
    const chat = this.database.getChatInternal(id);
    if (!chat) return;
    const model = this.config.models.find((candidate) => candidate.id === chat.modelId);
    if (!model) {
      const message = `配置中已找不到模型：${chat.modelId}`;
      await appendTextEvent(this.config.chatDir, id, {
        type: 'task_error',
        error: message,
        createdAt: new Date().toISOString(),
      }).catch(() => {});
      this.database.markFailed(id, message);
      this.events.emit(id, { type: 'status', status: 'failed', error: message });
      return;
    }

    const attemptId = randomUUID();
    let writer = null;
    let deltaSequence = 0;
    try {
      this.database.markRunning(id, attemptId);
      writer = await createTextEventWriter(this.config.chatDir, id);
      await writer.write({
        type: 'attempt_start',
        attemptId,
        createdAt: new Date().toISOString(),
        attachmentInstruction: chat.hasAttachments ? ATTACHMENT_INSTRUCTION : '',
      });
      this.events.emit(id, { type: 'status', status: 'running', attemptId });

      const conversation = await readTextBin(this.config.chatDir, id);
      await callProvider({
        config: this.config,
        model,
        prompt: conversation.prompt,
        attachmentPath: attachmentBinPath(this.config.chatDir, id),
        hasAttachments: chat.hasAttachments,
        signal: controller.signal,
        onDelta: async (text) => {
          if (!this.database.getChatInternal(id)) return;
          deltaSequence += 1;
          await writer.write({
            type: 'assistant_delta',
            attemptId,
            sequence: deltaSequence,
            text,
            createdAt: new Date().toISOString(),
          });
          this.events.emit(id, { type: 'delta', attemptId, sequence: deltaSequence, text });
        },
      });

      if (!this.database.getChatInternal(id)) return;
      await writer.write({ type: 'attempt_done', attemptId, createdAt: new Date().toISOString() });
      await writer.close();
      writer = null;
      this.database.markCompleted(id);
      this.events.emit(id, { type: 'status', status: 'completed', attemptId });
    } catch (error) {
      const abortReason = controller.signal.aborted ? controller.signal.reason : null;
      if (abortReason === 'shutdown' || abortReason === 'deleted' || !this.database.getChatInternal(id)) {
        return;
      }
      const message = redactProviderSecrets(error?.message || error, this.config);
      const errorEvent = {
        type: 'attempt_error',
        attemptId,
        error: message,
        createdAt: new Date().toISOString(),
      };
      if (writer) await writer.write(errorEvent).catch(() => {});
      else await appendTextEvent(this.config.chatDir, id, errorEvent).catch(() => {});
      this.database.markFailed(id, message);
      this.events.emit(id, { type: 'status', status: 'failed', attemptId, error: message });
    } finally {
      await writer?.close().catch((error) => {
        console.error(`[worker:${id}] failed to close text event writer`, error);
      });
    }
  }

  async cancel(id, reason = 'deleted') {
    this.queue = this.queue.filter((queuedId) => queuedId !== id);
    this.queued.delete(id);
    const active = this.active.get(id);
    if (active) {
      active.controller.abort(reason);
      await active.task.catch(() => {});
    }
  }

  async cancelMany(ids, reason = 'deleted') {
    await Promise.all(Array.from(ids, (id) => this.cancel(id, reason)));
  }

  async cancelAll(reason = 'deleted') {
    this.queue = [];
    this.queued.clear();
    const activeTasks = [];
    for (const { controller, task } of this.active.values()) {
      controller.abort(reason);
      activeTasks.push(task.catch(() => {}));
    }
    await Promise.all(activeTasks);
  }

  async stop() {
    this.stopping = true;
    await this.cancelAll('shutdown');
  }
}
