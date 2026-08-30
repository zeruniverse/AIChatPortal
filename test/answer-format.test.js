import test from 'node:test';
import assert from 'node:assert/strict';
import { copyableAnswer, parseModelResponse, stripAnswerPrefix } from '../frontend/src/answer-format.js';

test('没有 think 时保留正文并删除 provider 的 Answer/回答前缀', () => {
  assert.equal(stripAnswerPrefix('Answer:\nhello'), 'hello');
  assert.equal(stripAnswerPrefix('回答：\r\n你好'), '你好');
  assert.equal(parseModelResponse('普通回答').answer, '普通回答');
});

test('多组 think 分别提取，最终回答只取最后一个 closing tag 后的内容', () => {
  const raw = [
    '<think>第一段思考\n命令 A</think>',
    '中间 provider 文本不应出现在最终回答',
    '<think>第二段思考\n命令 B</think>',
    'Answer:\n最终答案',
  ].join('\n');
  const parsed = parseModelResponse(raw);
  assert.deepEqual(parsed.thoughts, [
    { content: '第一段思考\n命令 A', complete: true },
    { content: '第二段思考\n命令 B', complete: true },
  ]);
  assert.equal(parsed.answer, '最终答案');
  assert.equal(copyableAnswer(raw), '最终答案');
});

test('流式未闭合 think 不泄露到最终回答', () => {
  const parsed = parseModelResponse('<think>正在分析\n尚未完成');
  assert.equal(parsed.thoughts.length, 1);
  assert.equal(parsed.thoughts[0].complete, false);
  assert.equal(parsed.answer, '');
  assert.equal(parsed.thinkingOpen, true);
});

test('示例型长回答能提取思考和最终回答', () => {
  const raw = '<think>bash -lc set -euo pipefail\nThought:\nInspected archive</think>\n\n回答:\n这是最终结论。';
  const parsed = parseModelResponse(raw);
  assert.equal(parsed.thoughts[0].content.includes('bash -lc'), true);
  assert.equal(parsed.answer, '这是最终结论。');
});
