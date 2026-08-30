import fs from 'node:fs';
import { once } from 'node:events';

export function base64EncodedLength(byteLength) {
  return 4 * Math.ceil(byteLength / 3);
}

export async function* concatenateBinarySources(buffers, filePaths) {
  for (const buffer of buffers) {
    if (buffer?.length) yield buffer;
  }
  for (const filePath of filePaths) {
    for await (const chunk of fs.createReadStream(filePath)) {
      yield chunk;
    }
  }
}

export async function* encodeBase64(source) {
  let carry = Buffer.alloc(0);
  for await (const chunkLike of source) {
    const chunk = Buffer.isBuffer(chunkLike) ? chunkLike : Buffer.from(chunkLike);
    const data = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    const completeLength = data.length - (data.length % 3);
    if (completeLength > 0) {
      yield data.subarray(0, completeLength).toString('base64');
    }
    carry = completeLength < data.length ? data.subarray(completeLength) : Buffer.alloc(0);
  }
  if (carry.length) yield carry.toString('base64');
}

export async function writeWithBackpressure(writable, chunk) {
  if (!writable.write(chunk)) await once(writable, 'drain');
}
