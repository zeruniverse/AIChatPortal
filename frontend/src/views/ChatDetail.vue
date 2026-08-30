<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import FilePicker from '../components/FilePicker.vue';
import CopyTextButton from '../components/CopyTextButton.vue';
import ModelAnswer from '../components/ModelAnswer.vue';
import StatusPill from '../components/StatusPill.vue';
import { absoluteUrl, apiFetch, createFollowUp, formatBytes, formatDate } from '../api.js';
import { copyableAnswer } from '../answer-format.js';
import { submitOnShortcut } from '../keyboard-submit.js';
import { appState, clearPendingChat } from '../state.js';

const route = useRoute();
const router = useRouter();
const chat = ref(null);
const loading = ref(true);
const error = ref('');
const connectionState = ref('connecting');
const deleting = ref(false);
const changingShare = ref(false);
const followPrompt = ref('');
const followFiles = ref([]);
const followSubmitting = ref(false);
const followProgress = ref(0);
const editingTurnNo = ref(null);
const editPrompt = ref('');
const editingSubmitting = ref(false);
let eventSource;

const id = computed(() => String(route.params.id));
const shareLink = computed(() => absoluteUrl(chat.value?.shareUrl));
const latestTurn = computed(() => chat.value?.turns?.at(-1) || null);
const canFollowUp = computed(() => ['completed', 'failed'].includes(latestTurn.value?.status)
  && latestTurn.value?.attachmentReady
  && !followSubmitting.value
  && editingTurnNo.value === null);
const allAttachmentsReady = computed(() => {
  const attached = chat.value?.turns?.filter((turn) => turn.hasAttachments) || [];
  return attached.length > 0 && attached.every((turn) => turn.attachmentReady);
});
const pendingEntry = computed(() => appState.pendingChats[id.value]);
const initialUploadPending = computed(() => pendingEntry.value?.state === 'uploading');
const limits = computed(() => appState.config?.limits || {});

function cloneConversation(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function applyPayload(payload) {
  chat.value = payload;
  loading.value = false;
  error.value = '';
}

function optimisticInitial(entry) {
  if (!entry?.payload) return;
  applyPayload(entry.payload);
  const turn = chat.value.turns[0];
  turn.uploadProgress = entry.progress || 0;
}

async function fallbackLoad() {
  try { applyPayload(await apiFetch(`/api/chats/${id.value}`)); }
  catch (loadError) { error.value = loadError.message; }
  finally { loading.value = false; }
}

function connect() {
  eventSource?.close();
  connectionState.value = 'connecting';
  eventSource = new EventSource(`/api/chats/${id.value}/events`, { withCredentials: true });
  eventSource.addEventListener('open', () => { connectionState.value = 'connected'; });
  eventSource.addEventListener('snapshot', (event) => applyPayload(JSON.parse(event.data)));
  eventSource.addEventListener('update', (event) => {
    const payload = JSON.parse(event.data);
    if (payload.type === 'deleted') { eventSource.close(); router.replace('/history'); return; }
    if (payload.type === 'share' && chat.value) {
      chat.value.shared = payload.shared;
      chat.value.shareUrl = payload.shareUrl || null;
      return;
    }
    if (payload.type === 'conversation_reset') { void fallbackLoad(); return; }
    const turn = chat.value?.turns?.find((item) => item.turnNo === payload.turnNo);
    if (payload.type === 'attachment_ready' && turn) {
      turn.attachmentReady = true;
      turn.attachmentBytes = payload.attachmentBytes || 0;
      return;
    }
    if (payload.type === 'turn_status' && turn) {
      if (payload.status === 'running' && payload.attemptId !== turn.attemptId) {
        turn.answer = '';
        turn.deltaSequence = 0;
      }
      turn.status = payload.status;
      turn.attemptId = payload.attemptId || turn.attemptId;
      turn.error = payload.error || null;
      if (payload.status === 'failed') turn.answer = payload.error || '模型调用失败';
      chat.value.status = payload.status;
      return;
    }
    if (payload.type === 'delta' && turn && payload.attemptId === turn.attemptId) {
      const sequence = Number(payload.sequence);
      if (!Number.isSafeInteger(sequence) || sequence > (turn.deltaSequence || 0)) {
        turn.answer += payload.text;
        if (Number.isSafeInteger(sequence)) turn.deltaSequence = sequence;
      }
    }
  });
  eventSource.addEventListener('server_error', (event) => {
    try { error.value = JSON.parse(event.data).error || '无法读取对话状态'; }
    catch { error.value = '无法读取对话状态'; }
    connectionState.value = 'reconnecting';
  });
  eventSource.addEventListener('error', () => { connectionState.value = 'reconnecting'; });
}

watch(pendingEntry, (entry) => {
  if (!entry) return;
  if (entry.state === 'uploading') {
    if (!chat.value) optimisticInitial(entry);
    else if (chat.value.turns[0]) chat.value.turns[0].uploadProgress = entry.progress || 0;
  }
  if (entry.state === 'saved' && entry.result) {
    applyPayload(entry.result);
    clearPendingChat(id.value);
    connect();
  }
  if (entry.state === 'failed') {
    if (!chat.value) optimisticInitial(entry);
    if (chat.value?.turns?.[0]) {
      chat.value.turns[0].status = 'failed';
      chat.value.turns[0].answer = entry.error || '提交失败';
      chat.value.status = 'failed';
    }
    error.value = `问题未保存到服务器：${entry.error || '提交失败'}`;
  }
}, { deep: true, immediate: true });

async function setSharing(enabled) {
  changingShare.value = true;
  error.value = '';
  try {
    const updated = await apiFetch(`/api/chats/${id.value}/share`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }),
    });
    chat.value = { ...chat.value, ...updated };
  } catch (shareError) { error.value = shareError.message; }
  finally { changingShare.value = false; }
}

function handleFollowUpKeydown(event) {
  submitOnShortcut(event, () => { void submitFollowUp(); });
}

async function submitFollowUp() {
  const prompt = followPrompt.value.trim();
  if (!prompt || !canFollowUp.value) return;
  error.value = '';
  followSubmitting.value = true;
  followProgress.value = 0;
  const turnNo = (latestTurn.value?.turnNo || 0) + 1;
  const optimistic = {
    turnNo, prompt, answer: '', status: 'uploading', createdAt: new Date().toISOString(),
    hasAttachments: followFiles.value.length > 0, attachmentCount: followFiles.value.length,
    attachmentBytes: 0, attachmentReady: false, deltaSequence: 0, localOnly: true,
  };
  chat.value.turns.push(optimistic);
  chat.value.status = 'uploading';
  try {
    const result = await createFollowUp(id.value, {
      prompt, files: followFiles.value,
      onProgress: (progress) => { followProgress.value = progress; optimistic.uploadProgress = progress; },
    });
    applyPayload(result);
    followPrompt.value = '';
    followFiles.value = [];
    connect();
  } catch (submitError) {
    chat.value.turns = chat.value.turns.filter((turn) => turn !== optimistic);
    chat.value.status = latestTurn.value?.status || 'completed';
    error.value = submitError.message;
  } finally { followSubmitting.value = false; }
}

function startEdit(turn) {
  editingTurnNo.value = turn.turnNo;
  editPrompt.value = turn.prompt;
  error.value = '';
}
function cancelEdit() {
  editingTurnNo.value = null;
  editPrompt.value = '';
}
async function submitEdit(turn) {
  const prompt = editPrompt.value.trim();
  if (!prompt) { error.value = '问题不能为空'; return; }
  const later = chat.value.turns.filter((item) => item.turnNo > turn.turnNo).length;
  if (later && !window.confirm(`提交编辑后会永久删除后面的 ${later} 轮提问、回答和附件。确定继续吗？`)) return;
  editingSubmitting.value = true;
  error.value = '';
  const backup = cloneConversation(chat.value);
  chat.value.turns = chat.value.turns.filter((item) => item.turnNo <= turn.turnNo);
  const selected = chat.value.turns.at(-1);
  selected.prompt = prompt;
  selected.answer = '';
  selected.error = null;
  selected.status = 'queued';
  selected.attemptId = null;
  selected.deltaSequence = 0;
  chat.value.status = 'queued';
  editingTurnNo.value = null;
  try {
    const result = await apiFetch(`/api/chats/${id.value}/turns/${turn.turnNo}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt }),
    });
    applyPayload(result);
    connect();
  } catch (editError) {
    chat.value = backup;
    editingTurnNo.value = turn.turnNo;
    error.value = editError.message;
  } finally { editingSubmitting.value = false; }
}

async function remove() {
  if (!window.confirm('确定删除整个对话、所有轮次回答和全部附件吗？')) return;
  deleting.value = true;
  try {
    eventSource?.close();
    await apiFetch(`/api/chats/${id.value}`, { method: 'DELETE' });
    await router.replace('/history');
  } catch (deleteError) { error.value = deleteError.message; deleting.value = false; }
}

onMounted(() => {
  if (pendingEntry.value) optimisticInitial(pendingEntry.value);
  else fallbackLoad().then(() => { if (chat.value) connect(); });
});
onBeforeUnmount(() => { eventSource?.close(); });
</script>

<template>
  <div class="page chat-detail-page">
    <header class="detail-toolbar">
      <button class="back-button" type="button" @click="router.push('/history')">‹ <span>返回历史</span></button>
      <div class="detail-actions">
        <a v-if="allAttachmentsReady" class="secondary-button" :href="`/api/chats/${id}/attachments`">下载全部轮次附件</a>
        <button class="icon-danger" type="button" :disabled="deleting || initialUploadPending" @click="remove">删除对话</button>
      </div>
    </header>

    <div v-if="loading" class="detail-loading"><span class="spinner"></span>正在加载…</div>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>

    <article v-if="chat" class="conversation">
      <header class="conversation-meta">
        <StatusPill :status="chat.status" />
        <span>{{ chat.modelLabel }}</span>
        <time :datetime="chat.createdAt">{{ formatDate(chat.createdAt) }}</time>
        <span>{{ chat.turns.length }} 轮对话</span>
        <span v-if="chat.hasAttachments">共 {{ chat.attachmentCount }} 个附件</span>
        <span v-if="chat.shared" class="shared-badge">已公开分享</span>
      </header>

      <section class="share-panel" :class="{ active: chat.shared }">
        <div><strong>{{ chat.shared ? '公开分享已开启' : '公开分享未开启' }}</strong><p>链接持有者无需登录即可查看全部轮次，并下载每轮附件包或全部轮次附件。</p></div>
        <div class="share-controls">
          <template v-if="chat.shared">
            <input class="share-link-input" :value="shareLink" readonly aria-label="分享链接" />
            <CopyTextButton class="secondary-button" :text="shareLink" idle-label="复制链接" copied-label="已复制" />
            <button class="danger-button compact-button" type="button" :disabled="changingShare || initialUploadPending" @click="setSharing(false)">关闭分享</button>
          </template>
          <button v-else class="primary-button compact-button" type="button" :disabled="changingShare || initialUploadPending" @click="setSharing(true)">{{ changingShare ? '处理中…' : '开启分享' }}</button>
        </div>
      </section>

      <div v-for="turn in chat.turns" :key="turn.turnNo" class="turn-block">
        <section class="message user-message">
          <div class="message-label">
            <span>你</span><strong>第 {{ turn.turnNo }} 次提问</strong>
            <div class="message-label-actions">
              <CopyTextButton :text="turn.prompt" idle-label="复制问题" />
              <button class="message-edit-button" type="button" :disabled="editingSubmitting || followSubmitting || turn.localOnly || turn.status === 'uploading'" @click="startEdit(turn)">编辑</button>
            </div>
          </div>
          <form v-if="editingTurnNo === turn.turnNo" class="inline-edit-form" @submit.prevent="submitEdit(turn)">
            <textarea v-model="editPrompt" rows="5" :maxlength="limits.maxPromptChars || 100000" :disabled="editingSubmitting"></textarea>
            <p class="edit-attachment-note">本轮附件不可编辑：不能新增、删除或替换。提交后，本轮旧回答及其后的所有轮次将被永久删除并重新生成。</p>
            <div class="inline-edit-actions">
              <button class="secondary-button" type="button" :disabled="editingSubmitting" @click="cancelEdit">取消</button>
              <button class="primary-button" type="submit" :disabled="editingSubmitting || !editPrompt.trim()"><span v-if="editingSubmitting" class="spinner"></span>提交编辑</button>
            </div>
          </form>
          <div v-else class="plain-content">{{ turn.prompt }}</div>
          <div v-if="turn.hasAttachments" class="turn-attachments">
            <span>{{ turn.attachmentCount }} 个附件<span v-if="turn.attachmentReady"> · {{ formatBytes(turn.attachmentBytes) }}</span></span>
            <a v-if="turn.attachmentReady" class="small-download" :href="`/api/chats/${id}/turns/${turn.turnNo}/attachments`">下载本轮附件包</a>
            <span v-else class="attachment-pending"><span class="spinner"></span>{{ turn.status === 'uploading' ? `上传中 ${Math.round((turn.uploadProgress || 0) * 100)}%` : turn.status === 'failed' ? '附件处理失败，暂不可下载' : '正在后台压缩，暂不可下载' }}</span>
          </div>
        </section>

        <section class="message assistant-message">
          <div class="message-label">
            <span>M</span><strong>第 {{ turn.turnNo }} 次回答</strong>
            <div class="message-label-actions">
              <StatusPill :status="turn.status" />
              <CopyTextButton :text="copyableAnswer(turn.answer)" idle-label="复制回答" />
            </div>
          </div>
          <div v-if="turn.answer" class="answer-content" :class="{ 'answer-error': turn.status === 'failed' }"><ModelAnswer :content="turn.answer" :pending="!['completed', 'failed'].includes(turn.status)" /></div>
          <div v-else-if="turn.status === 'failed'" class="answer-placeholder failed-placeholder">模型调用失败，但没有可显示的错误详情。</div>
          <div v-else class="answer-placeholder">
            <span class="thinking-dots"><i></i><i></i><i></i></span>
            <div><strong>{{ turn.status === 'uploading' ? '正在上传附件' : turn.status === 'preparing' ? '正在以最高级别压缩附件' : turn.status === 'queued' ? '等待任务开始' : '正在等待模型返回' }}</strong><p>provider 最长可能约 2 小时才返回第一个 token，可安全关闭页面。</p></div>
          </div>
        </section>
      </div>

      <form v-if="canFollowUp" class="follow-up-composer" @submit.prevent="submitFollowUp">
        <div class="field-group"><label for="follow-prompt">继续追问</label><textarea id="follow-prompt" v-model="followPrompt" rows="5" :maxlength="limits.maxPromptChars || 100000" placeholder="输入新的追问……" @keydown="handleFollowUpKeydown"></textarea></div>
        <FilePicker v-model="followFiles" :disabled="followSubmitting" :max-files="limits.maxFiles || 100" :max-raw-bytes="limits.maxRawUploadBytes || 536870912" @error="error = $event" />
        <p class="follow-up-note">新附件会单独保存为第 {{ (latestTurn?.turnNo || 0) + 1 }} 轮 ZIP；发给模型时，服务器会把从 1.zip 到本轮的所有轮次 ZIP 再打包并藏入图片。</p>
        <button class="primary-button submit-button" type="submit" :disabled="!followPrompt.trim() || followSubmitting"><span v-if="followSubmitting" class="spinner"></span>{{ followSubmitting ? `上传中 ${Math.round(followProgress * 100)}%` : '提交追问' }}</button>
      </form>
      <div v-else-if="latestTurn && !['completed', 'failed'].includes(latestTurn.status)" class="connection-note">当前轮次完成后即可继续追问。</div>
      <div v-else-if="latestTurn && !latestTurn.attachmentReady" class="connection-note error-note">上一轮附件未成功形成 ZIP，不能继续追问。请编辑该轮重新执行，或删除整个对话。</div>
      <div v-if="connectionState === 'reconnecting'" class="connection-note">页面实时连接暂时中断，正在自动恢复；服务器任务仍在继续。</div>
    </article>
  </div>
</template>
