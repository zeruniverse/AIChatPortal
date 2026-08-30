function collectSecrets(config) {
  const secrets = new Set();
  if (config?.provider?.key) secrets.add(String(config.provider.key));
  for (const [name, value] of Object.entries(config?.provider?.extraHeaders || {})) {
    if (/(?:authorization|api[-_]?key|token|secret|cookie)/i.test(name) && value !== undefined && value !== null) {
      const text = String(value);
      if (text) secrets.add(text);
      const bearer = text.match(/^Bearer\s+(.+)$/i)?.[1];
      if (bearer) secrets.add(bearer);
    }
  }
  try {
    const url = new URL(config?.provider?.url || '');
    if (url.username) secrets.add(decodeURIComponent(url.username));
    if (url.password) secrets.add(decodeURIComponent(url.password));
    for (const [name, value] of url.searchParams) {
      if (/(?:key|token|secret|signature|sig)/i.test(name) && value) secrets.add(value);
    }
  } catch {
    // URL validity is checked by config loading.
  }
  return [...secrets].filter((secret) => secret.length >= 3).sort((a, b) => b.length - a.length);
}

export function redactProviderSecrets(message, config) {
  let result = String(message || '未知错误');
  for (const secret of collectSecrets(config)) {
    result = result.split(secret).join('[REDACTED]');
  }
  return result.slice(0, 4000);
}
