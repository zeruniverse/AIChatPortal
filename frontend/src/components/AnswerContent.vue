<script setup>
import { computed, reactive } from 'vue';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { parseAnswerSegments } from '../utils/answerParser.js';

const props = defineProps({ raw: { type: String, default: '' } });
const open = reactive(new Set());
const segments = computed(() => parseAnswerSegments(props.raw));
function toggle(index) { open.has(index) ? open.delete(index) : open.add(index); }
function markdown(content) {
  const html = marked.parse(content, { breaks: true, gfm: true });
  return DOMPurify.sanitize(html, { ADD_ATTR: ['target', 'rel', 'loading'] });
}
</script>

<template>
  <div class="answer-content">
    <template v-for="(segment, index) in segments" :key="`${segment.type}-${segment.index ?? index}`">
      <div v-if="segment.type === 'answer'" class="markdown" v-html="markdown(segment.content)"></div>
      <div v-else class="think-block">
        <a href="#" class="think-toggle" @click.prevent="toggle(segment.index)">
          {{ open.has(segment.index) ? '隐藏思考过程' : `查看思考过程${segment.complete ? '' : '（生成中）'}` }}
        </a>
        <pre v-if="open.has(segment.index)" class="think-text">{{ segment.content }}</pre>
      </div>
    </template>
  </div>
</template>
