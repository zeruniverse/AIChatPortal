<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../api.js';
import { loadPublicConfig, publicConfig } from '../configStore.js';
import { visibleAnswer } from '../utils/answerParser.js';
import AnswerContent from '../components/AnswerContent.vue';
import CopyButton from '../components/CopyButton.vue';
const route = useRoute(); const data = ref(null); const loading = ref(true); const error = ref(''); let events; let poll;
async function load() { try { data.value = await api(`/api/public/shares/${route.params.token}`); error.value = ''; } catch (e) { error.value = e.message; } finally { loading.value = false; } }
function connect() { events = new EventSource(`/api/public/shares/${route.params.token}/events`); events.addEventListener('update', load); events.addEventListener('unavailable', () => { error.value = '分享链接已关闭或对话已删除'; data.value = null; }); events.onerror = () => { events?.close(); poll = setInterval(load, 5000); }; }
function modelLabel(id) { return publicConfig.models.find((model) => model.id === id)?.label || id; }
function statusText(status) { return ({ pending:'等待处理',compressing:'正在处理附件',generating:'正在回答',completed:'已完成',error:'失败' })[status] || status; }
function formatSize(size) { return size < 1024 ** 2 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 ** 2).toFixed(1)} MB`; }
onMounted(async () => { await loadPublicConfig(); await load(); if (data.value) connect(); });
onBeforeUnmount(() => { events?.close(); clearInterval(poll); });
</script>
<template>
  <main class="page conversation-page public-page">
    <div v-if="loading" class="card">加载中…</div>
    <p v-if="error" class="error-box">{{ error }}</p>
    <template v-if="data">
      <header class="page-header"><div><p class="eyebrow">分享的对话</p><h1>{{ data.title }}</h1></div></header>
      <section class="turn-list">
        <article v-for="turn in data.turns" :key="turn.turnNo" class="turn-card">
          <section class="message user-message">
            <div class="message-head"><strong>第 {{ turn.turnNo }} 次提问</strong><div class="message-actions"><span class="model-chip">{{ modelLabel(turn.modelId) }}</span><CopyButton :text="turn.question" label="复制问题" /></div></div>
            <p class="message-text">{{ turn.question }}</p>
            <div v-if="turn.hasAttachments" class="attachment-row"><span>本轮附件：{{ turn.attachmentReady ? formatSize(turn.attachmentSize) : '正在处理' }}</span><a v-if="turn.attachmentReady" class="button secondary compact" :href="`/api/public/shares/${route.params.token}/turns/${turn.turnNo}/attachments`">下载附件</a></div>
          </section>
          <section class="message assistant-message">
            <div class="message-head"><strong>第 {{ turn.turnNo }} 次回答</strong><div class="message-actions"><span class="status-chip">{{ statusText(turn.status) }}</span><CopyButton :text="visibleAnswer(turn.answer)" label="复制回答" :disabled="!visibleAnswer(turn.answer)" /></div></div>
            <div v-if="['pending','compressing','generating'].includes(turn.status) && !turn.answer" class="pending"><span class="spinner"></span>{{ statusText(turn.status) }}</div>
            <AnswerContent v-if="turn.answer" :raw="turn.answer" />
          </section>
        </article>
      </section>
    </template>
  </main>
</template>
