let runtimeConfig = null;

export async function loadRuntimeConfig() {
  if (runtimeConfig) return runtimeConfig;
  const response = await fetch('/config.json', { cache: 'no-store' });
  if (!response.ok) throw new Error(`无法读取前端配置：HTTP ${response.status}`);
  const config = await response.json();
  const baseUrl = String(config?.base_url || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error('frontend/public/config.json 中的 base_url 必须是完整的 HTTP/HTTPS URL');
  runtimeConfig = { base_url: baseUrl };
  return runtimeConfig;
}

export function getRuntimeConfig() {
  if (!runtimeConfig) throw new Error('前端配置尚未加载');
  return runtimeConfig;
}

export function apiUrl(pathname) {
  if (/^https?:\/\//i.test(String(pathname))) return String(pathname);
  const base = getRuntimeConfig().base_url;
  const path = String(pathname || '');
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}
