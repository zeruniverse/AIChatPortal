<script setup>
import { onBeforeUnmount, ref } from 'vue';
import { writeClipboardText } from '../clipboard.js';

const props = defineProps({
  text: { type: String, default: '' },
  idleLabel: { type: String, default: '复制' },
  copiedLabel: { type: String, default: '已复制' },
  failedLabel: { type: String, default: '复制失败' },
  disabled: { type: Boolean, default: false },
});

const state = ref('idle');
let timer;

async function handleCopy() {
  if (props.disabled || !props.text) return;
  const success = await writeClipboardText(props.text);
  state.value = success ? 'copied' : 'failed';
  window.clearTimeout(timer);
  timer = window.setTimeout(() => { state.value = 'idle'; }, success ? 1600 : 2600);
}

onBeforeUnmount(() => window.clearTimeout(timer));
</script>

<template>
  <button class="copy-text-button" type="button" :disabled="disabled || !text" @click="handleCopy">
    <span aria-live="polite">{{ state === 'copied' ? copiedLabel : state === 'failed' ? failedLabel : idleLabel }}</span>
  </button>
</template>
