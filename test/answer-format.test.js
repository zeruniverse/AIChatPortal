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


test('没有目标前缀时仅 trim 首尾空白，正文中的 Answer/回答 不删除', () => {
  const raw = '  正文第一行\nAnswer:\n中间标签保留\n  ';
  const expected = '正文第一行\nAnswer:\n中间标签保留';
  assert.equal(stripAnswerPrefix(raw), expected);
  assert.equal(parseModelResponse(raw).answer, expected);
});

test('开头先有任意空白再有 Answer/回答 前缀时仍删除提示符', () => {
  assert.equal(stripAnswerPrefix('  \n\tAnswer:\nhello  \n'), 'hello');
  assert.equal(stripAnswerPrefix('\r\n \t回答：\r\n你好\r\n'), '你好');
  assert.equal(stripAnswerPrefix('\n\n answer :   hello   '), 'hello');
});

test('只删除开头的 Answer/回答 前缀，正文中同样的字样必须保留', () => {
  assert.equal(stripAnswerPrefix('正文第一行\nAnswer:\n这是回答的一部分'), '正文第一行\nAnswer:\n这是回答的一部分');
  assert.equal(stripAnswerPrefix('正文第一行\n回答：这是回答的一部分'), '正文第一行\n回答：这是回答的一部分');
  assert.equal(stripAnswerPrefix('前言 Answer: 不在开头'), '前言 Answer: 不在开头');
});

test('有 think 时只删除最后一个 </think> 后（可先有空白）的 Answer/回答 前缀', () => {
  const withPrefix = parseModelResponse('<think>分析</think>\n\n  \tAnswer:\n最终答案  \n');
  assert.equal(withPrefix.answer, '最终答案');

  const chineseWithPrefix = parseModelResponse('<think>分析</think>\r\n \t 回答：\r\n最终答案');
  assert.equal(chineseWithPrefix.answer, '最终答案');

  const answerContainsPrefix = parseModelResponse('<think>分析</think>\n\n最终答案第一行\nAnswer:\n这是最终答案正文的一部分');
  assert.equal(answerContainsPrefix.answer, '最终答案第一行\nAnswer:\n这是最终答案正文的一部分');

  const chineseContainsPrefix = parseModelResponse('<think>分析</think>\n\n最终答案第一行\n回答：这是正文的一部分');
  assert.equal(chineseContainsPrefix.answer, '最终答案第一行\n回答：这是正文的一部分');
});
