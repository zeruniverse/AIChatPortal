import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const uploader = fs.readFileSync(new URL('../frontend/src/components/AttachmentUploader.vue', import.meta.url), 'utf8');
const history = fs.readFileSync(new URL('../frontend/src/views/HistoryView.vue', import.meta.url), 'utf8');
const login = fs.readFileSync(new URL('../frontend/src/views/LoginView.vue', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../frontend/src/styles.css', import.meta.url), 'utf8');

test('attachment uploader uses reactive per-file state so progress and ready state update', () => {
  assert.match(uploader, /import \{[^}]*reactive[^}]*\} from 'vue'/);
  assert.match(uploader, /const local = reactive\(\{/);
  assert.match(uploader, /xhr\.send\(file\)/);
  assert.match(uploader, /xhr\.upload\.onprogress/);
});

test('history actions are in the same header action group', () => {
  const group = history.match(/<div class=\"header-actions\">([\s\S]*?)<\/div>/)?.[1] || '';
  assert.match(group, /删除全部提问/);
  assert.match(group, /新建提问/);
});

test('password visibility button is non-wrapping and has reserved width', () => {
  assert.match(login, /password-toggle/);
  assert.match(css, /\.password-toggle\s*\{[^}]*min-width:\s*72px;[^}]*white-space:\s*nowrap;/s);
});


test('conversation delete button never wraps', () => {
  assert.match(css, /\.conversation-header > \.button\s*\{[^}]*flex:\s*0 0 auto;[^}]*min-width:\s*max-content;[^}]*white-space:\s*nowrap;/s);
});
