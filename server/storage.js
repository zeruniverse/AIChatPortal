import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, removePath } from './utils.js';

export function createStorage(rootDir) {
  const chatDir = path.join(rootDir, 'chat');
  const uploadDir = path.join(chatDir, '.uploads');
  const workDir = path.join(chatDir, '.work');
  const dbPath = path.join(chatDir, 'sqlite.db');

  const textPath = (conversationId) => path.join(chatDir, `${conversationId}.text.bin`);
  const attachmentPath = (conversationId, turnNo) => path.join(chatDir, `${conversationId}.turn-${turnNo}.attachments.bin`);
  const uploadPath = (uploadId) => path.join(uploadDir, uploadId);
  const workPath = (conversationId, turnNo, attempt) => path.join(workDir, `${conversationId}-${turnNo}-${attempt}`);

  async function init() {
    await ensureDir(chatDir);
    await ensureDir(uploadDir);
    await removePath(workDir);
    await ensureDir(workDir);
  }

  async function readText(conversationId) {
    try {
      return JSON.parse(await fs.promises.readFile(textPath(conversationId), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async function writeText(conversationId, value) {
    const target = textPath(conversationId);
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await fs.promises.writeFile(temp, JSON.stringify(value), { mode: 0o600 });
    await fs.promises.rename(temp, target);
  }

  async function deleteConversationFiles(conversationId) {
    await removePath(textPath(conversationId));
    const entries = await fs.promises.readdir(chatDir).catch(() => []);
    const prefix = `${conversationId}.turn-`;
    await Promise.all(entries.filter((name) => name.startsWith(prefix) && name.endsWith('.attachments.bin')).map((name) => removePath(path.join(chatDir, name))));
    const uploadEntries = await fs.promises.readdir(uploadDir).catch(() => []);
    await Promise.all(uploadEntries.filter((name) => name.startsWith(`${conversationId}-`)).map((name) => removePath(path.join(uploadDir, name))));
    const workEntries = await fs.promises.readdir(workDir).catch(() => []);
    await Promise.all(workEntries.filter((name) => name.startsWith(`${conversationId}-`)).map((name) => removePath(path.join(workDir, name))));
  }

  return { chatDir, uploadDir, workDir, dbPath, textPath, attachmentPath, uploadPath, workPath, init, readText, writeText, deleteConversationFiles };
}
