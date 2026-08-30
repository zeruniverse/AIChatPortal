const TOKEN_STORAGE_KEY = 'model-chat-login-token';

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export function getSavedToken() {
  try {
    return window.localStorage.getItem(TOKEN_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

export function saveToken(token) {
  try {
    if (token) window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
    else window.localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // The signed cookie still keeps the session when localStorage is unavailable.
  }
}

export async function apiFetch(url, options = {}) {
  const headers = {
    Accept: 'application/json',
    ...(options.headers || {}),
  };
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers,
  });
  if (response.status === 204) return null;
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json')
    ? await response.json()
    : { error: await response.text() };
  if (!response.ok) throw new ApiError(payload.error || `请求失败（${response.status}）`, response.status);
  return payload;
}

export function createChat({ prompt, modelId, files, shareEnabled, onProgress }) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('prompt', prompt);
    form.append('modelId', modelId);
    form.append('shareEnabled', shareEnabled ? 'true' : 'false');
    files.forEach((file) => form.append('attachments', file, file.name));

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/chats');
    xhr.responseType = 'json';
    xhr.withCredentials = true;
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded / event.total);
    });
    xhr.addEventListener('load', () => {
      const body = xhr.response || {};
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(new ApiError(body.error || `提交失败（${xhr.status}）`, xhr.status));
    });
    xhr.addEventListener('error', () => reject(new Error('网络错误，问题尚未成功提交')));
    xhr.addEventListener('abort', () => reject(new Error('上传已取消')));
    xhr.send(form);
  });
}

export function absoluteUrl(relativeUrl) {
  return relativeUrl ? new URL(relativeUrl, window.location.origin).href : '';
}

export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1000) return `${value} B`;
  const units = ['KB', 'MB', 'GB'];
  let amount = value;
  let index = -1;
  do {
    amount /= 1000;
    index += 1;
  } while (amount >= 1000 && index < units.length - 1);
  return `${amount >= 10 ? amount.toFixed(1) : amount.toFixed(2)} ${units[index]}`;
}

export function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}
