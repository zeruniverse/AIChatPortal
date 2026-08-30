export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

export async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  let body = options.body;
  if (body != null && !(body instanceof Blob) && !(body instanceof ArrayBuffer) && typeof body !== 'string') {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  const response = await fetch(path, { credentials: 'same-origin', ...options, headers, body });
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json().catch(() => ({})) : await response.text();
  if (!response.ok) throw new ApiError(payload?.error || payload || `HTTP ${response.status}`, response.status);
  return payload;
}
