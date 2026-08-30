import { reactive } from 'vue';
import { ApiError, apiFetch, getSavedToken, saveToken } from './api.js';

export const appState = reactive({
  config: null,
  loading: false,
  error: '',
  user: null,
  authChecked: false,
});

let authenticationPromise = null;

export async function loginWithToken(token) {
  const normalized = String(token || '').trim();
  if (!normalized) throw new Error('请输入 token');
  const result = await apiFetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: normalized }),
  });
  saveToken(normalized);
  appState.user = result.user;
  appState.authChecked = true;
  appState.error = '';
  return result.user;
}

export async function ensureAuthenticated(force = false) {
  if (appState.authChecked && !force) return Boolean(appState.user);
  if (authenticationPromise && !force) return authenticationPromise;

  authenticationPromise = (async () => {
    try {
      const result = await apiFetch('/api/auth/me');
      appState.user = result.user;
      appState.authChecked = true;
      return true;
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) throw error;
    }

    const savedToken = getSavedToken();
    if (savedToken) {
      try {
        await loginWithToken(savedToken);
        return true;
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 401) throw error;
      }
    }

    saveToken('');
    appState.user = null;
    appState.config = null;
    appState.authChecked = true;
    return false;
  })().finally(() => {
    authenticationPromise = null;
  });
  return authenticationPromise;
}

export async function logout() {
  try {
    await apiFetch('/api/auth/logout', { method: 'POST' });
  } finally {
    saveToken('');
    appState.user = null;
    appState.config = null;
    appState.authChecked = true;
    appState.error = '';
  }
}

export async function loadAppConfig(force = false) {
  if (appState.config && !force) return appState.config;
  appState.loading = true;
  appState.error = '';
  try {
    appState.config = await apiFetch('/api/config');
    return appState.config;
  } catch (error) {
    appState.error = error.message;
    throw error;
  } finally {
    appState.loading = false;
  }
}
