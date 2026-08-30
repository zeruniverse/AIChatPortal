import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const now = () => Date.now();
export const randomId = () => crypto.randomUUID();
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
export const hmac = (secret, value) => crypto.createHmac('sha256', secret).update(value).digest('base64url');

export function timingSafeEqualText(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

export function safeFilename(input, fallback = 'file') {
  let name = path.basename(String(input || fallback).replace(/\\/g, '/'));
  name = name.normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, '').replace(/[<>:"/\\|?*]/g, '_').trim();
  if (!name || name === '.' || name === '..') name = fallback;
  const ext = path.extname(name).slice(0, 32);
  let base = path.basename(name, path.extname(name)).slice(0, 160);
  if (!base) base = fallback;
  return `${base}${ext}`.slice(0, 200);
}

export async function ensureDir(dir) {
  await fs.promises.mkdir(dir, { recursive: true });
}

export async function pathSize(target) {
  let total = 0;
  let entries;
  try {
    entries = await fs.promises.readdir(target, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
  for (const entry of entries) {
    const p = path.join(target, entry.name);
    if (entry.isDirectory()) total += await pathSize(p);
    else if (entry.isFile()) total += (await fs.promises.stat(p)).size;
  }
  return total;
}

export async function removePath(target) {
  await fs.promises.rm(target, { recursive: true, force: true });
}

export function redactSecrets(text, config) {
  let value = String(text ?? '未知错误');
  const sensitiveHeaderValues = Object.entries(config?.provider?.headers || {}).filter(([name]) => /authorization|api[-_]?key|token|secret|cookie/i.test(name)).map(([, headerValue]) => String(headerValue));
  const secrets = [config?.provider?.key, ...(config?.auth?.users || []).map((u) => u.token), ...sensitiveHeaderValues].filter(Boolean);
  try {
    const providerUrl = new URL(config?.provider?.url);
    if (providerUrl.username) secrets.push(decodeURIComponent(providerUrl.username));
    if (providerUrl.password) secrets.push(decodeURIComponent(providerUrl.password));
  } catch {}
  for (const secret of secrets) value = value.split(secret).join('[REDACTED]');
  value = value
    .replace(/(authorization\s*[:=]\s*)(bearer\s+)?[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/((?:api[-_]?key|token|secret|cookie)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/([?&](?:key|token|secret|api_key)=)[^&#\s]+/gi, '$1[REDACTED]');
  return value.slice(0, 8000);
}

export function json(res, status, payload, headers = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(body);
}

export function text(res, status, body, headers = {}) {
  const data = Buffer.from(String(body));
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': data.length,
    ...headers
  });
  res.end(data);
}

export async function readJson(req, maxBytes = 2_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error('请求体过大');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('JSON 格式无效');
    error.statusCode = 400;
    throw error;
  }
}

export function contentDisposition(filename) {
  const ascii = safeFilename(filename).replace(/[^\x20-\x7e]/g, '_');
  return `attachment; filename="${ascii.replace(/["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function titleFromQuestion(question) {
  return String(question).replace(/\s+/g, ' ').trim().slice(0, 120) || '未命名问题';
}

export function isTerminal(status) {
  return status === 'completed' || status === 'error';
}
