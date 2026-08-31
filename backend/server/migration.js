import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { safeFilename, titleFromQuestion } from './utils.js';

function tableExists(db, name) {
  return Boolean(db.raw.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}
function zipEntries(filePath) {
  const result = spawnSync('unzip', ['-Z1', filePath], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  if (result.status !== 0) return null;
  return result.stdout.split(/\r?\n/).filter(Boolean);
}

function tarXzEntries(filePath) {
  const result = spawnSync('tar', ['-tJf', filePath], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  if (result.status !== 0) return null;
  return result.stdout.split(/\r?\n/).filter(Boolean);
}

function hasFiles(entries) {
  return Boolean(entries?.some((name) => !name.endsWith('/')));
}

async function runProcess(command, args, { cwd } = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${command} 失败：${stderr.trim()}`)));
  });
}

async function extractEntry(zipPath, entry, target) {
  await new Promise((resolve, reject) => {
    const child = spawn('unzip', ['-p', zipPath, entry], { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = fs.createWriteStream(target, { mode: 0o600 });
    let stderr = '';
    let processDone = false;
    let outputDone = false;
    const finish = () => { if (processDone && outputDone) resolve(); };
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.pipe(out);
    child.on('error', reject);
    out.on('error', reject);
    out.on('finish', () => { outputDone = true; finish(); });
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`无法解压旧附件 ${entry}：${stderr}`));
      processDone = true;
      finish();
    });
  });
}

async function convertZipToTarXz(filePath) {
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const tempDir = `${filePath}.${suffix}.dir`;
  const tempArchive = `${filePath}.${suffix}.tar.xz`;
  await fs.promises.rm(tempDir, { recursive: true, force: true });
  await fs.promises.mkdir(tempDir, { recursive: true });
  try {
    await runProcess('unzip', ['-q', filePath, '-d', tempDir]);
    await runProcess('tar', ['-I', 'xz -8', '-cf', tempArchive, '.'], { cwd: tempDir });
    await fs.promises.rename(tempArchive, filePath);
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
    await fs.promises.rm(tempArchive, { force: true });
  }
}

async function ensureTarXzArchive(filePath) {
  let entries = tarXzEntries(filePath);
  if (entries) return entries;
  if (!zipEntries(filePath)) return null;
  await convertZipToTarXz(filePath);
  entries = tarXzEntries(filePath);
  return entries;
}

function normalizeTurn(turn, fallbackNo) {
  return {
    turnNo: Number(turn.turnNo ?? turn.turn_no ?? turn.round ?? fallbackNo) || fallbackNo,
    question: String(turn.question ?? turn.prompt ?? turn.user ?? turn.userText ?? ''),
    answer: String(turn.answer ?? turn.response ?? turn.assistant ?? turn.assistantText ?? ''),
    createdAt: Number(turn.createdAt ?? turn.created_at ?? Date.now()) || Date.now(),
    updatedAt: Number(turn.updatedAt ?? turn.updated_at ?? turn.createdAt ?? turn.created_at ?? Date.now()) || Date.now()
  };
}

function parseLegacyText(raw, legacyRows = []) {
  try {
    const value = JSON.parse(raw);
    if (value && Array.isArray(value.turns)) return { version: 2, conversationId: value.conversationId || value.id, turns: value.turns.map(normalizeTurn).sort((a,b) => a.turnNo-b.turnNo) };
    if (Array.isArray(value)) return { version: 2, turns: value.map(normalizeTurn).sort((a,b) => a.turnNo-b.turnNo) };
    if (value && (value.question !== undefined || value.answer !== undefined)) return { version: 2, turns: [normalizeTurn(value, 1)] };
  } catch {}
  const map = new Map();
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const no = Number(event.turnNo ?? event.turn_no ?? event.round ?? event.sequence ?? 1) || 1;
    if (!map.has(no)) map.set(no, normalizeTurn({ turnNo: no }, no));
    const target = map.get(no);
    const type = String(event.type ?? event.kind ?? event.role ?? '').toLowerCase();
    const content = String(event.content ?? event.text ?? event.delta ?? event.question ?? event.answer ?? '');
    if (/question|prompt|user/.test(type) || event.question !== undefined) target.question = String(event.question ?? content);
    else if (/chunk|delta/.test(type)) target.answer += content;
    else if (/answer|assistant|response/.test(type) || event.answer !== undefined) target.answer = String(event.answer ?? event.response ?? content);
  }
  for (const row of legacyRows) {
    const no = Number(row.turn_no) || 1;
    const legacy = normalizeTurn(row, no);
    if (!map.has(no)) map.set(no, legacy);
    else {
      const target = map.get(no);
      if (!target.question) target.question = legacy.question;
      if (!target.answer) target.answer = legacy.answer;
    }
  }
  return { version: 2, turns: [...map.values()].sort((a,b) => a.turnNo-b.turnNo) };
}

async function normalizeConversationText(db, storage, conversation, defaultModelId, legacyRows) {
  const filePath = storage.textPath(conversation.id);
  let raw = '';
  try { raw = await fs.promises.readFile(filePath, 'utf8'); } catch {}
  let data = parseLegacyText(raw, legacyRows);
  data.conversationId = conversation.id;
  const dbTurns = db.listTurns(conversation.id);
  const byNo = new Map(data.turns.map((turn) => [turn.turnNo, turn]));
  for (const turn of dbTurns) {
    if (!byNo.has(turn.turn_no)) {
      const legacy = legacyRows.find((row) => Number(row.turn_no) === turn.turn_no);
      byNo.set(turn.turn_no, normalizeTurn(legacy || { turnNo: turn.turn_no }, turn.turn_no));
    }
  }
  for (const turn of byNo.values()) {
    if (!db.getTurn(conversation.id, turn.turnNo)) {
      const stamp = turn.createdAt || Date.now();
      db.raw.prepare('INSERT OR IGNORE INTO turns(conversation_id,turn_no,model_id,status,has_attachments,attachment_ready,attachment_size,upload_id,attempt,created_at,updated_at) VALUES(?,?,?,?,0,0,0,NULL,1,?,?)').run(conversation.id, turn.turnNo, defaultModelId, 'completed', stamp, turn.updatedAt || stamp);
    }
  }
  data.turns = [...byNo.values()].sort((a,b) => a.turnNo-b.turnNo);
  await storage.writeText(conversation.id, data);
  const firstQuestion = data.turns[0]?.question?.trim();
  if (firstQuestion && (!conversation.title || conversation.title === '旧对话')) db.raw.prepare('UPDATE conversations SET title=? WHERE id=?').run(titleFromQuestion(firstQuestion), conversation.id);
}

async function migrateAttachments(db, storage, conversation) {
  const legacy = path.join(storage.chatDir, `${conversation.id}.attachments.bin`);
  if (fs.existsSync(legacy)) {
    const entries = zipEntries(legacy);
    if (entries) {
      const numbered = entries.map((entry) => ({ entry, match: entry.match(/(?:^|\/)(\d+)\.zip$/) })).filter((item) => item.match);
      if (numbered.length) {
        for (const item of numbered) {
          const turnNo = Number(item.match[1]);
          const target = storage.attachmentPath(conversation.id, turnNo);
          await extractEntry(legacy, item.entry, target);
          const innerEntries = await ensureTarXzArchive(target);
          if (!hasFiles(innerEntries)) {
            await fs.promises.rm(target, { force: true });
            db.raw.prepare('UPDATE turns SET has_attachments=0,attachment_ready=0,attachment_size=0 WHERE conversation_id=? AND turn_no=?').run(conversation.id, turnNo);
          } else {
            const size = (await fs.promises.stat(target)).size;
            db.raw.prepare('UPDATE turns SET has_attachments=1,attachment_ready=1,attachment_size=? WHERE conversation_id=? AND turn_no=?').run(size, conversation.id, turnNo);
          }
        }
      } else if (hasFiles(entries)) {
        const target = storage.attachmentPath(conversation.id, 1);
        await fs.promises.copyFile(legacy, target);
        const innerEntries = await ensureTarXzArchive(target);
        if (hasFiles(innerEntries)) {
          const size = (await fs.promises.stat(target)).size;
          db.raw.prepare('UPDATE turns SET has_attachments=1,attachment_ready=1,attachment_size=? WHERE conversation_id=? AND turn_no=1').run(size, conversation.id);
        } else {
          await fs.promises.rm(target, { force: true });
          db.raw.prepare('UPDATE turns SET has_attachments=0,attachment_ready=0,attachment_size=0 WHERE conversation_id=? AND turn_no=1').run(conversation.id);
        }
      }
    }
    await fs.promises.rm(legacy, { force: true });
  }
  for (const turn of db.listTurns(conversation.id)) {
    const target = storage.attachmentPath(conversation.id, turn.turn_no);
    if (!fs.existsSync(target)) {
      if (turn.attachment_ready) db.raw.prepare('UPDATE turns SET has_attachments=0,attachment_ready=0,attachment_size=0 WHERE conversation_id=? AND turn_no=?').run(conversation.id, turn.turn_no);
      continue;
    }
    const entries = await ensureTarXzArchive(target);
    if (!hasFiles(entries)) {
      await fs.promises.rm(target, { force: true });
      db.raw.prepare('UPDATE turns SET has_attachments=0,attachment_ready=0,attachment_size=0 WHERE conversation_id=? AND turn_no=?').run(conversation.id, turn.turn_no);
    } else {
      const size = (await fs.promises.stat(target)).size;
      db.raw.prepare('UPDATE turns SET has_attachments=1,attachment_ready=1,attachment_size=? WHERE conversation_id=? AND turn_no=?').run(size, conversation.id, turn.turn_no);
    }
  }
}

export async function migrateLegacyStorage({ db, storage, config }) {
  const defaultOwner = config.auth.legacyOwnerId || config.auth.users[0].id;
  const defaultModel = config.models[0].id;
  const known = new Set(db.raw.prepare('SELECT id FROM conversations').all().map((row) => row.id));
  const files = await fs.promises.readdir(storage.chatDir).catch(() => []);
  for (const name of files) {
    const match = name.match(/^(.+)\.text\.bin$/);
    if (!match || known.has(match[1])) continue;
    const id = safeFilename(match[1]).replace(/[^A-Za-z0-9_-]/g, '');
    if (!id) continue;
    const stamp = (await fs.promises.stat(path.join(storage.chatDir, name))).mtimeMs || Date.now();
    db.raw.prepare('INSERT OR IGNORE INTO conversations(id,owner_id,title,share_enabled,share_token,created_at,updated_at) VALUES(?,?,?,0,NULL,?,?)').run(id, defaultOwner, '旧对话', stamp, stamp);
    db.raw.prepare('INSERT OR IGNORE INTO turns(conversation_id,turn_no,model_id,status,has_attachments,attachment_ready,attachment_size,upload_id,attempt,created_at,updated_at) VALUES(?,?,?,\'completed\',0,0,0,NULL,1,?,?)').run(id, 1, defaultModel, stamp, stamp);
    known.add(id);
  }
  const legacyTextRows = tableExists(db, '_v6_legacy_text') ? db.raw.prepare('SELECT * FROM _v6_legacy_text ORDER BY conversation_id,turn_no').all() : [];
  for (const conversation of db.raw.prepare('SELECT * FROM conversations').all()) {
    await normalizeConversationText(db, storage, conversation, defaultModel, legacyTextRows.filter((row) => row.conversation_id === conversation.id));
    await migrateAttachments(db, storage, conversation);
  }
  if (tableExists(db, '_v6_legacy_text')) db.raw.exec('DROP TABLE _v6_legacy_text');
}
