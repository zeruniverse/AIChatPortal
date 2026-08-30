import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const COOKIE_NAME = 'model_chat_session';
const SESSION_VERSION = 'v2';
const SESSION_MAX_AGE_SECONDS = 10 * 365 * 24 * 60 * 60;

function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest();
}

function safeEqual(left, right) {
  const a = Buffer.isBuffer(left) ? left : Buffer.from(String(left));
  const b = Buffer.isBuffer(right) ? right : Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseCookies(header) {
  const cookies = new Map();
  for (const part of String(header || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!name) continue;
    try {
      cookies.set(name, decodeURIComponent(value));
    } catch {
      // Ignore malformed cookies rather than failing the whole request.
    }
  }
  return cookies;
}

function sessionSignature(payload, secret) {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('base64url');
}

function createSessionValue(user, secret) {
  const encodedUserId = Buffer.from(user.id, 'utf8').toString('base64url');
  const payload = `${SESSION_VERSION}.${encodedUserId}.${user.tokenFingerprint}`;
  return `${payload}.${sessionSignature(payload, secret)}`;
}

function verifySessionValue(value, secret) {
  const parts = String(value || '').split('.');
  if (parts.length !== 4 || parts[0] !== SESSION_VERSION) return null;
  const payload = `${parts[0]}.${parts[1]}.${parts[2]}`;
  const expected = sessionSignature(payload, secret);
  if (!safeEqual(parts[3], expected)) return null;
  try {
    const userId = Buffer.from(parts[1], 'base64url').toString('utf8');
    return userId ? { userId, tokenFingerprint: parts[2] } : null;
  } catch {
    return null;
  }
}

function serializeCookie(value, { secure = false, clear = false } = {}) {
  const attributes = [
    `${COOKIE_NAME}=${clear ? '' : encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${clear ? 0 : SESSION_MAX_AGE_SECONDS}`,
    'Priority=High',
  ];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}

export function createAuth(config) {
  const users = config.auth.users.map((user) => {
    const tokenDigest = sha256(user.token);
    return {
      id: user.id,
      label: user.label,
      tokenDigest,
      tokenFingerprint: createHmac('sha256', config.auth.sessionSecret)
        .update(tokenDigest)
        .digest('base64url'),
    };
  });
  const usersById = new Map(users.map((user) => [user.id, user]));

  function publicUser(user) {
    return user ? { id: user.id, label: user.label } : null;
  }

  function findByToken(token) {
    if (typeof token !== 'string' || !token) return null;
    const digest = sha256(token);
    let matched = null;
    // Always compare against every configured token so the matching position is not exposed by early return timing.
    for (const user of users) {
      if (safeEqual(digest, user.tokenDigest)) matched = user;
    }
    return publicUser(matched);
  }

  function userFromRequest(req) {
    const authorization = String(req.headers.authorization || '');
    if (authorization.startsWith('Bearer ')) {
      const matched = findByToken(authorization.slice(7).trim());
      if (matched) return matched;
    }

    const sessionValue = parseCookies(req.headers.cookie).get(COOKIE_NAME);
    const session = verifySessionValue(sessionValue, config.auth.sessionSecret);
    const user = session ? usersById.get(session.userId) : null;
    if (!user || !safeEqual(session.tokenFingerprint, user.tokenFingerprint)) return null;
    return publicUser(user);
  }

  function setSession(res, user) {
    const configuredUser = usersById.get(user.id);
    if (!configuredUser) throw new Error('无法为未配置用户创建会话');
    const value = createSessionValue(configuredUser, config.auth.sessionSecret);
    res.setHeader('Set-Cookie', serializeCookie(value, { secure: config.auth.cookieSecure }));
  }

  function clearSession(res) {
    res.setHeader('Set-Cookie', serializeCookie('', {
      secure: config.auth.cookieSecure,
      clear: true,
    }));
  }

  function requireAuth(req, res, next) {
    const user = userFromRequest(req);
    if (!user) {
      res.status(401).json({ error: '请先输入有效 token 登录' });
      return;
    }
    req.user = user;
    setSession(res, user);
    next();
  }

  return {
    clearSession,
    findByToken,
    requireAuth,
    setSession,
    userFromRequest,
  };
}
