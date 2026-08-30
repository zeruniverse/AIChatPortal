<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import MarkdownBlock from '../components/MarkdownBlock.vue';
import StatusPill from '../components/StatusPill.vue';
import { apiFetch, formatBytes, formatDate } from '../api.js';

const route = useRoute();
const shareToken = computed(() => String(route.params.shareToken || ''));
const chat = ref(null);
const loading = ref(true);
const error = ref('');
const connectionState = ref('connecting');
let eventSource;

const allAttachmentsReady = computed(() => {
  const attached = chat.value?.turns?.filter((turn) => turn.hasAttachments) || [];
  return attached.length > 0 && attached.every((turn) => turn.attachmentReady);
});

function findTurn(payload) {
  return chat.value?.turns?.find((turn) => turn.turnNo === payload.turnNo);
}

function unavailable() {
  eventSource?.close();
  chat.value = null;
  error.value = '分享链接不存在、已关闭，或对应对话已被删除。';
  loading.value = false;
}

async function loadShare() {
  try {
    chat.value = await apiFetch(`/api/public/shares/${shareToken.value}`);
    error.value = '';
  } catch (loadError) {
    if (loadError.status === 404) unavailable();
    else error.value = loadError.message;
  } finally { loading.value = false; }
}

function connect() {
  eventSource?.close();
  connectionState.value = 'connecting';
  eventSource = new EventSource(`/api/public/shares/${shareToken.value}/events`);
  eventSource.addEventListener('open', () => { connectionState.value = 'connected'; });
  eventSource.addEventListener('snapshot', (event) => {
    chat.value = JSON.parse(event.data);
    loading.value = false;
    error.value = '';
  });
  eventSource.addEventListener('update', (event) => {
    const payload = JSON.parse(event.data);
    if (payload.type === 'share_unavailable' || payload.type === 'deleted') return unavailable();
    if (payload.type === 'conversation_reset') { void loadShare(); return; }
    if (payload.type === 'attachment_ready') {
      const turn = findTurn(payload);
      if (!turn) { void loadShare(); return; }
      turn.attachmentReady = true;
      turn.attachmentBytes = payload.attachmentBytes || 0;
      return;
    }
    if (payload.type === 'turn_status') {
      const turn = findTurn(payload);
      if (!turn) { void loadShare(); return; }
      if (payload.status === 'running' && payload.attemptId !== turn.attemptId) {
        turn.answer = '';
        turn.deltaSequence = 0;
      }
      turn.status = payload.status;
      turn.error = payload.error || null;
      turn.attemptId = payload.attemptId || turn.attemptId;
      if (payload.status === 'failed') turn.answer = payload.error || '模型调用失败';
      if (chat.value.turns.at(-1)?.turnNo === turn.turnNo) chat.value.status = payload.status;
      return;
    }
    if (payload.type === 'delta') {
      const turn = findTurn(payload);
      if (!turn || payload.attemptId !== turn.attemptId) return;
      const sequence = Number(payload.sequence);
      if (!Number.isSafeInteger(sequence) || sequence > Number(turn.deltaSequence || 0)) {
        turn.answer += payload.text;
        if (Number.isSafeInteger(sequence)) turn.deltaSequence = sequence;
      }
    }
  });
  eventSource.addEventListener('server_error', () => { connectionState.value = 'reconnecting'; });
  eventSource.addEventListener('error', () => {
    connectionState.value = 'reconnecting';
    void loadShare();
  });
}

onMounted(async () => { await loadShare(); if (chat.value) connect(); });
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
      <h1>无法打开分享</h1><p>{{ error }}</p><RouterLink class="secondary-button" to="/login">登录应用</RouterLink>
    </section>

    <article v-else-if="chat" class="public-conversation conversation multi-turn-conversation">
      <header class="public-title-block">
        <span class="eyebrow">SHARED CONVERSATION</span>
        <h1>{{ chat.title }}</h1>
        <div class="conversation-meta">
          <StatusPill :status="chat.status" />
          <span>{{ chat.modelLabel }}</span>
          <time :datetime="chat.createdAt">{{ formatDate(chat.createdAt) }}</time>
          <span>{{ chat.turnCount || chat.turns.length }} 轮</span>
          <span v-if="chat.hasAttachments">{{ chat.attachmentCount }} 个附件 · {{ formatBytes(chat.attachmentBytes) }}</span>
        </div>
        <a v-if="allAttachmentsReady" class="primary-button public-download" :href="`/api/public/shares/${shareToken}/attachments`">下载全部轮次附件</a>
        <span v-else-if="chat.hasAttachments" class="attachment-pending"><span class="spinner small-spinner"></span>仍有附件正在压缩，暂不可下载全部附件</span>
      </header>

      <p v-if="error" class="form-error" role="alert">{{ error }}</p>

      <div v-for="turn in chat.turns" :key="turn.turnNo" class="turn-block">
        <section class="message user-message">
          <div class="message-label"><span>Q</span><strong>第 {{ turn.turnNo }} 次提问</strong></div>
          <div class="message-body">
            <div class="plain-content">{{ turn.prompt }}</div>
            <div class="turn-tools">
              <a v-if="turn.hasAttachments && turn.attachmentReady" class="text-button" :href="`/api/public/shares/${shareToken}/turns/${turn.turnNo}/attachments`">下载本轮全部附件</a>
              <span v-else-if="turn.hasAttachments && turn.status === 'failed'" class="attachment-pending">附件处理失败，暂不可下载</span>
              <span v-else-if="turn.hasAttachments" class="attachment-pending"><span class="spinner small-spinner"></span>附件正在压缩，暂不可下载</span>
              <span v-else class="muted-note">本轮无附件</span>
            </div>
          </div>
        </section>

        <section class="message assistant-message">
          <div class="message-label"><span>M</span><strong>第 {{ turn.turnNo }} 次回答</strong><StatusPill :status="turn.status" /></div>
          <div class="message-body">
            <div v-if="turn.answer" class="answer-content" :class="{ 'answer-error': turn.status === 'failed' }"><MarkdownBlock :content="turn.answer" /></div>
            <div v-else-if="turn.status === 'failed'" class="answer-placeholder failed-placeholder">模型调用失败，但没有可显示的错误详情。</div>
            <div v-else class="answer-placeholder">
              <span class="thinking-dots"><i></i><i></i><i></i></span>
              <div>
                <strong>{{ turn.status === 'preparing' ? '正在后台压缩附件' : turn.status === 'queued' ? '等待任务开始' : '正在等待模型返回' }}</strong>
                <p>这是实时分享页面，处理完成后会自动显示。</p>
              </div>
            </div>
          </div>
        </section>
      </div>

      <div v-if="connectionState === 'reconnecting'" class="connection-note">页面连接暂时中断，正在自动恢复；服务器任务仍在继续。</div>
      <footer class="public-footer">此页面凭不可猜测的分享链接公开访问。链接持有者可查看全部轮次，并下载已经压缩完成的附件包。</footer>
    </article>
  </main>
</template>
