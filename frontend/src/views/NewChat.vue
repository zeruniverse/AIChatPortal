<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import FilePicker from '../components/FilePicker.vue';
import { createChat, formatBytes } from '../api.js';
import { createClientConversationId } from '../id.js';
import { submitOnShortcut } from '../keyboard-submit.js';
import { appState, failPendingChat, finishPendingChat, loadAppConfig, startPendingChat, updatePendingChat } from '../state.js';

const router = useRouter();
const prompt = ref('');
const modelId = ref('');
const files = ref([]);
const error = ref('');
const submitting = ref(false);
const shareEnabled = ref(false);
const config = computed(() => appState.config);

onMounted(async () => {
  try {
    const loaded = await loadAppConfig();
    if (!modelId.value) modelId.value = loaded.models[0]?.id || '';
  } catch { /* global banner */ }
});

function handlePromptKeydown(event) {
  submitOnShortcut(event, () => { void submit(); });
}

async function submit() {
  error.value = '';
  const text = prompt.value.trim();
  if (!text) { error.value = '请输入问题'; return; }
  if (!modelId.value) { error.value = '请选择模型'; return; }
  submitting.value = true;
  const id = createClientConversationId();
  const model = config.value?.models.find((item) => item.id === modelId.value);
  startPendingChat(id, {
    id, title: text.slice(0, 80), modelId: modelId.value, modelLabel: model?.label || modelId.value,
    status: 'uploading', createdAt: new Date().toISOString(), shared: shareEnabled.value,
    turns: [{
      turnNo: 1, prompt: text, answer: '', status: 'uploading', createdAt: new Date().toISOString(),
      hasAttachments: files.value.length > 0, attachmentCount: files.value.length,
      attachmentBytes: 0, attachmentReady: false, deltaSequence: 0,
    }],
  });
  const request = createChat({
    clientId: id, prompt: text, modelId: modelId.value, files: files.value,
    shareEnabled: shareEnabled.value,
    onProgress: (progress) => updatePendingChat(id, { progress }),
  });
  await router.push(`/chat/${id}`);
  try { finishPendingChat(id, await request); } catch (submitError) { failPendingChat(id, submitError); }
}
</script>

<template>
  <div class="page new-chat-page">
    <header class="page-heading hero-heading">
      <span class="eyebrow">OPENAI COMPATIBLE</span>
      <h1>开始一个新对话</h1>
      <p>提交后立即进入对话页面。附件在服务器后台以最高压缩级别打包，关闭浏览器不会停止已保存的模型任务。</p>
    </header>
    <form class="composer-card" @submit.prevent="submit">
      <div class="field-group model-field">
        <label for="model">选择模型</label>
        <select id="model" v-model="modelId" :disabled="submitting || !config">
          <option v-for="model in config?.models || []" :key="model.id" :value="model.id">{{ model.label }}</option>
        </select>
      </div>
      <div class="field-group prompt-field">
        <label for="prompt">你的问题</label>
        <textarea id="prompt" v-model="prompt" rows="7" :maxlength="config?.limits.maxPromptChars || 100000" :disabled="submitting" placeholder="输入问题，回答完成后可以继续追问……" @keydown="handlePromptKeydown"></textarea>
        <span class="character-count">{{ prompt.length.toLocaleString() }} / {{ (config?.limits.maxPromptChars || 100000).toLocaleString() }}</span>
      </div>
      <FilePicker v-model="files" :disabled="submitting" :max-files="config?.limits.maxFiles || 100" :max-raw-bytes="config?.limits.maxRawUploadBytes || 536870912" @error="error = $event" />
      <div class="limit-note"><span aria-hidden="true">i</span><p>本轮所有附件会异步执行等价于 <code>zip -9 -r</code> 的压缩；压缩完成前不可下载，压缩后必须小于 {{ formatBytes(config?.limits.maxCompressedAttachmentBytes || 70000000) }}。</p></div>
      <label class="share-option"><input v-model="shareEnabled" type="checkbox" :disabled="submitting" /><span><strong>开启公开分享</strong><small>链接持有者无需登录，可查看全部轮次并下载每轮或全部附件。</small></span></label>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <button class="primary-button submit-button" type="submit" :disabled="submitting || !prompt.trim() || !modelId">
        <span v-if="submitting" class="spinner" aria-hidden="true"></span>{{ submitting ? '正在进入对话' : '提交问题' }}
      </button>
    </form>
  </div>
</template>
