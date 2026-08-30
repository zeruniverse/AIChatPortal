<script setup>
import { computed, onBeforeUnmount, ref } from 'vue';
import { api } from '../api.js';

const props = defineProps({ disabled: Boolean });
const emit = defineEmits(['state']);
const input = ref(null);
const uploadId = ref(null);
const items = ref([]);
const sessionCreating = ref(false);
const controllers = new Map();
let generation = 0;

const busy = computed(() => sessionCreating.value || items.value.some((item) => ['registering','uploading','removing'].includes(item.status)));
const failed = computed(() => items.value.some((item) => item.status === 'failed'));
function publish() { emit('state', { uploadId: uploadId.value, busy: busy.value, failed: failed.value, hasFiles: items.value.length > 0, ready: !busy.value && !failed.value }); }

async function ensureSession() {
  if (uploadId.value) return uploadId.value;
  sessionCreating.value = true; publish();
  try { const result = await api('/api/uploads', { method: 'POST' }); uploadId.value = result.id; return result.id; }
  finally { sessionCreating.value = false; publish(); }
}

async function choose(event) {
  const files = [...event.target.files];
  event.target.value = '';
  if (!files.length) return;
  const session = await ensureSession();
  const currentGeneration = generation;
  for (const file of files) {
    if (currentGeneration !== generation) break;
    await uploadOne(session, file, currentGeneration);
  }
}

async function uploadOne(session, file, currentGeneration) {
  if (currentGeneration !== generation) return;
  const local = { localId: `${Date.now()}-${Math.random()}`, serverId: null, name: file.name, size: file.size, type: file.type, progress: 0, status: 'registering', error: '' };
  items.value.push(local); publish();
  try {
    const registered = await api(`/api/uploads/${session}/files`, { method: 'POST', body: { name: file.name, size: file.size, type: file.type } });
    local.serverId = registered.id; local.status = 'uploading'; publish();
    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      controllers.set(local.localId, xhr);
      xhr.open('PUT', `/api/uploads/${session}/files/${registered.id}`);
      xhr.withCredentials = true;
      xhr.upload.onprogress = (event) => { if (event.lengthComputable) local.progress = Math.round(event.loaded / event.total * 100); publish(); };
      xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(JSON.parse(xhr.responseText || '{}').error || `HTTP ${xhr.status}`));
      xhr.onerror = () => reject(new Error('网络上传失败'));
      xhr.onabort = () => reject(new Error('上传已取消'));
      xhr.send(file);
    });
    local.status = 'complete'; local.progress = 100;
  } catch (error) { if (currentGeneration === generation) { local.status = 'failed'; local.error = error.message; } }
  finally { controllers.delete(local.localId); if (currentGeneration === generation) publish(); }
}

async function remove(item) {
  if (props.disabled) return;
  controllers.get(item.localId)?.abort();
  item.status = 'removing'; publish();
  try { if (uploadId.value && item.serverId) await api(`/api/uploads/${uploadId.value}/files/${item.serverId}`, { method: 'DELETE' }); }
  catch {}
  items.value = items.value.filter((entry) => entry.localId !== item.localId);
  if (!items.value.length && uploadId.value) {
    await api(`/api/uploads/${uploadId.value}`, { method: 'DELETE' }).catch(() => {});
    uploadId.value = null;
  }
  publish();
}

async function clearAll() {
  generation += 1;
  for (const xhr of controllers.values()) xhr.abort();
  controllers.clear();
  if (uploadId.value) await api(`/api/uploads/${uploadId.value}`, { method: 'DELETE' }).catch(() => {});
  uploadId.value = null; items.value = []; publish();
}

function openPicker() { input.value?.click(); }

function formatSize(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 ** 2).toFixed(1)} MB`;
}

onBeforeUnmount(() => { generation += 1; for (const xhr of controllers.values()) xhr.abort(); });
defineExpose({ clearAll });
publish();
</script>

<template>
  <section class="uploader">
    <div class="uploader-actions">
      <button type="button" class="button secondary" :disabled="disabled || busy" @click="openPicker">添加附件并立即上传</button>
      <button v-if="items.length" type="button" class="button ghost" :disabled="disabled || busy" @click="clearAll">清空附件</button>
      <input ref="input" class="visually-hidden" type="file" multiple @change="choose" />
    </div>
    <p class="hint">支持任意文件类型。必须全部上传完成后才能提交；提交后服务器在后台压缩并调用模型。</p>
    <div v-if="items.length" class="upload-list">
      <div v-for="item in items" :key="item.localId" class="upload-item">
        <div class="upload-main">
          <strong>{{ item.name }}</strong><span>{{ formatSize(item.size) }}</span>
          <div class="progress"><span :style="{ width: `${item.progress}%` }"></span></div>
          <small :class="{ error: item.status === 'failed' }">{{ item.status === 'complete' ? '已上传' : item.status === 'failed' ? item.error : `${item.progress}%` }}</small>
        </div>
        <button type="button" class="button ghost compact" :disabled="disabled" @click="remove(item)">移除</button>
      </div>
    </div>
  </section>
</template>
