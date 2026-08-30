import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAnswerSegments, visibleAnswer, stripLeadingAnswerPrefix } from '../frontend/src/utils/answerParser.js';

const cases = [
  ['Answer:\nhello', 'hello'],
  ['  ## 回答： hello', 'hello'],
  ['\n# Answer：\nhello', 'hello'],
  ['prefix\nAnswer:\ninside', 'prefix\nAnswer:\ninside']
];
for (const [input, expected] of cases) test(`prefix ${JSON.stringify(input)}`, () => assert.equal(stripLeadingAnswerPrefix(input), expected));

test('multiple think groups preserve all answer segments', () => {
  const raw = '<think>abc</think>## 回答： abcde <think>abc</think>def <think>asd</think> 回答： ';
  assert.deepEqual(parseAnswerSegments(raw), [
    { type: 'think', content: 'abc', complete: true, index: 0 },
    { type: 'answer', content: 'abcde' },
    { type: 'think', content: 'abc', complete: true, index: 1 },
    { type: 'answer', content: 'def' },
    { type: 'think', content: 'asd', complete: true, index: 2 }
  ]);
  assert.equal(visibleAnswer(raw), 'abcde\ndef');
});

test('unfinished think is not copied as answer', () => {
  const raw = '## 回答： visible<think>working';
  assert.equal(visibleAnswer(raw), 'visible');
  assert.equal(parseAnswerSegments(raw).at(-1).complete, false);
});
