const COMPLETE_THINK = /<think\b[^>]*>([\s\S]*?)<\/think\s*>/gi;
const OPEN_THINK = /<think\b[^>]*>/i;

export function stripAnswerPrefix(value) {
  const trimmed = String(value ?? '').trimStart().trimEnd();
  return trimmed
    .replace(/^(?:answer|回答)\s*[:：][ \t]*(?:\r?\n)?/i, '')
    .trimStart()
    .trimEnd();
}

export function parseModelResponse(value) {
  const source = String(value ?? '');
  const thoughts = [];
  let lastClosedEnd = 0;
  let match;

  COMPLETE_THINK.lastIndex = 0;
  while ((match = COMPLETE_THINK.exec(source)) !== null) {
    thoughts.push({
      content: match[1].replace(/^\s+|\s+$/g, ''),
      complete: true,
    });
    lastClosedEnd = match.index + match[0].length;
  }

  const tail = source.slice(lastClosedEnd);
  const openMatch = OPEN_THINK.exec(tail);
  let answerSource;
  if (openMatch) {
    thoughts.push({
      content: tail.slice(openMatch.index + openMatch[0].length).replace(/^\s+/, ''),
      complete: false,
    });
    answerSource = '';
  } else if (thoughts.length) {
    answerSource = tail;
  } else {
    answerSource = source;
  }

  return {
    thoughts,
    answer: stripAnswerPrefix(answerSource),
    hasThinking: thoughts.length > 0,
    thinkingOpen: thoughts.some((thought) => !thought.complete),
  };
}

export function copyableAnswer(value) {
  return parseModelResponse(value).answer;
}
