let fallbackCounter = 0;

function fallbackBytes(target) {
  fallbackCounter = (fallbackCounter + 1) >>> 0;
  let seed = (Date.now() ^ fallbackCounter) >>> 0;
  if (typeof performance !== 'undefined' && Number.isFinite(performance.now())) {
    seed ^= Math.floor(performance.now() * 1000) >>> 0;
  }
  for (let index = 0; index < target.length; index += 1) {
    // xorshift32 plus Math.random prevents a repeated timestamp from producing
    // the same temporary ID in older HTTP-only browsers.
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    target[index] = (seed ^ Math.floor(Math.random() * 256)) & 0xff;
  }
  return target;
}

function randomBytes(length) {
  const bytes = new Uint8Array(length);
  const webCrypto = globalThis.crypto;
  if (webCrypto && typeof webCrypto.getRandomValues === 'function') {
    try {
      return webCrypto.getRandomValues(bytes);
    } catch {
      // Some older/in-app browsers expose crypto but reject it on HTTP.
    }
  }
  return fallbackBytes(bytes);
}

function bytesToUuidV4(bytes) {
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createClientConversationId() {
  const webCrypto = globalThis.crypto;
  if (webCrypto && typeof webCrypto.randomUUID === 'function') {
    try {
      return webCrypto.randomUUID();
    } catch {
      // randomUUID is a secure-context API and may throw/be unavailable on HTTP.
    }
  }
  return bytesToUuidV4(randomBytes(16));
}
