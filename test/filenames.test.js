import test from 'node:test';
import assert from 'node:assert/strict';
import { safeZipName, uniqueZipNames } from '../server/filenames.js';

test('ZIP 文件名会移除 Unix 和 Windows 路径穿越片段', () => {
  assert.equal(safeZipName('../../secret.txt'), 'secret.txt');
  assert.equal(safeZipName('..\\..\\secret.txt'), 'secret.txt');
  assert.equal(safeZipName('folder\\nested/report.pdf'), 'report.pdf');
  assert.equal(safeZipName('..', 'attachment-1'), 'attachment-1');
});

test('ZIP 文件名会清理危险字符、限制长度并处理重名', () => {
  const names = uniqueZipNames([
    { originalName: 'a<b>.txt' },
    { originalName: 'A_B_.txt' },
    { originalName: `${'x'.repeat(300)}.log` },
  ]);
  assert.deepEqual(names.slice(0, 2), ['a_b_.txt', 'A_B_ (2).txt']);
  assert.ok(Array.from(names[2]).length <= 180);
  assert.ok(names[2].endsWith('.log'));
});
