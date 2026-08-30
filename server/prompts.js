const DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

function chineseNumber(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) return String(value);
  if (number < 10) return DIGITS[number];
  if (number < 20) return `十${number === 10 ? '' : DIGITS[number % 10]}`;
  if (number < 100) return `${DIGITS[Math.floor(number / 10)]}十${number % 10 ? DIGITS[number % 10] : ''}`;
  return String(number);
}

function turnLabel(turnNo) {
  return `第${chineseNumber(turnNo)}次`;
}

export function buildProviderPrompt({ turnNo, currentPrompt, history, hasAnyAttachments }) {
  if (turnNo <= 1) return currentPrompt;
  const attachmentClause = hasAnyAttachments
    ? '，如果有附图，附图是一个 cat x.jpg att.zip > xa.jpg 生成的图片，你应该先解压出附件。附件内部是多个zip，1.zip是用户第一次提问时的附件打包zip，2.zip是第二次提问时的附件打包zip，以此类推'
    : '';
  const historyText = history.map((turn) => {
    const label = turnLabel(turn.turnNo);
    const answer = turn.error || turn.answer || '（没有可用回答）';
    return `${label}提问：\n${turn.prompt}\n${label}回答：\n${answer}`;
  }).join('\n\n');
  return `这是一次用户的追问，内容是 ${currentPrompt}${attachmentClause}，之前的提问/回答历史为：\n\n${historyText}`;
}
