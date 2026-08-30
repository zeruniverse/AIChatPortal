<script setup>
import { computed, reactive, watch } from 'vue';
import { parseModelResponse } from '../answer-format.js';
import MarkdownBlock from './MarkdownBlock.vue';

const props = defineProps({
  content: { type: String, default: '' },
  pending: { type: Boolean, default: false },
});

const parsed = computed(() => parseModelResponse(props.content));
const expanded = reactive({});

function toggle(index) {
  expanded[index] = !expanded[index];
}

watch(() => parsed.value.thoughts.length, (length) => {
  for (const key of Object.keys(expanded)) {
    if (Number(key) >= length) delete expanded[key];
  }
});
</script>

<template>
  <div class="model-answer">
    <div v-if="parsed.thoughts.length" class="thinking-sections">
      <section v-for="(thought, index) in parsed.thoughts" :key="index" class="thinking-section">
        <a href="#" class="thinking-toggle" :aria-expanded="Boolean(expanded[index])" @click.prevent="toggle(index)">
          {{ expanded[index] ? '隐藏思考过程' : '查看思考过程' }}<span v-if="parsed.thoughts.length > 1"> {{ index + 1 }}</span><span v-if="!thought.complete">（生成中）</span>
        </a>
        <pre v-if="expanded[index]" class="thinking-content">{{ thought.content || '思考内容正在生成……' }}</pre>
      </section>
    </div>
    <div v-if="parsed.answer" class="final-answer"><MarkdownBlock :content="parsed.answer" /></div>
    <div v-else-if="pending" class="final-answer-pending">
      <span class="spinner small-spinner" aria-hidden="true"></span>
      <span>{{ parsed.thinkingOpen ? '思考过程仍在生成，正在等待最终回答…' : '正在等待最终回答…' }}</span>
    </div>
    <p v-else-if="parsed.hasThinking" class="muted-note final-answer-empty">provider 没有返回最终回答正文。</p>
  </div>
</template>
