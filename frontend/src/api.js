import { apiUrl } from './runtimeConfig.js';

export const ACCESS_TOKEN_STORAGE_KEY = 'chat-login-token';

export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

export function getAccessToken() {
  return localStorage.getItem(ACCESS_TOKEN_STORAGE_KEY) || '';
}

export function setAccessToken(token) {
  if (token) localStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, token);
  else localStorage.removeItem(ACCESS_TOKEN_STORAGE_KEY);
}

export function addAuthHeader(headers = {}) {
  const result = { ...headers };
  const token = getAccessToken();
  if (token && !result.Authorization) result.Authorization = `Bearer ${token}`;
  return result;
}

export async function api(path, options = {}) {
  let headers = { ...(options.headers || {}) };
  let body = options.body;
  if (body != null && !(body instanceof Blob) && !(body instanceof ArrayBuffer) && typeof body !== 'string') {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  if (options.auth !== false) headers = addAuthHeader(headers);
  const { auth, ...fetchOptions } = options;
  const response = await fetch(apiUrl(path), { ...fetchOptions, credentials: 'omit', headers, body });
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json().catch(() => ({})) : await response.text();
  if (!response.ok) throw new ApiError(payload?.error || payload || `HTTP ${response.status}`, response.status);
  return payload;
}

export function openEventStream(path, handlers = {}, options = {}) {
  const controller = new AbortController();
  let closed = false;

  (async () => {
    try {
      let headers = { Accept: 'text/event-stream' };
      if (options.auth !== false) headers = addAuthHeader(headers);
      const response = await fetch(apiUrl(path), { headers, credentials: 'omit', cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new ApiError(`SSE HTTP ${response.status}`, response.status);
      const reader = response.body?.getReader();
      if (!reader) throw new Error('浏览器不支持流式响应');
      const decoder = new TextDecoder();
      let buffer = '';
      while (!closed) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let split;
        while ((split = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          let event = 'message';
          const data = [];
          for (const line of block.split('\n')) {
            if (line.startsWith(':')) continue;
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
          }
          const callback = handlers[event];
          if (callback) callback({ type: event, data: data.join('\n') });
        }
      }
      if (!closed) handlers.error?.(new Error('事件流已断开'));
    } catch (error) {
      if (!closed && error?.name !== 'AbortError') handlers.error?.(error);
    }
  })();

  return { close() { closed = true; controller.abort(); } };
}
