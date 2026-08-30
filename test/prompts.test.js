import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProviderPrompt } from '../server/prompts.js';

test('第一次提问保持用户原文，不伪造追问历史', () => {
  assert.equal(buildProviderPrompt({
    turnNo: 1,
    currentPrompt: '请总结附件',
    history: [],
    hasAnyAttachments: true,
  }), '请总结附件');
});

test('追问 prompt 包含当前内容、完整历史和编号附件包说明', () => {
  const prompt = buildProviderPrompt({
    turnNo: 3,
    currentPrompt: '请比较前两次结果',
    hasAnyAttachments: true,
    history: [
      { turnNo: 1, prompt: '第一次问题', answer: '第一次答案', error: null },
      { turnNo: 2, prompt: '第二次问题', answer: '', error: '第二次调用失败' },
    ],
  });

  assert.match(prompt, /^这是一次用户的追问，内容是 请比较前两次结果/);
  assert.match(prompt, /cat x\.jpg att\.zip > xa\.jpg/);
  assert.match(prompt, /1\.zip是用户第一次提问时的附件打包zip/);
  assert.match(prompt, /2\.zip是第二次提问时的附件打包zip/);
  assert.match(prompt, /第一次提问：\n第一次问题\n第一次回答：\n第一次答案/);
  assert.match(prompt, /第二次提问：\n第二次问题\n第二次回答：\n第二次调用失败/);
});

test('没有任何历史附件时不声称附图存在', () => {
  const prompt = buildProviderPrompt({
    turnNo: 2,
    currentPrompt: '继续',
    hasAnyAttachments: false,
    history: [{ turnNo: 1, prompt: '问题', answer: '回答', error: null }],
  });
  assert.doesNotMatch(prompt, /cat x\.jpg/);
  assert.match(prompt, /之前的提问\/回答历史为/);
});
