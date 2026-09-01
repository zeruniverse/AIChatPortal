<script setup>
import { computed, reactive } from 'vue';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { parseAnswerSegments } from '../utils/answerParser.js';
import { copyText } from '../utils/clipboard.js';

const props = defineProps({ raw: { type: String, default: '' } });
const open = reactive(new Set());
const segments = computed(() => parseAnswerSegments(props.raw));
function toggle(index) { open.has(index) ? open.delete(index) : open.add(index); }

function isEscaped(text, index) {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function findDelimiter(text, delimiter, start, inline = false) {
  let cursor = start;
  while (cursor < text.length) {
    const index = text.indexOf(delimiter, cursor);
    if (index < 0) return -1;
    if (!isEscaped(text, index)) {
      if (!inline || (index > start && !/\s/.test(text[index - 1]) && text[index + 1] !== '$')) return index;
    }
    cursor = index + delimiter.length;
  }
  return -1;
}

function protectMath(content) {
  const source = String(content ?? '');
  const math = [];
  let output = '';
  let cursor = 0;
  let lineStart = true;
  let fence = null;

  const addMath = (expression, displayMode, original) => {
    const token = `KATEXPLACEHOLDER${math.length}END`;
    let html;
    try {
      html = katex.renderToString(expression.trim(), {
        displayMode,
        throwOnError: false,
        strict: false,
        trust: false
      });
    } catch {
      html = original;
    }
    math.push({ token, html });
    output += token;
  };

  while (cursor < source.length) {
    if (lineStart) {
      let marker = cursor;
      let spaces = 0;
      while (spaces < 4 && source[marker] === ' ') { marker += 1; spaces += 1; }
      const char = source[marker];
      if (spaces <= 3 && (char === '`' || char === '~')) {
        let endMarker = marker;
        while (source[endMarker] === char) endMarker += 1;
        const length = endMarker - marker;
        if (length >= 3) {
          const lineEnd = source.indexOf('\n', endMarker);
          const end = lineEnd < 0 ? source.length : lineEnd + 1;
          const remainder = source.slice(endMarker, lineEnd < 0 ? source.length : lineEnd).trim();
          if (!fence) fence = { char, length };
          else if (fence.char === char && length >= fence.length && !remainder) fence = null;
          output += source.slice(cursor, end);
          cursor = end;
          lineStart = true;
          continue;
        }
      }
    }

    if (fence) {
      const lineEnd = source.indexOf('\n', cursor);
      if (lineEnd < 0) {
        output += source.slice(cursor);
        break;
      }
      output += source.slice(cursor, lineEnd + 1);
      cursor = lineEnd + 1;
      lineStart = true;
      continue;
    }

    if (source[cursor] === '`') {
      let runEnd = cursor;
      while (source[runEnd] === '`') runEnd += 1;
      const delimiter = source.slice(cursor, runEnd);
      const close = source.indexOf(delimiter, runEnd);
      if (close >= 0) {
        const end = close + delimiter.length;
        output += source.slice(cursor, end);
        lineStart = source[end - 1] === '\n';
        cursor = end;
        continue;
      }
    }

    if (!isEscaped(source, cursor) && source.startsWith('\\[', cursor)) {
      const close = findDelimiter(source, '\\]', cursor + 2);
      if (close >= 0) {
        const end = close + 2;
        addMath(source.slice(cursor + 2, close), true, source.slice(cursor, end));
        lineStart = source[end - 1] === '\n';
        cursor = end;
        continue;
      }
    }

    if (!isEscaped(source, cursor) && source.startsWith('\\(', cursor)) {
      const close = findDelimiter(source, '\\)', cursor + 2);
      if (close >= 0) {
        const end = close + 2;
        addMath(source.slice(cursor + 2, close), false, source.slice(cursor, end));
        lineStart = source[end - 1] === '\n';
        cursor = end;
        continue;
      }
    }

    if (!isEscaped(source, cursor) && source.startsWith('$$', cursor)) {
      const close = findDelimiter(source, '$$', cursor + 2);
      if (close >= 0) {
        const end = close + 2;
        addMath(source.slice(cursor + 2, close), true, source.slice(cursor, end));
        lineStart = source[end - 1] === '\n';
        cursor = end;
        continue;
      }
    }

    if (source[cursor] === '$' && source[cursor + 1] !== '$' && !isEscaped(source, cursor) && source[cursor + 1] && !/\s/.test(source[cursor + 1])) {
      const close = findDelimiter(source, '$', cursor + 1, true);
      if (close >= 0) {
        const end = close + 1;
        addMath(source.slice(cursor + 1, close), false, source.slice(cursor, end));
        lineStart = source[end - 1] === '\n';
        cursor = end;
        continue;
      }
    }

    output += source[cursor];
    lineStart = source[cursor] === '\n';
    cursor += 1;
  }

  return { source: output, math };
}

function addCodeCopyButtons(html) {
  return html.replace(
    /<pre><code([^>]*)>([\s\S]*?)<\/code><\/pre>/g,
    '<div class="code-block"><button type="button" class="button ghost compact code-copy" data-copy-code>复制代码</button><pre><code$1>$2</code></pre></div>'
  );
}

function markdown(content) {
  const protectedContent = protectMath(content);
  let html = marked.parse(protectedContent.source, { breaks: true, gfm: true });
  for (const item of protectedContent.math) html = html.split(item.token).join(item.html);
  html = addCodeCopyButtons(html);
  return DOMPurify.sanitize(html, { ADD_ATTR: ['target', 'rel', 'loading', 'data-copy-code'] });
}

async function handleMarkdownClick(event) {
  const target = event.target instanceof Element ? event.target : event.target?.parentElement;
  const button = target?.closest?.('[data-copy-code]');
  if (!button || !event.currentTarget.contains(button)) return;
  const code = button.closest('.code-block')?.querySelector('code');
  if (!code) return;
  try {
    await copyText(code.textContent || '');
    button.textContent = '已复制';
  } catch {
    button.textContent = '复制失败';
  }
  setTimeout(() => { if (button.isConnected) button.textContent = '复制代码'; }, 1600);
}
</script>

<template>
  <div class="answer-content">
    <template v-for="(segment, index) in segments" :key="`${segment.type}-${segment.index ?? index}`">
      <div v-if="segment.type === 'answer'" class="markdown" v-html="markdown(segment.content)" @click="handleMarkdownClick"></div>
      <div v-else class="think-block">
        <a href="#" class="think-toggle" @click.prevent="toggle(segment.index)">
          {{ open.has(segment.index) ? '隐藏思考过程' : `查看思考过程${segment.complete ? '' : '（生成中）'}` }}
        </a>
        <pre v-if="open.has(segment.index)" class="think-text">{{ segment.content }}</pre>
      </div>
    </template>
  </div>
</template>
