import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureTrailingNewline } from '../server/jsonl.js';

test('崩溃留下半行时，下一次追加前会补上换行分隔', async () => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'chat-jsonl-test-'));
  const filePath = path.join(directory, 'chat.text.bin');
  try {
    await fsp.writeFile(filePath, '{"type":"user"}\n{"type":"assistant_delta"');
    await ensureTrailingNewline(filePath);
    await fsp.appendFile(filePath, '{"type":"attempt_start"}\n');
    const raw = await fsp.readFile(filePath, 'utf8');
    assert.equal(raw, '{"type":"user"}\n{"type":"assistant_delta"\n{"type":"attempt_start"}\n');
    assert.equal(fs.statSync(filePath).size, Buffer.byteLength(raw));
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
});
