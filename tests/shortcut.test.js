import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldSubmit } from '../frontend/src/utils/shortcut.js';
const base = { key: 'Enter', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, isComposing: false, keyCode: 13 };
test('Ctrl+Enter submits', () => assert.equal(shouldSubmit({ ...base, ctrlKey: true }), true));
test('Cmd+Enter submits', () => assert.equal(shouldSubmit({ ...base, metaKey: true }), true));
test('plain Enter does not submit', () => assert.equal(shouldSubmit(base), false));
test('Shift+Enter does not submit', () => assert.equal(shouldSubmit({ ...base, ctrlKey: true, shiftKey: true }), false));
test('IME composition does not submit', () => assert.equal(shouldSubmit({ ...base, ctrlKey: true, isComposing: true }), false));
