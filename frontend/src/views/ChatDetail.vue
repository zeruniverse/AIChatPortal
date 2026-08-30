<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import MarkdownBlock from '../components/MarkdownBlock.vue';
import StatusPill from '../components/StatusPill.vue';
import { absoluteUrl, apiFetch, formatBytes, formatDate } from '../api.js';

const route = useRoute();
const router = useRouter();
const chat = ref(null);
const prompt = ref('');
const answer = ref('');
const currentAttemptId = ref(null);
const currentDeltaSequence = ref(0);
const loading = ref(true);
const error = ref('');
const connectionState = ref('connecting');
const deleting = ref(false);
const changingShare = ref(false);
const copied = ref(false);
let eventSource;
let copiedTimer;

const isFinal = computed(() => ['completed', 'failed'].includes(chat.value?.status));
const shareLink = computed(() => absoluteUrl(chat.value?.shareUrl));

function connect() {
  eventSource?.close();
  connectionState.value = 'connecting';
  eventSource = new EventSource(`/api/chats/${route.params.id}/events`, { withCredentials: true });
  eventSource.addEventListener('open', () => { connectionState.value = 'connected'; });
  eventSource.addEventListener('snapshot', (event) => {
    const payload = JSON.parse(event.data);
    chat.value = payload.chat;
    prompt.value = payload.prompt;
    answer.value = payload.answer;
    currentAttemptId.value = payload.chat.attemptId;
    currentDeltaSequence.value = Number(payload.deltaSequence) || 0;
    loading.value = false;
    error.value = '';
    if (['completed', 'failed'].includes(payload.chat.status)) {
      connectionState.value = 'finished';
      eventSource.close();
    }
  });
  eventSource.addEventListener('update', (event) => {
    const payload = JSON.parse(event.data);
    if (payload.type === 'deleted') {
      eventSource.close();
      router.replace('/history');
      return;
    }
    if (payload.type === 'share' && chat.value) {
      chat.value.shared = payload.shared;
      chat.value.shareUrl = payload.shareUrl || null;
    }
    if (payload.type === 'status') {
      if (payload.status === 'running' && payload.attemptId !== currentAttemptId.value) {
        answer.value = '';
        currentAttemptId.value = payload.attemptId;
        currentDeltaSequence.value = 0;
      }
      if (chat.value) {
        chat.value.status = payload.status;
        chat.value.error = payload.error || null;
        chat.value.attemptId = payload.attemptId || chat.value.attemptId;
      }
      if (payload.status === 'failed') {
        answer.value = payload.error || '模型调用失败';
      }
      if (['completed', 'failed'].includes(payload.status)) {
        connectionState.value = 'finished';
        eventSource.close();
      }
    }
    if (payload.type === 'delta' && payload.attemptId === currentAttemptId.value) {
      const sequence = Number(payload.sequence);
      if (!Number.isSafeInteger(sequence) || sequence > currentDeltaSequence.value) {
        answer.value += payload.text;
        if (Number.isSafeInteger(sequence)) currentDeltaSequence.value = sequence;
      }
    }
  });
  eventSource.addEventListener('server_error', (event) => {
    try {
      const payload = JSON.parse(event.data);
      error.value = payload.error || '无法读取任务状态';
    } catch {
      error.value = '无法读取任务状态';
    }
    connectionState.value = 'reconnecting';
  });
  eventSource.addEventListener('error', () => {
    if (!isFinal.value) connectionState.value = 'reconnecting';
  });
}

async function fallbackLoad() {
  try {
    const payload = await apiFetch(`/api/chats/${route.params.id}`);
    chat.value = payload;
    prompt.value = payload.prompt;
    answer.value = payload.answer;
    currentAttemptId.value = payload.attemptId;
    currentDeltaSequence.value = Number(payload.deltaSequence) || 0;
    if (isFinal.value) connectionState.value = 'finished';
  } catch (loadError) {
    error.value = loadError.message;
  } finally {
    loading.value = false;
  }
}

async function setSharing(enabled) {
  changingShare.value = true;
  error.value = '';
  try {
    const updated = await apiFetch(`/api/chats/${route.params.id}/share`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    chat.value = { ...chat.value, ...updated };
    copied.value = false;
  } catch (shareError) {
    error.value = shareError.message;
  } finally {
    changingShare.value = false;
  }
}

async function copyShareLink() {
  try {
    await navigator.clipboard.writeText(shareLink.value);
    copied.value = true;
    window.clearTimeout(copiedTimer);
    copiedTimer = window.setTimeout(() => { copied.value = false; }, 1800);
  } catch {
    window.prompt('复制这个分享链接：', shareLink.value);
  }
}

async function remove() {
  if (!window.confirm('确定删除这个问题、回答和全部附件吗？')) return;
  deleting.value = true;
  try {
    eventSource?.close();
    await apiFetch(`/api/chats/${route.params.id}`, { method: 'DELETE' });
    await router.replace('/history');
  } catch (deleteError) {
    error.value = deleteError.message;
    deleting.value = false;
  }
}

onMounted(() => {
  fallbackLoad().then(() => {
    if (!isFinal.value && !error.value) connect();
  });
});
onBeforeUnmount(() => {
  eventSource?.close();
  window.clearTimeout(copiedTimer);
});
</script>

<template>
  <div class="page chat-detail-page">
    <header class="detail-toolbar">
      <button class="back-button" type="button" @click="router.push('/history')">‹ <span>返回历史</span></button>
      <div class="detail-actions">
        <a v-if="chat?.hasAttachments" class="secondary-button" :href="`/api/chats/${route.params.id}/attachments`">下载附件包</a>
        <button class="icon-danger" type="button" :disabled="deleting" aria-label="删除问题" @click="remove">删除</button>
      </div>
    </header>

    <div v-if="loading" class="detail-loading"><span class="spinner"></span>正在加载…</div>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>

    <article v-if="chat" class="conversation">
      <header class="conversation-meta">
        <StatusPill :status="chat.status" />
        <span>{{ chat.modelLabel }}</span>
        <time :datetime="chat.createdAt">{{ formatDate(chat.createdAt) }}</time>
        <span v-if="chat.hasAttachments">{{ chat.attachmentCount }} 个附件 · {{ formatBytes(chat.attachmentBytes) }}</span>
        <span v-if="chat.shared" class="shared-badge">已公开分享</span>
      </header>

      <section class="share-panel" :class="{ active: chat.shared }">
        <div>
          <strong>{{ chat.shared ? '公开分享已开启' : '公开分享未开启' }}</strong>
          <p>开启后，任何获得链接的人都无需登录即可查看问题、回答，并下载全部附件。关闭后原链接立即失效。</p>
        </div>
        <div class="share-controls">
          <template v-if="chat.shared">
            <input class="share-link-input" :value="shareLink" readonly aria-label="分享链接" />
            <button class="secondary-button" type="button" @click="copyShareLink">{{ copied ? '已复制' : '复制链接' }}</button>
            <button class="danger-button compact-button" type="button" :disabled="changingShare" @click="setSharing(false)">关闭分享</button>
          </template>
          <button v-else class="primary-button compact-button" type="button" :disabled="changingShare" @click="setSharing(true)">
            {{ changingShare ? '处理中…' : '开启分享' }}
          </button>
        </div>
      </section>

      <section class="message user-message">
        <div class="message-label"><span>你</span><strong>问题</strong></div>
        <div class="plain-content">{{ prompt }}</div>
      </section>

      <section class="message assistant-message">
        <div class="message-label"><span>M</span><strong>回答</strong></div>
        <div v-if="answer" class="answer-content" :class="{ 'answer-error': chat.status === 'failed' }"><MarkdownBlock :content="answer" /></div>
        <div v-else-if="chat.status === 'failed'" class="answer-placeholder failed-placeholder">模型调用失败，但没有可显示的错误详情。</div>
        <div v-else class="answer-placeholder">
          <span class="thinking-dots"><i></i><i></i><i></i></span>
          <div>
            <strong>{{ chat.status === 'queued' ? '等待可用任务槽位' : '正在等待模型返回' }}</strong>
            <p>provider 最长可能需要约 2 小时才返回第一个 token。可安全关闭本页面。</p>
          </div>
        </div>
      </section>

      <div v-if="connectionState === 'reconnecting' && !isFinal" class="connection-note">页面连接暂时中断，正在自动恢复；服务器任务仍在继续。</div>
      <div class="conversation-footer">
        <RouterLink class="primary-button" to="/">提交新问题</RouterLink>
        <span>本应用不支持追问，每个问题都是独立任务。</span>
      </div>
    </article>
  </div>
</template>
