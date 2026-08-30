import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('full HTTP workflow', { timeout: 60_000 }, async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const child = spawn(process.execPath, ['tests/integration-run.mjs'], { cwd: root, stdio: ['ignore','pipe','pipe'] });
  let output=''; let error='';
  child.stdout.on('data',d=>output+=d); child.stderr.on('data',d=>error+=d);
  const code = await new Promise((resolve)=>child.on('close',resolve));
  assert.equal(code,0,`${output}\n${error}`);
  assert.match(output,/INTEGRATION OK/);
});
