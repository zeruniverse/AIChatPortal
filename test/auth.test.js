import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuth } from '../server/auth.js';

function makeAuth(aliceToken = 'alice-login-token-0000001') {
  return createAuth({
    auth: {
      sessionSecret: 'test-session-secret-that-is-long-enough-0001',
      cookieSecure: false,
      users: [
        { id: 'alice', label: 'Alice', token: aliceToken },
        { id: 'bob', label: 'Bob', token: 'bob-login-token-000000002' },
      ],
    },
  });
}

test('登录 token 能映射到用户，但错误 token 不能通过', () => {
  const auth = makeAuth();
  assert.deepEqual(auth.findByToken('alice-login-token-0000001'), { id: 'alice', label: 'Alice' });
  assert.equal(auth.findByToken('wrong-token-value'), null);
});

test('签名持久 Cookie 可恢复用户且篡改后失效', () => {
  const auth = makeAuth();
  const headers = new Map();
  auth.setSession({ setHeader: (name, value) => headers.set(name, value) }, { id: 'alice' });
  const setCookie = headers.get('Set-Cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Max-Age=/);
  assert.doesNotMatch(setCookie, /; Secure/);

  const cookiePair = setCookie.split(';')[0];
  const request = { headers: { cookie: cookiePair, authorization: '' } };
  assert.deepEqual(auth.userFromRequest(request), { id: 'alice', label: 'Alice' });

  const tampered = `${cookiePair.slice(0, -1)}x`;
  assert.equal(auth.userFromRequest({ headers: { cookie: tampered, authorization: '' } }), null);
});


test('后端更换某用户 token 后，该用户旧签名 Cookie 会立即失效', () => {
  const original = makeAuth();
  const headers = new Map();
  original.setSession({ setHeader: (name, value) => headers.set(name, value) }, { id: 'alice' });
  const cookiePair = headers.get('Set-Cookie').split(';')[0];

  const rotated = makeAuth('alice-rotated-login-token-0002');
  assert.equal(rotated.userFromRequest({ headers: { cookie: cookiePair, authorization: '' } }), null);
  assert.deepEqual(
    rotated.findByToken('alice-rotated-login-token-0002'),
    { id: 'alice', label: 'Alice' },
  );
});
