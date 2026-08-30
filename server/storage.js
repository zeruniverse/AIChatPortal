import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { finished, pipeline } from 'node:stream/promises';
import { uniqueZipNames } from './filenames.js';
import { ensureTrailingNewline } from './jsonl.js';
import { createEmptyZip, runZip9 } from './archive.js';

const execFileAsync = promisify(execFile);

export function textBinPath(chatDir, id) {
  return path.join(chatDir, `${id}.text.bin`);
}

export function attachmentBinPath(chatDir, id) {
  return path.join(chatDir, `${id}.attachments.bin`);
}

// Kept as a compatibility alias for v4 code and migration tooling.
export const legacyAttachmentBinPath = attachmentBinPath;

export function pendingTurnDir(chatDir, id, turnNumber) {
  return path.join(chatDir, '.pending', id, String(turnNumber));
}

export function workRoot(chatDir) {
  return path.join(chatDir, '.work');
}

export function downloadRoot(chatDir) {
  return path.join(chatDir, '.downloads');
}

function abortError(reason) {
  return Object.assign(new Error('任务已取消'), { name: 'AbortError', reason });
}

async function pathExists(filePath) {
  try { await fsp.access(filePath); return true; } catch { return false; }
}

async function copyOrLink(source, destination) {
  try {
    await fsp.link(source, destination);
  } catch (error) {
    if (!['EXDEV', 'EPERM', 'EACCES', 'EMLINK'].includes(error?.code)) throw error;
    await fsp.copyFile(source, destination);
  }
}

async function listZipEntries(archivePath) {
  if (!(await pathExists(archivePath))) return [];
  try {
    const { stdout } = await execFileAsync('unzip', ['-Z1', archivePath], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  } catch (error) {
    if (error?.code === 1 && !String(error?.stdout || '').trim()) return [];
    if (error?.code === 'ENOENT') throw new Error('服务器缺少 unzip 命令，请安装 Info-ZIP unzip');
    throw new Error(`读取附件压缩包失败：${String(error?.stderr || error?.message || error).trim()}`);
  }
}

function numberedZipEntries(entries) {
  return entries.filter((name) => /^(?:[1-9]\d*)\.zip$/.test(name));
}

async function extractZip(archivePath, destination, signal) {
  if (signal?.aborted) throw abortError(signal.reason);
  await fsp.mkdir(destination, { recursive: true, mode: 0o700 });
  await new Promise((resolve, reject) => {
    let settled = false;
    let stderr = '';
    const child = spawn('unzip', ['-qq', archivePath, '-d', destination], {
      stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
    });
    const finish = (error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve();
    };
    const onAbort = () => { child.kill('SIGKILL'); finish(abortError(signal?.reason)); };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); });
    child.once('error', (error) => finish(error?.code === 'ENOENT'
      ? new Error('服务器缺少 unzip 命令，请安装 Info-ZIP unzip')
      : error));
    child.once('exit', (code, childSignal) => {
      if (code === 0 || code === 1) finish();
      else finish(new Error(`解压对话附件索引失败（退出码 ${code ?? childSignal ?? 'unknown'}）：${stderr.trim() || '没有错误详情'}`));
    });
  });
}

async function extractZipEntryToFile(archivePath, entryName, destination, signal) {
  if (signal?.aborted) throw abortError(signal.reason);
  const entries = await listZipEntries(archivePath);
  if (!entries.includes(entryName)) return false;
  await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
  const output = fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 });
  const child = spawn('unzip', ['-p', archivePath, entryName], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); });
  const onAbort = () => child.kill('SIGKILL');
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    await Promise.all([
      pipeline(child.stdout, output),
      once(child, 'exit').then(([code, childSignal]) => {
        if (signal?.aborted) throw abortError(signal.reason);
        if (code !== 0) throw new Error(`提取本轮附件失败（退出码 ${code ?? childSignal ?? 'unknown'}）：${stderr.trim() || '没有错误详情'}`);
      }),
    ]);
    await fsp.rename(temporary, destination);
    return true;
  } catch (error) {
    child.kill('SIGKILL');
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

export async function initializeAttachmentBin(chatDir, id) {
  return createEmptyZip(attachmentBinPath(chatDir, id));
}

export async function initializeTextBinAt(filePath, id, data) {
  const events = [
    {
      type: 'meta', version: 3, chatId: id, createdAt: data.createdAt,
      modelId: data.modelId, modelLabel: data.modelLabel,
    },
    {
      type: 'turn_user', turnId: data.turnId, turnNumber: 1,
      text: data.prompt, createdAt: data.createdAt, attachments: data.attachments || [],
    },
  ];
  await fsp.writeFile(filePath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, { flag: 'wx', mode: 0o600 });
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
  stream.on('error', (error) => { streamError = error; });
  return {
    async write(event) {
      if (closed) throw new Error('文本事件写入器已关闭');
      if (streamError) throw streamError;
      if (!stream.write(`${JSON.stringify(event)}\n`)) await once(stream, 'drain');
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

function getOrCreateTurn(map, turnNumber, turnId = null) {
  const number = Number(turnNumber) || 1;
  if (!map.has(number)) {
    map.set(number, {
      turnId: turnId || `legacy-turn-${number}`,
      turnNumber: number,
      prompt: '', answer: '', error: null, attachments: [],
      createdAt: null, latestAttemptId: null, deltaSequence: 0,
    });
  }
  const turn = map.get(number);
  if (turnId) turn.turnId = turnId;
  return turn;
}

export async function readConversation(chatDir, id) {
  const raw = await fsp.readFile(textBinPath(chatDir, id), 'utf8');
  const turnMap = new Map();
  const attemptToTurn = new Map();
  let meta = null;
  let legacyTurn = null;

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'meta') { meta = event; continue; }
    if (event.type === 'user') {
      legacyTurn = getOrCreateTurn(turnMap, 1, event.turnId || 'legacy-turn-1');
      legacyTurn.prompt = String(event.text || '');
      legacyTurn.createdAt = event.createdAt || meta?.createdAt || null;
      legacyTurn.attachments = meta?.attachments || [];
      continue;
    }
    if (event.type === 'turn_user') {
      const turn = getOrCreateTurn(turnMap, event.turnNumber, event.turnId);
      turn.prompt = String(event.text || '');
      turn.createdAt = event.createdAt || turn.createdAt;
      turn.attachments = Array.isArray(event.attachments) ? event.attachments : [];
      continue;
    }
    if (event.type === 'attempt_start') {
      const turn = event.turnNumber
        ? getOrCreateTurn(turnMap, event.turnNumber, event.turnId)
        : (legacyTurn || getOrCreateTurn(turnMap, 1, event.turnId || 'legacy-turn-1'));
      turn.latestAttemptId = event.attemptId;
      turn.answer = '';
      turn.error = null;
      turn.deltaSequence = 0;
      attemptToTurn.set(event.attemptId, turn.turnNumber);
      continue;
    }
    if (event.type === 'assistant_delta') {
      const number = event.turnNumber || attemptToTurn.get(event.attemptId) || 1;
      const turn = getOrCreateTurn(turnMap, number, event.turnId);
      if (!turn.latestAttemptId) turn.latestAttemptId = event.attemptId;
      if (event.attemptId === turn.latestAttemptId) {
        turn.answer += String(event.text || '');
        const sequence = Number(event.sequence);
        turn.deltaSequence = Number.isSafeInteger(sequence) && sequence > 0
          ? Math.max(turn.deltaSequence, sequence) : turn.deltaSequence + 1;
      }
      continue;
    }
    if (event.type === 'attempt_error' || event.type === 'task_error') {
      const number = event.turnNumber || attemptToTurn.get(event.attemptId) || 1;
      const turn = getOrCreateTurn(turnMap, number, event.turnId);
      if (!event.attemptId || !turn.latestAttemptId || event.attemptId === turn.latestAttemptId) {
        turn.error = String(event.error || '模型调用失败');
        turn.answer = '';
      }
    }
  }

  return { meta, turns: Array.from(turnMap.values()).sort((a, b) => a.turnNumber - b.turnNumber) };
}

export async function readTextBin(chatDir, id) {
  const conversation = await readConversation(chatDir, id);
  const turn = conversation.turns.at(-1) || {};
  return {
    meta: conversation.meta,
    prompt: turn.prompt || '',
    answer: turn.error || turn.answer || '',
    latestAttemptId: turn.latestAttemptId || null,
    deltaSequence: turn.deltaSequence || 0,
    turns: conversation.turns,
  };
}

export async function rewriteConversationText(chatDir, id, { meta, turns }) {
  const events = [{
    type: 'meta', version: 3, chatId: id,
    createdAt: meta?.createdAt || turns[0]?.createdAt || new Date().toISOString(),
    modelId: meta?.modelId || '', modelLabel: meta?.modelLabel || '',
  }];
  for (const turn of turns) {
    events.push({
      type: 'turn_user', turnId: turn.turnId, turnNumber: turn.turnNumber,
      text: turn.prompt, createdAt: turn.createdAt, attachments: turn.attachments || [],
    });
    if (turn.answer || turn.error) {
      const attemptId = turn.latestAttemptId || `snapshot-${turn.turnId}`;
      events.push({ type: 'attempt_start', turnId: turn.turnId, turnNumber: turn.turnNumber, attemptId, createdAt: turn.createdAt });
      if (turn.error) {
        events.push({ type: 'attempt_error', turnId: turn.turnId, turnNumber: turn.turnNumber, attemptId, error: turn.error, createdAt: turn.completedAt || turn.createdAt });
      } else {
        events.push({ type: 'assistant_delta', turnId: turn.turnId, turnNumber: turn.turnNumber, attemptId, sequence: 1, text: turn.answer, createdAt: turn.completedAt || turn.createdAt });
        events.push({ type: 'attempt_done', turnId: turn.turnId, turnNumber: turn.turnNumber, attemptId, createdAt: turn.completedAt || turn.createdAt });
      }
    }
  }
  const destination = textBinPath(chatDir, id);
  const temporary = `${destination}.rewrite-${process.pid}-${Date.now()}`;
  await fsp.writeFile(temporary, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, { flag: 'wx', mode: 0o600 });
  await fsp.rename(temporary, destination);
}

export async function adoptPendingUpload({ uploadDirectory, chatDir, chatId, turnNumber, files }) {
  const names = uniqueZipNames(files);
  const manifest = files.map((file, index) => ({
    storedName: path.basename(file.tempPath),
    zipName: names[index],
    originalName: file.originalName,
    mimeType: file.mimeType,
  }));
  await fsp.writeFile(path.join(uploadDirectory, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
  const destination = pendingTurnDir(chatDir, chatId, turnNumber);
  await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await fsp.rm(destination, { recursive: true, force: true });
  await fsp.rename(uploadDirectory, destination);
  return manifest;
}

async function buildConversationArchive({
  chatDir, chatId, archiveVersion, throughTurn, replacementTurnNo = null,
  replacementZip = null, maxBytes, signal,
}) {
  const outer = attachmentBinPath(chatDir, chatId);
  const work = path.join(workRoot(chatDir), `${chatId}-${throughTurn}-${randomUUID()}`);
  const rounds = path.join(work, 'rounds');
  await fsp.mkdir(rounds, { recursive: true, mode: 0o700 });
  try {
    if (await pathExists(outer)) {
      if (Number(archiveVersion) >= 2) {
        await extractZip(outer, rounds, signal);
      } else if (throughTurn >= 1) {
        await copyOrLink(outer, path.join(rounds, '1.zip'));
      }
    }

    const existing = await fsp.readdir(rounds, { withFileTypes: true }).catch(() => []);
    await Promise.all(existing.map(async (entry) => {
      const match = entry.isFile() ? entry.name.match(/^([1-9]\d*)\.zip$/) : null;
      if (!match || Number(match[1]) > throughTurn) {
        await fsp.rm(path.join(rounds, entry.name), { recursive: entry.isDirectory(), force: true });
      }
    }));

    if (replacementTurnNo !== null && replacementZip) {
      const destination = path.join(rounds, `${replacementTurnNo}.zip`);
      await fsp.rm(destination, { force: true });
      await copyOrLink(replacementZip, destination);
    }

    // Every retained turn gets one numbered inner ZIP, including an empty ZIP for turns without files.
    if (replacementTurnNo !== null) {
      for (let number = 1; number <= throughTurn; number += 1) {
        const filePath = path.join(rounds, `${number}.zip`);
        if (!(await pathExists(filePath))) await createEmptyZip(filePath);
      }
    }

    const names = numberedZipEntries(await fsp.readdir(rounds)).sort((a, b) => Number(a.slice(0, -4)) - Number(b.slice(0, -4)));
    if (!names.length) return await createEmptyZip(outer);
    return await runZip9({ cwd: rounds, names, destination: outer, maxBytes, signal });
  } finally {
    await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}


export async function ensureConversationArchiveV2({
  chatDir, chatId, throughTurn = 1, archiveVersion = 1, maxBytes, signal,
}) {
  if (Number(archiveVersion) >= 2) {
    const filePath = attachmentBinPath(chatDir, chatId);
    if (!(await pathExists(filePath))) await createEmptyZip(filePath);
    return { bytes: (await fsp.stat(filePath)).size, archiveVersion: 2 };
  }
  const result = await buildConversationArchive({
    chatDir, chatId, archiveVersion, throughTurn,
    replacementTurnNo: null, replacementZip: null, maxBytes, signal,
  });
  return { ...result, archiveVersion: 2 };
}

export async function compressPendingTurnAttachments({
  chatDir, chatId, turnNumber, archiveVersion = 2, maxBytes, signal,
}) {
  const pending = pendingTurnDir(chatDir, chatId, turnNumber);
  const work = path.join(workRoot(chatDir), `${chatId}-turn-${turnNumber}-${randomUUID()}`);
  const sourceDirectory = path.join(work, 'source');
  const turnZip = path.join(work, `${turnNumber}.zip`);
  await fsp.mkdir(sourceDirectory, { recursive: true, mode: 0o700 });
  let manifest = null;
  let completed = false;
  try {
    try {
      manifest = JSON.parse(await fsp.readFile(path.join(pending, 'manifest.json'), 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }

    if (manifest) {
      for (const item of manifest) {
        if (signal?.aborted) throw abortError(signal.reason);
        await copyOrLink(path.join(pending, item.storedName), path.join(sourceDirectory, item.zipName));
      }
      if (manifest.length) {
        await runZip9({
          cwd: sourceDirectory,
          names: manifest.map((item) => item.zipName),
          destination: turnZip,
          maxBytes,
          signal,
        });
      } else {
        await createEmptyZip(turnZip);
      }
    } else if (Number(archiveVersion) >= 2) {
      const recovered = await extractZipEntryToFile(
        attachmentBinPath(chatDir, chatId), `${turnNumber}.zip`, turnZip, signal,
      );
      if (!recovered) await createEmptyZip(turnZip);
      manifest = [];
    } else if (turnNumber === 1 && await pathExists(attachmentBinPath(chatDir, chatId))) {
      await copyOrLink(attachmentBinPath(chatDir, chatId), turnZip);
      manifest = [];
    } else {
      await createEmptyZip(turnZip);
      manifest = [];
    }

    const turnBytes = (await fsp.stat(turnZip)).size;
    if (turnBytes > maxBytes) {
      throw Object.assign(new Error(`本轮附件压缩后超过 ${maxBytes} 字节限制`), { code: 'COMPRESSED_LIMIT' });
    }
    const outer = await buildConversationArchive({
      chatDir, chatId, archiveVersion, throughTurn: turnNumber,
      replacementTurnNo: turnNumber, replacementZip: turnZip, maxBytes, signal,
    });
    completed = true;
    return { bytes: turnBytes, outerBytes: outer.bytes, manifest, archiveVersion: 2 };
  } finally {
    // Retain raw pending files when compression fails or is interrupted. This
    // keeps an edited/retried turn tied to the exact attachments originally
    // uploaded instead of silently producing an empty ZIP.
    if (completed) {
      await fsp.rm(pending, { recursive: true, force: true }).catch(() => {});
      await fsp.rm(path.dirname(pending), { recursive: false }).catch(() => {});
    }
    await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

export async function truncateConversationArchive({
  chatDir, chatId, throughTurn, archiveVersion = 2, maxBytes, signal,
}) {
  const outer = attachmentBinPath(chatDir, chatId);
  if (!(await pathExists(outer))) return createEmptyZip(outer);
  if (Number(archiveVersion) < 2) {
    if (throughTurn >= 1) return { bytes: (await fsp.stat(outer)).size, archiveVersion: 1 };
    return createEmptyZip(outer);
  }
  const result = await buildConversationArchive({
    chatDir, chatId, archiveVersion: 2, throughTurn,
    replacementTurnNo: null, replacementZip: null, maxBytes, signal,
  });
  return { ...result, archiveVersion: 2 };
}

export async function materializeTurnAttachment({
  chatDir, chatId, turnNumber, archiveVersion = 2, signal,
}) {
  const outer = attachmentBinPath(chatDir, chatId);
  if (!(await pathExists(outer))) return null;
  await fsp.mkdir(downloadRoot(chatDir), { recursive: true, mode: 0o700 });
  const destination = path.join(downloadRoot(chatDir), `${chatId}-${turnNumber}-${randomUUID()}.zip`);
  if (Number(archiveVersion) < 2) {
    if (turnNumber !== 1) return null;
    await fsp.copyFile(outer, destination);
    return destination;
  }
  const extracted = await extractZipEntryToFile(outer, `${turnNumber}.zip`, destination, signal);
  return extracted ? destination : null;
}

export async function createConversationAttachmentBundle({
  chatDir, chatId, destination, archiveVersion = 2,
}) {
  const source = attachmentBinPath(chatDir, chatId);
  if (!(await pathExists(source))) await createEmptyZip(source);
  if (Number(archiveVersion) < 2) {
    const work = path.join(workRoot(chatDir), `${chatId}-legacy-wrap-${randomUUID()}`);
    await fsp.mkdir(work, { recursive: true, mode: 0o700 });
    try {
      await fsp.copyFile(source, path.join(work, '1.zip'));
      const result = await runZip9({ cwd: work, names: ['1.zip'], destination, maxBytes: Number.MAX_SAFE_INTEGER });
      return { path: destination, bytes: result.bytes };
    } finally {
      await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
    }
  }
  await fsp.copyFile(source, destination);
  return { path: destination, bytes: (await fsp.stat(destination)).size };
}

export async function deleteTurnFilesFrom(chatDir, chatId, turnNumber, options = {}) {
  const pendingRoot = path.join(chatDir, '.pending', chatId);
  const pendingEntries = await fsp.readdir(pendingRoot, { withFileTypes: true }).catch(() => []);
  await Promise.all(pendingEntries
    .filter((entry) => entry.isDirectory() && Number(entry.name) >= turnNumber)
    .map((entry) => fsp.rm(path.join(pendingRoot, entry.name), { recursive: true, force: true })));
  await fsp.rm(pendingRoot, { recursive: false }).catch(() => {});

  if (Number.isSafeInteger(options.throughTurn)) {
    await truncateConversationArchive({
      chatDir, chatId, throughTurn: options.throughTurn,
      archiveVersion: options.archiveVersion ?? 2,
      maxBytes: options.maxBytes ?? Number.MAX_SAFE_INTEGER,
      signal: options.signal,
    });
  }

  // Remove files produced by an early prerelease that used one permanent bin per turn.
  const entries = await fsp.readdir(chatDir, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries.filter((entry) => {
    const match = entry.isFile() && entry.name.startsWith(`${chatId}.turn-`)
      ? entry.name.match(/\.turn-(\d+)\.attachments\.bin$/) : null;
    return match && Number(match[1]) >= turnNumber;
  }).map((entry) => fsp.rm(path.join(chatDir, entry.name), { force: true })));
}

export async function deleteChatFiles(chatDir, id) {
  const entries = await fsp.readdir(chatDir, { withFileTypes: true }).catch(() => []);
  await Promise.all([
    fsp.rm(textBinPath(chatDir, id), { force: true }),
    fsp.rm(attachmentBinPath(chatDir, id), { force: true }),
    fsp.rm(path.join(chatDir, '.pending', id), { recursive: true, force: true }),
    ...entries.filter((entry) => entry.isFile() && entry.name.startsWith(`${id}.turn-`) && entry.name.endsWith('.attachments.bin'))
      .map((entry) => fsp.rm(path.join(chatDir, entry.name), { force: true })),
  ]);
  for (const root of [workRoot(chatDir), downloadRoot(chatDir), path.join(chatDir, '.transport')]) {
    const temporary = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
    await Promise.all(temporary.filter((entry) => entry.name.startsWith(`${id}-`))
      .map((entry) => fsp.rm(path.join(root, entry.name), { recursive: entry.isDirectory(), force: true })));
  }
}

export async function deleteAllChatBins(chatDir) {
  const entries = await fsp.readdir(chatDir, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries.filter((entry) => entry.isFile() && /\.(?:text|attachments)\.bin$/.test(entry.name))
    .map((entry) => fsp.rm(path.join(chatDir, entry.name), { force: true })));
  await Promise.all(['.pending', '.work', '.downloads', '.transport', '.uploads']
    .map((name) => fsp.rm(path.join(chatDir, name), { recursive: true, force: true })));
}

export async function cleanupStorageArtifacts(chatDir, validChatIds) {
  await Promise.all(['.uploads', '.work', '.downloads', '.transport']
    .map((name) => fsp.rm(path.join(chatDir, name), { recursive: true, force: true }).catch(() => {})));
  const entries = await fsp.readdir(chatDir, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries.filter((entry) => {
    if (!entry.isFile()) return false;
    if (entry.name.includes('.tmp-') || entry.name.includes('.rewrite-')) return true;
    const match = entry.name.match(/^([0-9a-f-]+)(?:\.turn-\d+)?\.(?:text|attachments)\.bin$/i);
    return Boolean(match && !validChatIds.has(match[1]));
  }).map((entry) => fsp.rm(path.join(chatDir, entry.name), { force: true })));

  const pendingRoot = path.join(chatDir, '.pending');
  const pendingChats = await fsp.readdir(pendingRoot, { withFileTypes: true }).catch(() => []);
  await Promise.all(pendingChats.filter((entry) => entry.isDirectory() && !validChatIds.has(entry.name))
    .map((entry) => fsp.rm(path.join(pendingRoot, entry.name), { recursive: true, force: true })));
}
