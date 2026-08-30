import test from 'node:test';
import assert from 'node:assert/strict';
import { writeClipboardText } from '../frontend/src/clipboard.js';

function replaceGlobal(name, value) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  return () => {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  };
}

test('普通 HTTP 环境直接使用无弹窗复制回退', async () => {
  let modernCalls = 0;
  let execCalls = 0;
  let removed = false;
  const textarea = {
    value: '',
    tabIndex: 0,
    className: '',
    setAttribute() {},
    focus() {},
    select() {},
    setSelectionRange() {},
    remove() { removed = true; },
  };
  const restoreWindow = replaceGlobal('window', { isSecureContext: false });
  const restoreNavigator = replaceGlobal('navigator', {
    clipboard: { async writeText() { modernCalls += 1; } },
  });
  const restoreDocument = replaceGlobal('document', {
    activeElement: null,
    body: { appendChild(node) { assert.equal(node, textarea); } },
    createElement(tag) { assert.equal(tag, 'textarea'); return textarea; },
    execCommand(command) { assert.equal(command, 'copy'); execCalls += 1; return true; },
  });
  try {
    assert.equal(await writeClipboardText('分享链接'), true);
    assert.equal(textarea.value, '分享链接');
    assert.equal(modernCalls, 0);
    assert.equal(execCalls, 1);
    assert.equal(removed, true);
  } finally {
    restoreDocument();
    restoreNavigator();
    restoreWindow();
  }
});
