<script setup>
import { onMounted, ref } from 'vue';
import { api } from '../api.js';
const conversations = ref([]); const loading = ref(true); const error = ref('');
async function load() { loading.value = true; try { conversations.value = (await api('/api/conversations')).conversations; } catch (e) { error.value = e.message; } finally { loading.value = false; } }
async function clearAll() {
  if (!conversations.value.length || !confirm('确定删除全部对话和附件吗？')) return;
  await api('/api/conversations', { method: 'DELETE' }); await load();
}
function formatTime(value) { return new Date(value).toLocaleString(); }
function statusText(status) { return ({ pending:'等待处理',compressing:'正在处理',generating:'正在回答',completed:'已完成',error:'失败' })[status] || status; }
onMounted(load);
</script>
<template>
  <main class="page narrow">
    <header class="page-header history-header">
      <div><h1>问题历史</h1><p class="muted">这里会显示你的提问记录。</p></div>
      <div class="header-actions">
        <button class="button danger ghost" :disabled="!conversations.length" @click="clearAll">删除全部提问</button>
        <router-link class="button primary" to="/new">新建提问</router-link>
      </div>
    </header>
    <p v-if="error" class="error-box">{{ error }}</p>
    <div v-if="loading" class="card">加载中…</div>
    <div v-else-if="!conversations.length" class="card empty">还没有提问。</div>
    <div v-else class="history-list">
      <router-link v-for="item in conversations" :key="item.id" :to="`/chat/${item.id}`" class="card history-item">
        <div><h2>{{ item.title }}</h2><p class="muted">{{ item.turnCount }} 轮 · {{ formatTime(item.updatedAt) }}</p></div>
        <span class="status-chip">{{ statusText(item.latestStatus) }}</span>
      </router-link>
    </div>
  </main>
</template>
