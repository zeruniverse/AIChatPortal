<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api.js';
import { loadPublicConfig, publicConfig } from '../configStore.js';
import { shouldSubmit } from '../utils/shortcut.js';
import { visibleAnswer } from '../utils/answerParser.js';
import AnswerContent from '../components/AnswerContent.vue';
import AttachmentUploader from '../components/AttachmentUploader.vue';
import CopyButton from '../components/CopyButton.vue';

const route = useRoute(); const router = useRouter(); const data = ref(null); const error = ref(''); const loading = ref(true); const followQuestion = ref(''); const followModel = ref(''); const followBusy = ref(false); const uploadState = ref({ uploadId: null, busy: false, failed: false, hasFiles: false, ready: true }); const uploader = ref(null);
const edit = ref(null); const shareBusy = ref(false); let events; let poll;
const lastTurn = computed(() => { const turns = data.value?.turns || []; return turns[turns.length - 1]; });
const canFollow = computed(() => ['completed','error'].includes(lastTurn.value?.status) && followQuestion.value.trim() && followModel.value && uploadState.value.ready && !followBusy.value);
const shareUrl = computed(() => data.value?.shareToken ? `${location.origin}/share/${data.value.shareToken}` : '');

async function load(silent = false) {
  if (!silent) loading.value = true;
  try { data.value = await api(`/api/conversations/${route.params.id}`); followModel.value ||= lastTurn.value?.modelId || publicConfig.models[0]?.id || ''; }
  catch (e) { error.value = e.message; }
  finally { loading.value = false; }
}
function connect() {
  events?.close();
  events = new EventSource(`/api/conversations/${route.params.id}/events`);
  events.addEventListener('update', () => load(true));
  events.onerror = () => { events?.close(); clearInterval(poll); poll = setInterval(() => load(true), 4000); };
}
async function submitFollow() {
  if (!canFollow.value) return;
  followBusy.value = true; error.value = '';
  try {
    await api(`/api/conversations/${route.params.id}/turns`, { method: 'POST', body: { question: followQuestion.value, modelId: followModel.value, uploadId: uploadState.value.hasFiles ? uploadState.value.uploadId : null } });
    followQuestion.value = ''; await uploader.value?.clearAll(); uploadState.value = { uploadId: null, busy: false, failed: false, hasFiles: false, ready: true }; await load(true); await nextTick(); window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  } catch (e) { error.value = e.message; }
  finally { followBusy.value = false; }
}
function followKey(event) { if (shouldSubmit(event)) { event.preventDefault(); submitFollow(); } }
function startEdit(turn) { edit.value = { turnNo: turn.turnNo, question: String(turn.question), modelId: String(turn.modelId), busy: false, error: '' }; }
async function submitEdit() {
  if (!edit.value?.question.trim() || edit.value.busy) return;
  edit.value.busy = true; edit.value.error = '';
  try { await api(`/api/conversations/${route.params.id}/turns/${edit.value.turnNo}`, { method: 'PATCH', body: { question: edit.value.question, modelId: edit.value.modelId } }); edit.value = null; await load(true); }
  catch (e) { edit.value.error = e.message; edit.value.busy = false; }
}
async function toggleShare() {
  shareBusy.value = true;
  try { const result = await api(`/api/conversations/${route.params.id}/share`, { method: 'POST', body: { enabled: !data.value.shareEnabled } }); data.value.shareEnabled = result.shareEnabled; data.value.shareToken = result.shareToken; }
  finally { shareBusy.value = false; }
}
async function removeConversation() { if (!confirm('确定永久删除这整个对话及所有轮次附件吗？')) return; await api(`/api/conversations/${route.params.id}`, { method: 'DELETE' }); router.replace('/'); }
function modelLabel(id) { return publicConfig.models.find((model) => model.id === id)?.label || id; }
function statusText(status) { return ({ pending:'等待处理',compressing:'正在压缩附件',generating:'正在回答',completed:'已完成',error:'失败' })[status] || status; }
function formatSize(size) { return size < 1024 ** 2 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 ** 2).toFixed(1)} MB`; }
onMounted(async () => { await loadPublicConfig(); await load(); connect(); });
onBeforeUnmount(() => { events?.close(); clearInterval(poll); });
</script>

<template>
  <main class="page conversation-page">
    <div v-if="loading" class="card">加载中…</div>
    <template v-else-if="data">
      <header class="page-header conversation-header"><div><h1>{{ data.title }}</h1><p class="muted">{{ data.turns.length }} 轮对话</p></div><button class="button danger ghost" @click="removeConversation">删除对话</button></header>
      <section class="card share-panel">
        <div><strong>公开分享</strong><p class="muted">分享链接无需登录，可查看对话并下载每轮附件。</p></div>
        <div class="share-actions"><button class="button secondary" :disabled="shareBusy" @click="toggleShare">{{ data.shareEnabled ? '关闭分享' : '开启分享' }}</button><CopyButton v-if="data.shareEnabled" :text="shareUrl" label="复制分享链接" /></div>
        <input v-if="data.shareEnabled" :value="shareUrl" readonly />
      </section>
      <p v-if="error" class="error-box">{{ error }}</p>
      <section class="turn-list">
        <article v-for="turn in data.turns" :key="turn.turnNo" class="turn-card">
          <section class="message user-message">
            <div class="message-head"><strong>第 {{ turn.turnNo }} 次提问</strong><div class="message-actions"><span class="model-chip">{{ modelLabel(turn.modelId) }}</span><CopyButton :text="turn.question" label="复制问题" /><button type="button" class="button ghost compact" @click="startEdit(turn)">编辑</button></div></div>
            <template v-if="edit?.turnNo === turn.turnNo">
              <form class="edit-form" @submit.prevent="submitEdit">
                <label>模型<select v-model="edit.modelId"><option v-for="model in publicConfig.models" :key="model.id" :value="model.id">{{ model.label }}</option></select></label>
                <textarea v-model="edit.question" rows="6"></textarea>
                <p v-if="turn.hasAttachments" class="hint">本轮附件不可编辑；提交后会保留并重新用于模型请求。</p>
                <p v-if="edit.error" class="error-box">{{ edit.error }}</p>
                <div class="row-actions"><button type="button" class="button ghost" :disabled="edit.busy" @click="edit = null">取消</button><button class="button primary" :disabled="edit.busy || !edit.question.trim()">{{ edit.busy ? '提交中…' : '提交编辑' }}</button></div>
              </form>
            </template>
            <p v-else class="message-text">{{ turn.question }}</p>
            <div v-if="turn.hasAttachments" class="attachment-row">
              <span>本轮附件：{{ turn.attachmentReady ? `${formatSize(turn.attachmentSize)}` : '正在压缩，暂不可下载' }}</span>
              <a v-if="turn.attachmentReady" class="button secondary compact" :href="`/api/conversations/${data.id}/turns/${turn.turnNo}/attachments`">下载本轮附件包</a>
            </div>
          </section>
          <section class="message assistant-message">
            <div class="message-head"><strong>第 {{ turn.turnNo }} 次回答</strong><div class="message-actions"><span class="status-chip">{{ statusText(turn.status) }}</span><CopyButton :text="visibleAnswer(turn.answer)" label="复制回答" :disabled="!visibleAnswer(turn.answer)" /></div></div>
            <div v-if="['pending','compressing','generating'].includes(turn.status) && !turn.answer" class="pending"><span class="spinner"></span>{{ statusText(turn.status) }}</div>
            <AnswerContent v-if="turn.answer" :raw="turn.answer" />
          </section>
        </article>
      </section>
      <form class="card composer follow-composer" @submit.prevent="submitFollow">
        <h2>继续追问</h2>
        <p v-if="!['completed','error'].includes(lastTurn?.status)" class="hint">上一轮完成后才能追问。</p>
        <label>本轮模型<select v-model="followModel" :disabled="!['completed','error'].includes(lastTurn?.status)"><option v-for="model in publicConfig.models" :key="model.id" :value="model.id">{{ model.label }}</option></select></label>
        <label>追问<textarea v-model="followQuestion" rows="6" :disabled="!['completed','error'].includes(lastTurn?.status)" @keydown="followKey"></textarea></label>
        <AttachmentUploader ref="uploader" :disabled="followBusy || !['completed','error'].includes(lastTurn?.status)" @state="uploadState = $event" />
        <button class="button primary full" :disabled="!canFollow">{{ followBusy ? '提交中…' : uploadState.busy ? '请等待附件上传完成' : '提交追问' }}</button>
      </form>
    </template>
  </main>
</template>
