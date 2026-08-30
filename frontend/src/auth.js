import { reactive } from 'vue';
import { api } from './api.js';

export const authState = reactive({ ready: false, authenticated: false, user: null });
let initPromise;

export async function initAuth() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      let result = await api('/api/auth/me');
      if (!result.authenticated) {
        const saved = localStorage.getItem('chat-login-token');
        if (saved) {
          try { result = await api('/api/auth/login', { method: 'POST', body: { token: saved } }); }
          catch { localStorage.removeItem('chat-login-token'); }
        }
      }
      authState.authenticated = Boolean(result.authenticated);
      authState.user = result.user || null;
    } finally { authState.ready = true; }
  })();
  return initPromise;
}

export async function login(token) {
  const result = await api('/api/auth/login', { method: 'POST', body: { token } });
  localStorage.setItem('chat-login-token', token);
  authState.authenticated = true;
  authState.user = result.user;
}

export async function logout() {
  try { await api('/api/auth/logout', { method: 'POST' }); } finally {
    localStorage.removeItem('chat-login-token');
    authState.authenticated = false;
    authState.user = null;
  }
}
