<script setup>
import { ref } from 'vue';
import { copyText } from '../utils/clipboard.js';
const props = defineProps({ text: { type: String, default: '' }, label: { type: String, default: '复制' }, disabled: Boolean });
const state = ref('');
async function copy() {
  if (props.disabled) return;
  try { await copyText(props.text); state.value = '已复制'; }
  catch { state.value = '复制失败'; }
  setTimeout(() => { state.value = ''; }, 1600);
}
</script>
<template><button type="button" class="button ghost compact" :disabled="disabled" @click="copy">{{ state || label }}</button></template>
