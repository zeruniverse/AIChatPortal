<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import FilePicker from '../components/FilePicker.vue';
import { createChat, formatBytes } from '../api.js';
import { appState, loadAppConfig } from '../state.js';

const router = useRouter();
const prompt = ref('');
const modelId = ref('');
const files = ref([]);
const error = ref('');
const submitting = ref(false);
const uploadProgress = ref(0);
const shareEnabled = ref(false);
const config = computed(() => appState.config);

onMounted(async () => {
  try {
    const loaded = await loadAppConfig();
    if (!modelId.value) modelId.value = loaded.models[0]?.id || '';
  } catch {
    // App-level error banner is shown.
  }
});

async function submit() {
  error.value = '';
  if (!prompt.value.trim()) {
    error.value = '请输入问题';
    return;
  }
  if (!modelId.value) {
    error.value = '请选择模型';
    return;
  }
  submitting.value = true;
  uploadProgress.value = 0;
  try {
    const result = await createChat({
      prompt: prompt.value.trim(),
      modelId: modelId.value,
      files: files.value,
      shareEnabled: shareEnabled.value,
      onProgress: (value) => { uploadProgress.value = value; },
    });
    await router.push(`/chat/${result.id}`);
  } catch (submitError) {
    error.value = submitError.message;
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="page new-chat-page">
    <header class="page-heading hero-heading">
      <span class="eyebrow">OPENAI COMPATIBLE</span>
      <h1>向模型提交一个问题</h1>
      <p>每次提交都是独立任务，不支持追问。即使关闭浏览器，服务器仍会继续等待模型返回。</p>
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
        <textarea
          id="prompt"
          v-model="prompt"
          rows="7"
          :maxlength="config?.limits.maxPromptChars || 100000"
          :disabled="submitting"
          placeholder="输入完整问题。提交后不能继续追问……"
        ></textarea>
        <span class="character-count">{{ prompt.length.toLocaleString() }} / {{ (config?.limits.maxPromptChars || 100000).toLocaleString() }}</span>
      </div>

      <FilePicker
        v-model="files"
        :disabled="submitting"
        :max-files="config?.limits.maxFiles || 100"
        :max-raw-bytes="config?.limits.maxRawUploadBytes || 536870912"
        @error="error = $event"
      />

      <div class="limit-note">
        <span aria-hidden="true">i</span>
        <p>服务器会把全部附件压成一个 ZIP；压缩后必须小于 {{ formatBytes(config?.limits.maxCompressedAttachmentBytes || 70000000) }}。下载时也只能下载整个附件包。</p>
      </div>

      <label class="share-option">
        <input v-model="shareEnabled" type="checkbox" :disabled="submitting" />
        <span>
          <strong>开启公开分享</strong>
          <small>提交后生成不可猜测的公开链接。获得链接的人无需登录，也能查看回答并下载全部附件。</small>
        </span>
      </label>

      <div v-if="submitting" class="upload-progress" aria-live="polite">
        <progress class="progress-track" :value="Math.max(0.03, uploadProgress)" max="1">{{ Math.round(uploadProgress * 100) }}%</progress>
        <p>{{ uploadProgress < 1 ? `正在上传 ${Math.round(uploadProgress * 100)}%` : '上传完成，正在创建后台任务…' }}</p>
      </div>

      <p v-if="error" class="form-error" role="alert">{{ error }}</p>

      <button class="primary-button submit-button" type="submit" :disabled="submitting || !prompt.trim() || !modelId">
        <span v-if="submitting" class="spinner" aria-hidden="true"></span>
        {{ submitting ? '正在提交' : '提交问题' }}
      </button>
    </form>
  </div>
</template>
