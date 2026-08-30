<script setup>
import { onMounted, ref } from 'vue';
import { api } from '../api.js';
const conversations = ref([]); const loading = ref(true); const error = ref('');
async function load() { loading.value = true; try { conversations.value = (await api('/api/conversations')).conversations; } catch (e) { error.value = e.message; } finally { loading.value = false; } }
async function clearAll() {
  if (!conversations.value.length || !confirm('确定永久删除当前用户的全部对话和附件吗？')) return;
  await api('/api/conversations', { method: 'DELETE' }); await load();
}
function formatTime(value) { return new Date(value).toLocaleString(); }
onMounted(load);
</script>
<template>
  <main class="page narrow">
    <header class="page-header"><div><h1>问题历史</h1><p class="muted">不同登录 token 的历史记录互不可见。</p></div><router-link class="button primary" to="/new">新建提问</router-link></header>
    <div class="toolbar"><button class="button danger ghost" :disabled="!conversations.length" @click="clearAll">删除全部提问</button></div>
    <p v-if="error" class="error-box">{{ error }}</p>
    <div v-if="loading" class="card">加载中…</div>
    <div v-else-if="!conversations.length" class="card empty">还没有提问。</div>
    <div v-else class="history-list">
      <router-link v-for="item in conversations" :key="item.id" :to="`/chat/${item.id}`" class="card history-item">
        <div><h2>{{ item.title }}</h2><p class="muted">{{ item.turnCount }} 轮 · {{ formatTime(item.updatedAt) }}</p></div>
        <span class="status-chip">{{ item.latestStatus }}</span>
      </router-link>
    </div>
  </main>
</template>
