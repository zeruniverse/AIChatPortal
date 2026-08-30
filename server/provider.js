import fs from 'node:fs';
import { Readable } from 'node:stream';
import { redactSecrets } from './utils.js';

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && !Array.isArray(content)) content = [content];
  if (!Array.isArray(content)) return '';
  return content.map((item) => {
    if (typeof item === 'string') return item;
    if (!item || typeof item !== 'object') return '';
    if (typeof item.text === 'string') return item.text;
    const url = (typeof item.image_url === 'string' ? item.image_url : item.image_url?.url) || item.url || item.source?.url;
    if (url) return `\n![模型返回的图片](${url})\n`;
    return '';
  }).join('');
}

function extractErrorPayload(payload) {
  const error = payload?.error ?? payload;
  if (typeof error === 'string') return error;
  if (!error || typeof error !== 'object') return '';
  const parts = [];
  const message = error.message || error.detail || error.error_description;
  if (message) parts.push(String(message));
  if (error.type) parts.push(`type: ${error.type}`);
  if (error.code) parts.push(`code: ${error.code}`);
  return parts.join('；');
}

async function* concatBase64(paths) {
  let carry = Buffer.alloc(0);
  for (const filePath of paths) {
    for await (const chunk of fs.createReadStream(filePath, { highWaterMark: 128 * 1024 })) {
      const data = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const usable = data.length - (data.length % 3);
      if (usable) yield Buffer.from(data.subarray(0, usable).toString('base64'));
      carry = usable < data.length ? data.subarray(usable) : Buffer.alloc(0);
    }
  }
  if (carry.length) yield Buffer.from(carry.toString('base64'));
}

function makeStreamingJson(bodyObject, imagePaths, marker) {
  const serialized = JSON.stringify(bodyObject).replace(marker, `data:image/jpeg;base64,${marker}`);
  const index = serialized.indexOf(marker);
  if (index < 0) throw new Error('无法构造图片请求体');
  const before = Buffer.from(serialized.slice(0, index));
  const after = Buffer.from(serialized.slice(index + marker.length));
  const totalBytes = imagePaths.reduce((sum, p) => sum + fs.statSync(p).size, 0);
  const base64Bytes = 4 * Math.ceil(totalBytes / 3);
  let resolveBodyDone;
  const bodyDone = new Promise((resolve) => { resolveBodyDone = resolve; });
  async function* generator() {
    try {
      yield before;
      yield* concatBase64(imagePaths);
      yield after;
    } finally { resolveBodyDone(); }
  }
  return { body: Readable.from(generator()), contentLength: before.length + base64Bytes + after.length, bodyDone };
}

function buildBody(config, model, prompt, imagePaths) {
  const messages = [];
  if (imagePaths?.length) {
    messages.push({
      role: 'system',
      content: '附图的 JPEG 结束标记后拼接了一个 ZIP，生成方式等价于 cat x.jpg att.zip > xa.jpg。请读取原始图片字节，找到 JPEG EOI 后的 ZIP。外层 ZIP 内的 1.zip、2.zip……分别对应相应轮次上传的全部附件；没有附件的轮次不会有对应 ZIP。若无法读取尾随 ZIP，请明确说明，不要猜测附件内容。'
    });
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: '__IMAGE_MARKER__'.replace('__IMAGE_MARKER__', '__RUNTIME_MARKER__') } }
      ]
    });
  } else {
    messages.push({ role: 'user', content: prompt });
  }
  const body = { ...config.provider.extraBody, model, stream: true, messages };
  if (!imagePaths?.length) return { body: JSON.stringify(body), contentLength: null, bodyDone: Promise.resolve() };
  const runtimeMarker = `__IMAGE_${Date.now()}_${Math.random()}__`;
  body.messages[1].content[1].image_url.url = runtimeMarker;
  return makeStreamingJson(body, imagePaths, runtimeMarker);
}

export async function callProvider({ config, model, prompt, imagePaths = [], signal, onChunk, onRequestBodySent }) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.provider.key}`,
    ...config.provider.headers
  };
  const request = buildBody(config, model, prompt, imagePaths);
  void request.bodyDone.then(() => onRequestBodySent?.()).catch(() => {});
  if (request.contentLength != null) headers['Content-Length'] = String(request.contentLength);
  let response;
  try {
    response = await fetch(config.provider.url, {
      method: 'POST',
      headers,
      body: request.body,
      signal,
      duplex: request.body instanceof Readable ? 'half' : undefined
    });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error(redactSecrets(`provider 连接失败：${error.message}`, config));
  }

  if (!response.ok) {
    const raw = await response.text().catch(() => '');
    let detail = raw;
    try { detail = extractErrorPayload(JSON.parse(raw)) || raw; } catch {}
    throw new Error(redactSecrets(`provider HTTP ${response.status}：${detail || response.statusText}`, config));
  }

  const contentType = response.headers.get('content-type') || '';
  let full = '';
  if (!contentType.includes('text/event-stream')) {
    const raw = await response.text();
    let payload;
    try { payload = JSON.parse(raw); } catch { throw new Error('provider 返回了无法解析的响应'); }
    if (payload?.error) throw new Error(redactSecrets(`provider 错误：${extractErrorPayload(payload)}`, config));
    let text = contentToText(payload?.choices?.[0]?.message?.content ?? payload?.choices?.[0]?.text ?? payload?.output_text);
    const imageItems = payload?.choices?.[0]?.message?.images || payload?.images || payload?.data;
    if (Array.isArray(imageItems)) {
      const imageText = imageItems.map((item) => {
        const url = typeof item === 'string' ? item : item?.url || item?.image_url?.url || item?.image_url;
        return url ? `![模型返回的图片](${url})` : '';
      }).filter(Boolean).join('\n');
      text = [text, imageText].filter(Boolean).join('\n');
    }
    if (!text) throw new Error('provider 返回了空回答');
    await onChunk(text);
    return text;
  }

  const decoder = new TextDecoder();
  let buffer = '';
  async function consumeEvent(event) {
    for (const line of event.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let payload;
      try { payload = JSON.parse(data); } catch { continue; }
      if (payload?.error) throw new Error(redactSecrets(`provider 错误：${extractErrorPayload(payload)}`, config));
      const choice = payload?.choices?.[0] || {};
      const deltaObject = choice.delta || choice.message || {};
      let delta = contentToText(deltaObject.content ?? choice.text);
      const imageItems = deltaObject.images || choice.images || payload?.images || [];
      if (Array.isArray(imageItems) && imageItems.length) {
        const imageText = imageItems.map((item) => {
          const url = typeof item === 'string' ? item : item?.url || item?.image_url?.url || item?.image_url || item?.source?.url;
          return url ? `\n![模型返回的图片](${url})\n` : '';
        }).join('');
        delta += imageText;
      }
      if (delta) { full += delta; await onChunk(delta); }
    }
  }
  for await (const chunk of response.body) {
    buffer = (buffer + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, '\n');
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const event = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      await consumeEvent(event);
    }
  }
  buffer = (buffer + decoder.decode()).replace(/\r\n/g, '\n').trim();
  if (buffer) await consumeEvent(buffer);
  if (!full) throw new Error('provider 返回了空回答');
  return full;
}
