export function stripLeadingAnswerPrefix(text) {
  let value = String(text ?? '').trimStart();
  value = value.replace(/^(?:#{1,6}[ \t]*)?(?:answer|回答)[ \t]*[:：][ \t]*(?:\r?\n)?/i, '');
  return value.trim();
}

export function parseAnswerSegments(raw) {
  const source = String(raw ?? '');
  const segments = [];
  let cursor = 0;
  const openRe = /<think>/ig;
  while (cursor < source.length) {
    openRe.lastIndex = cursor;
    const open = openRe.exec(source);
    if (!open) {
      const answer = stripLeadingAnswerPrefix(source.slice(cursor));
      if (answer) segments.push({ type: 'answer', content: answer });
      break;
    }
    const before = stripLeadingAnswerPrefix(source.slice(cursor, open.index));
    if (before) segments.push({ type: 'answer', content: before });
    const contentStart = open.index + open[0].length;
    const closeRe = /<\/think>/ig;
    closeRe.lastIndex = contentStart;
    const close = closeRe.exec(source);
    if (!close) {
      segments.push({ type: 'think', content: source.slice(contentStart).trim(), complete: false });
      cursor = source.length;
      break;
    }
    segments.push({ type: 'think', content: source.slice(contentStart, close.index).trim(), complete: true });
    cursor = close.index + close[0].length;
  }
  if (!source.length) return [];
  return segments;
}

export function visibleAnswer(raw) {
  return parseAnswerSegments(raw).filter((part) => part.type === 'answer' && part.content).map((part) => part.content).join('\n');
}
