<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import MarkdownBlock from '../components/MarkdownBlock.vue';
import StatusPill from '../components/StatusPill.vue';
import { ApiError, apiFetch, formatBytes, formatDate } from '../api.js';

const route = useRoute();
const chat = ref(null);
const prompt = ref('');
const answer = ref('');
const currentAttemptId = ref(null);
const currentDeltaSequence = ref(0);
const loading = ref(true);
const error = ref('');
const connectionState = ref('connecting');
let eventSource;
let accessCheckPromise = null;

const shareToken = computed(() => String(route.params.shareToken || ''));
const isFinal = computed(() => ['completed', 'failed'].includes(chat.value?.status));

function unavailable() {
  eventSource?.close();
  chat.value = null;
  loading.value = false;
  error.value = '分享链接不存在、已关闭，或对应问题已删除。';
}

function verifyShareAccess() {
  if (accessCheckPromise) return accessCheckPromise;
  accessCheckPromise = apiFetch(`/api/public/shares/${shareToken.value}`)
    .then((payload) => {
      if (!chat.value) return;
      chat.value = payload;
      prompt.value = payload.prompt;
      answer.value = payload.answer;
      currentAttemptId.value = payload.attemptId;
      currentDeltaSequence.value = Number(payload.deltaSequence) || 0;
    })
    .catch((checkError) => {
      if (checkError instanceof ApiError && checkError.status === 404) unavailable();
    })
    .finally(() => { accessCheckPromise = null; });
  return accessCheckPromise;
}

function connect() {
  eventSource?.close();
  connectionState.value = 'connecting';
  eventSource = new EventSource(`/api/public/shares/${shareToken.value}/events`);
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
    if (['completed', 'failed'].includes(payload.chat.status)) connectionState.value = 'finished';
  });
  eventSource.addEventListener('update', (event) => {
    const payload = JSON.parse(event.data);
    if (payload.type === 'share_unavailable' || payload.type === 'deleted') {
      unavailable();
      return;
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
      if (['completed', 'failed'].includes(payload.status)) connectionState.value = 'finished';
    }
    if (payload.type === 'delta' && payload.attemptId === currentAttemptId.value) {
      const sequence = Number(payload.sequence);
      if (!Number.isSafeInteger(sequence) || sequence > currentDeltaSequence.value) {
        answer.value += payload.text;
        if (Number.isSafeInteger(sequence)) currentDeltaSequence.value = sequence;
      }
    }
  });
  eventSource.addEventListener('server_error', () => {
    connectionState.value = 'reconnecting';
  });
  eventSource.addEventListener('error', () => {
    if (chat.value) {
      connectionState.value = 'reconnecting';
      void verifyShareAccess();
    }
  });
}

async function fallbackLoad() {
  try {
    const payload = await apiFetch(`/api/public/shares/${shareToken.value}`);
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

onMounted(() => {
  fallbackLoad().then(() => {
    if (chat.value) connect();
  });
});
onBeforeUnmount(() => eventSource?.close());
</script>

<template>
  <main class="public-share-page">
    <header class="public-share-header">
      <div class="auth-brand"><span class="brand-mark">M</span><strong>模型问答</strong></div>
      <span class="public-label">公开分享</span>
    </header>

    <div v-if="loading" class="public-loading"><span class="spinner"></span>正在加载分享内容…</div>
    <section v-else-if="error && !chat" class="public-error-card">
      <h1>无法打开分享</h1>
      <p>{{ error }}</p>
      <RouterLink class="secondary-button" to="/login">登录应用</RouterLink>
    </section>

    <article v-else-if="chat" class="public-conversation conversation">
      <header class="public-title-block">
        <span class="eyebrow">SHARED QUESTION</span>
        <h1>{{ chat.title }}</h1>
        <div class="conversation-meta">
          <StatusPill :status="chat.status" />
          <span>{{ chat.modelLabel }}</span>
          <time :datetime="chat.createdAt">{{ formatDate(chat.createdAt) }}</time>
          <span v-if="chat.hasAttachments">{{ chat.attachmentCount }} 个附件 · {{ formatBytes(chat.attachmentBytes) }}</span>
        </div>
        <a
          v-if="chat.hasAttachments"
          class="primary-button public-download"
          :href="`/api/public/shares/${shareToken}/attachments`"
        >下载全部附件</a>
      </header>

      <p v-if="error" class="form-error" role="alert">{{ error }}</p>

      <section class="message user-message">
        <div class="message-label"><span>Q</span><strong>问题</strong></div>
        <div class="plain-content">{{ prompt }}</div>
      </section>

      <section class="message assistant-message">
        <div class="message-label"><span>M</span><strong>回答</strong></div>
        <div v-if="answer" class="answer-content" :class="{ 'answer-error': chat.status === 'failed' }"><MarkdownBlock :content="answer" /></div>
        <div v-else-if="chat.status === 'failed'" class="answer-placeholder failed-placeholder">模型调用失败，但没有可显示的错误详情。</div>
        <div v-else class="answer-placeholder">
          <span class="thinking-dots"><i></i><i></i><i></i></span>
          <div>
            <strong>{{ chat.status === 'queued' ? '等待任务开始' : '正在等待模型返回' }}</strong>
            <p>这是实时分享页面，回答返回后会自动显示。</p>
          </div>
        </div>
      </section>

      <div v-if="connectionState === 'reconnecting' && !isFinal" class="connection-note">页面连接暂时中断，正在自动恢复；服务器任务仍在继续。</div>
      <footer class="public-footer">此页面凭不可猜测的分享链接公开访问，无需登录。链接持有者也可下载该问题的全部附件。</footer>
    </article>
  </main>
</template>
