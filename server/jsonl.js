import fsp from 'node:fs/promises';

export async function ensureTrailingNewline(filePath) {
  const handle = await fsp.open(filePath, 'r+');
  try {
    const stat = await handle.stat();
    if (stat.size === 0) return;
    const lastByte = Buffer.allocUnsafe(1);
    await handle.read(lastByte, 0, 1, stat.size - 1);
    if (lastByte[0] !== 0x0a) {
      await handle.write(Buffer.from('\n'), 0, 1, stat.size);
      await handle.sync();
    }
  } finally {
    await handle.close();
  }
}
