import { reactive } from 'vue';
import { ACCESS_TOKEN_STORAGE_KEY, api, setAccessToken } from './api.js';

export const authState = reactive({ ready: false, authenticated: false, user: null });
let initPromise;

export async function initAuth() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      const saved = localStorage.getItem(ACCESS_TOKEN_STORAGE_KEY);
      if (!saved) {
        authState.authenticated = false;
        authState.user = null;
        return;
      }
      try {
        const result = await api('/api/auth/me');
        authState.authenticated = Boolean(result.authenticated);
        authState.user = result.user || null;
        if (!result.authenticated) setAccessToken('');
      } catch {
        setAccessToken('');
        authState.authenticated = false;
        authState.user = null;
      }
    } finally { authState.ready = true; }
  })();
  return initPromise;
}

export async function login(token) {
  const result = await api('/api/auth/login', { method: 'POST', body: { token }, auth: false });
  setAccessToken(token);
  authState.authenticated = true;
  authState.user = result.user;
}

export async function logout() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
  setAccessToken('');
  authState.authenticated = false;
  authState.user = null;
}
