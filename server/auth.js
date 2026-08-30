import { hmac, sha256, timingSafeEqualText } from './utils.js';

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const i = part.indexOf('=');
    if (i < 0) return [part, ''];
    const raw = part.slice(i + 1);
    try { return [part.slice(0, i), decodeURIComponent(raw)]; }
    catch { return [part.slice(0, i), raw]; }
  }));
}

export function createAuth(config) {
  const usersById = new Map(config.auth.users.map((u) => [u.id, u]));
  function findByToken(token) {
    for (const user of config.auth.users) if (timingSafeEqualText(user.token, token || '')) return user;
    return null;
  }
  function encodeSession(user) {
    const payload = Buffer.from(JSON.stringify({ uid: user.id, fp: sha256(user.token).slice(0, 24) })).toString('base64url');
    return `${payload}.${hmac(config.auth.sessionSecret, payload)}`;
  }
  function decodeSession(value) {
    if (!value || !value.includes('.')) return null;
    const [payload, signature] = value.split('.', 2);
    if (!timingSafeEqualText(hmac(config.auth.sessionSecret, payload), signature)) return null;
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      const user = usersById.get(data.uid);
      if (!user || data.fp !== sha256(user.token).slice(0, 24)) return null;
      return user;
    } catch { return null; }
  }
  function currentUser(req) {
    const cookies = parseCookies(req.headers.cookie || '');
    return decodeSession(cookies[config.auth.cookieName]);
  }
  function cookie(value, clear = false) {
    const parts = [`${config.auth.cookieName}=${encodeURIComponent(value || '')}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
    if (clear) parts.push('Max-Age=0'); else parts.push(`Max-Age=${60 * 60 * 24 * 3650}`);
    return parts.join('; ');
  }
  return { findByToken, currentUser, encodeSession, cookie };
}
