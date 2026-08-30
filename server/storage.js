import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import archiver from 'archiver';
import { Transform } from 'node:stream';
import { once } from 'node:events';
import { finished, pipeline } from 'node:stream/promises';
import { uniqueZipNames } from './filenames.js';
import { ensureTrailingNewline } from './jsonl.js';

export function textBinPath(chatDir, id) {
  return path.join(chatDir, `${id}.text.bin`);
}

export function attachmentBinPath(chatDir, id) {
  return path.join(chatDir, `${id}.attachments.bin`);
}

export async function initializeTextBinAt(filePath, id, data) {
  const events = [
    {
      type: 'meta',
      version: 1,
      chatId: id,
      createdAt: data.createdAt,
      modelId: data.modelId,
      modelLabel: data.modelLabel,
      attachments: data.attachments,
    },
    {
      type: 'user',
      text: data.prompt,
      createdAt: data.createdAt,
    },
  ];
  const body = `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
  await fsp.writeFile(filePath, body, { flag: 'wx', mode: 0o600 });
}

export async function initializeTextBin(chatDir, id, data) {
  await initializeTextBinAt(textBinPath(chatDir, id), id, data);
}

export async function appendTextEvent(chatDir, id, event) {
  const filePath = textBinPath(chatDir, id);
  await ensureTrailingNewline(filePath);
  await fsp.appendFile(filePath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
}

export async function createTextEventWriter(chatDir, id) {
  const filePath = textBinPath(chatDir, id);
  await ensureTrailingNewline(filePath);
  const stream = fs.createWriteStream(filePath, { flags: 'a', mode: 0o600 });
  let closed = false;
  let streamError = null;
  stream.on('error', (error) => {
    streamError = error;
  });
  return {
    async write(event) {
      if (closed) throw new Error('文本事件写入器已关闭');
      if (streamError) throw streamError;
      if (!stream.write(`${JSON.stringify(event)}\n`)) {
        await once(stream, 'drain');
      }
      if (streamError) throw streamError;
    },
    async close() {
      if (closed) return;
      closed = true;
      stream.end();
      await finished(stream);
    },
  };
}

export async function readTextBin(chatDir, id) {
  const raw = await fsp.readFile(textBinPath(chatDir, id), 'utf8');
  const lines = raw.split('\n');
  let meta = null;
  let prompt = '';
  let latestAttemptId = null;
  let answer = '';
  let internalInstruction = '';
  let deltaSequence = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'meta') meta = event;
    if (event.type === 'user') prompt = String(event.text || '');
    if (event.type === 'attempt_start') {
      latestAttemptId = event.attemptId;
      answer = '';
      internalInstruction = String(event.attachmentInstruction || '');
      deltaSequence = 0;
    }
    if (event.type === 'assistant_delta' && event.attemptId === latestAttemptId) {
      const delta = String(event.text || '');
      answer += delta;
      const recorded = Number(event.sequence);
      deltaSequence = Number.isSafeInteger(recorded) && recorded > 0
        ? Math.max(deltaSequence, recorded)
        : deltaSequence + 1;
    }
  }

  return {
    meta,
    prompt,
    answer,
    latestAttemptId,
    internalInstruction,
    deltaSequence,
  };
}

class ByteLimitTransform extends Transform {
  constructor(limit) {
    super();
    this.limit = limit;
    this.bytes = 0;
  }

  _transform(chunk, _encoding, callback) {
    this.bytes += chunk.length;
    if (this.bytes > this.limit) {
      callback(Object.assign(new Error(`附件压缩后超过 ${this.limit} 字节限制`), { code: 'COMPRESSED_LIMIT' }));
      return;
    }
    callback(null, chunk);
  }
}

export async function createAttachmentArchive({ files, destination, maxBytes }) {
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  const output = fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 });
  const limiter = new ByteLimitTransform(maxBytes);
  const archive = archiver('zip', { zlib: { level: 9 } });
  const names = uniqueZipNames(files);

  archive.on('warning', (error) => {
    if (error.code !== 'ENOENT') archive.destroy(error);
  });

  const pipePromise = pipeline(archive, limiter, output);
  try {
    files.forEach((file, index) => {
      archive.file(file.tempPath, { name: names[index], date: new Date('1980-01-01T00:00:00.000Z') });
    });
    await Promise.all([archive.finalize(), pipePromise]);
    await fsp.rename(temporary, destination);
    return { bytes: limiter.bytes, names };
  } catch (error) {
    archive.abort();
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export async function deleteChatFiles(chatDir, id) {
  await Promise.all([
    fsp.rm(textBinPath(chatDir, id), { force: true }),
    fsp.rm(attachmentBinPath(chatDir, id), { force: true }),
  ]);
}

export async function deleteAllChatBins(chatDir) {
  const entries = await fsp.readdir(chatDir, { withFileTypes: true });
  await Promise.all(entries
    .filter((entry) => entry.isFile() && /\.(text|attachments)\.bin$/.test(entry.name))
    .map((entry) => fsp.rm(path.join(chatDir, entry.name), { force: true })));
}


export async function cleanupStorageArtifacts(chatDir, validChatIds) {
  await fsp.rm(path.join(chatDir, '.uploads'), { recursive: true, force: true }).catch(() => {});
  const entries = await fsp.readdir(chatDir, { withFileTypes: true });
  await Promise.all(entries
    .filter((entry) => {
      if (!entry.isFile()) return false;
      if (entry.name.includes('.tmp-')) return true;
      const match = entry.name.match(/^([0-9a-f-]+)\.(?:text|attachments)\.bin$/i);
      return Boolean(match && !validChatIds.has(match[1]));
    })
    .map((entry) => fsp.rm(path.join(chatDir, entry.name), { force: true })));
}
