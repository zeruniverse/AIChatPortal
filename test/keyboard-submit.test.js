import test from 'node:test';
import assert from 'node:assert/strict';
import { isSubmitShortcut, submitOnShortcut } from '../frontend/src/keyboard-submit.js';

function keyEvent(overrides = {}) {
  return {
    key: 'Enter',
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    isComposing: false,
    ...overrides,
  };
}

test('Ctrl+Enter 和 Cmd+Enter 会提交', () => {
  assert.equal(isSubmitShortcut(keyEvent({ ctrlKey: true })), true);
  assert.equal(isSubmitShortcut(keyEvent({ metaKey: true })), true);
});

test('Enter 和 Shift+Enter 不会提交，Ctrl/Cmd+Shift+Enter 也不会提交', () => {
  assert.equal(isSubmitShortcut(keyEvent()), false);
  assert.equal(isSubmitShortcut(keyEvent({ shiftKey: true })), false);
  assert.equal(isSubmitShortcut(keyEvent({ ctrlKey: true, shiftKey: true })), false);
  assert.equal(isSubmitShortcut(keyEvent({ metaKey: true, shiftKey: true })), false);
});

test('输入法组合阶段的 Ctrl/Cmd+Enter 不会误提交', () => {
  assert.equal(isSubmitShortcut(keyEvent({ ctrlKey: true, isComposing: true })), false);
  assert.equal(isSubmitShortcut(keyEvent({ metaKey: true, isComposing: true })), false);
});

test('命中快捷键时阻止 textarea 换行并只调用一次提交', () => {
  let prevented = 0;
  let submitted = 0;
  const event = keyEvent({ ctrlKey: true, preventDefault() { prevented += 1; } });
  assert.equal(submitOnShortcut(event, () => { submitted += 1; }), true);
  assert.equal(prevented, 1);
  assert.equal(submitted, 1);
});
