import fsp from 'node:fs/promises';
import path from 'node:path';

export const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
export const MAX_CHAT_STORAGE_BYTES = 3_000_000_000;
export const REGULAR_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const PRESSURE_RETENTION_MS = 24 * 60 * 60 * 1000;

async function directorySize(directory) {
  let entries;
  try {
    entries = await fsp.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }

  let total = 0;
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      total += await directorySize(target);
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      total += (await fsp.stat(target)).size;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return total;
}

async function removeChatFiles(chatDir, id) {
  await Promise.all([
    fsp.rm(path.join(chatDir, `${id}.text.bin`), { force: true }),
    fsp.rm(path.join(chatDir, `${id}.attachments.bin`), { force: true }),
  ]);
}

export async function getChatStorageBytes(chatDir) {
  return directorySize(chatDir);
}

export class StorageCleanup {
  constructor({
    chatDir,
    database,
    workers,
    events,
    mutex,
    intervalMs = CLEANUP_INTERVAL_MS,
    maxStorageBytes = MAX_CHAT_STORAGE_BYTES,
    regularRetentionMs = REGULAR_RETENTION_MS,
    pressureRetentionMs = PRESSURE_RETENTION_MS,
    now = () => Date.now(),
    logger = console,
  }) {
    this.chatDir = chatDir;
    this.database = database;
    this.workers = workers;
    this.events = events;
    this.mutex = mutex;
    this.intervalMs = intervalMs;
    this.maxStorageBytes = maxStorageBytes;
    this.regularRetentionMs = regularRetentionMs;
    this.pressureRetentionMs = pressureRetentionMs;
    this.now = now;
    this.logger = logger;
    this.timer = null;
    this.running = null;
    this.stopped = false;
  }

  start() {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => {
      void this.run('scheduled').catch((error) => {
        this.logger.error('[cleanup] scheduled cleanup failed', error);
      });
    }, this.intervalMs);
    this.timer.unref?.();
  }

  async deleteBefore(cutoffIso, reason) {
    return this.mutex.runExclusive(async () => {
      let deletedTotal = 0;
      while (true) {
        const ids = this.database.listIdsCreatedBefore(cutoffIso, 500);
        if (!ids.length) break;

        await this.workers.cancelMany(ids, 'deleted');
        deletedTotal += this.database.deleteInternalIds(ids);
        const results = await Promise.allSettled(ids.map((id) => removeChatFiles(this.chatDir, id)));
        results.forEach((result, index) => {
          if (result.status === 'rejected') {
            this.logger.error(`[cleanup] failed to remove files for ${ids[index]}`, result.reason);
          }
        });
        for (const id of ids) this.events.emit(id, { type: 'deleted', reason });
      }
      return deletedTotal;
    });
  }

  async execute(trigger) {
    const now = this.now();
    const bytesAtStart = await getChatStorageBytes(this.chatDir);
    const regularCutoff = new Date(now - this.regularRetentionMs).toISOString();
    const expiredDeleted = await this.deleteBefore(regularCutoff, 'retention');

    let pressureDeleted = 0;
    if (bytesAtStart > this.maxStorageBytes) {
      const pressureCutoff = new Date(now - this.pressureRetentionMs).toISOString();
      pressureDeleted = await this.deleteBefore(pressureCutoff, 'storage-pressure');
    }

    if (expiredDeleted || pressureDeleted) {
      try {
        this.database.compact();
      } catch (error) {
        this.logger.error('[cleanup] SQLite compaction failed', error);
      }
    }
    const bytesAfterCleanup = await getChatStorageBytes(this.chatDir);

    if (expiredDeleted || pressureDeleted || bytesAtStart > this.maxStorageBytes) {
      this.logger.log(
        `[cleanup] ${trigger}: storage started at ${bytesAtStart} byte(s); `
        + `deleted ${expiredDeleted} chat(s) older than 7 days; `
        + `deleted ${pressureDeleted} chat(s) older than 24 hours under storage pressure; `
        + `remaining ${bytesAfterCleanup} byte(s).`,
      );
    }

    return {
      trigger,
      expiredDeleted,
      pressureDeleted,
      bytesAtStart,
      bytesAfterCleanup,
    };
  }

  run(trigger = 'manual') {
    if (this.stopped) {
      return Promise.resolve({ trigger, skipped: true, reason: 'stopped' });
    }
    if (this.running) return this.running;
    this.running = this.execute(trigger).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running?.catch(() => {});
  }
}
