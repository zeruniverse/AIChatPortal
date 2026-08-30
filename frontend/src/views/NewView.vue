<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api.js';
import { loadPublicConfig, publicConfig } from '../configStore.js';
import { shouldSubmit } from '../utils/shortcut.js';
import AttachmentUploader from '../components/AttachmentUploader.vue';
const router = useRouter(); const question = ref(''); const modelId = ref(''); const shareEnabled = ref(false); const busy = ref(false); const error = ref(''); const uploader = ref(null); const questionDrag = ref(false);
const uploadState = ref({ uploadId: null, busy: false, failed: false, hasFiles: false, ready: true });
const canSubmit = computed(() => question.value.trim() && modelId.value && uploadState.value.ready && !busy.value);
onMounted(async () => { await loadPublicConfig(); modelId.value ||= publicConfig.models[0]?.id || ''; });
async function submit() {
  if (!canSubmit.value) return;
  busy.value = true; error.value = '';
  try {
    const result = await api('/api/conversations', { method: 'POST', body: { question: question.value, modelId: modelId.value, shareEnabled: shareEnabled.value, uploadId: uploadState.value.hasFiles ? uploadState.value.uploadId : null } });
    await router.replace(result.url);
  } catch (e) { error.value = e.message; busy.value = false; }
}
function keydown(event) { if (shouldSubmit(event)) { event.preventDefault(); submit(); } }
function hasDraggedFiles(event) { return Array.from(event.dataTransfer?.types || []).includes('Files'); }
function dragQuestion(event) {
  if (!hasDraggedFiles(event)) return;
  event.preventDefault();
  if (busy.value) { questionDrag.value = false; return; }
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  questionDrag.value = true;
}
function leaveQuestion(event) { if (hasDraggedFiles(event)) questionDrag.value = false; }
function dropQuestionFiles(event) {
  if (!hasDraggedFiles(event)) return;
  event.preventDefault();
  questionDrag.value = false;
  if (busy.value) return;
  const files = event.dataTransfer?.files;
  if (files?.length) {
    const pending = uploader.value?.addFiles(files);
    pending?.catch((e) => { error.value = e.message; });
  }
}
</script>
<template>
  <main class="page narrow">
    <header class="page-header"><div><h1>新建提问</h1><p class="muted">Ctrl+Enter 或 Cmd+Enter 提交；Enter 与 Shift+Enter 只换行。</p></div></header>
    <form class="card composer" @submit.prevent="submit">
      <label>模型<select v-model="modelId"><option v-for="model in publicConfig.models" :key="model.id" :value="model.id">{{ model.label }}</option></select></label>
      <label>问题<textarea v-model="question" rows="9" placeholder="输入问题…" :class="{ 'file-drop-active': questionDrag }" @keydown="keydown" @dragenter="dragQuestion" @dragover="dragQuestion" @dragleave="leaveQuestion" @drop="dropQuestionFiles"></textarea></label>
      <AttachmentUploader ref="uploader" :disabled="busy" @state="uploadState = $event" />
      <label class="check-row"><input v-model="shareEnabled" type="checkbox" /> 生成分享链接</label>
      <p v-if="error" class="error-box">{{ error }}</p>
      <button class="button primary full" :disabled="!canSubmit">{{ busy ? '正在提交…' : uploadState.busy ? '请等待附件上传完成' : '提交问题' }}</button>
    </form>
  </main>
</template>
