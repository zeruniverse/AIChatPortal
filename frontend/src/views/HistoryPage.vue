<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import StatusPill from '../components/StatusPill.vue';
import { apiFetch, formatBytes, formatDate } from '../api.js';

const PAGE_SIZE = 100;
const router = useRouter();
const chats = ref([]);
const total = ref(0);
const loading = ref(true);
const loadingMore = ref(false);
const error = ref('');
const deleting = ref(false);
let pollTimer;
const hasMore = computed(() => chats.value.length < total.value);

async function load({ silent = false, append = false } = {}) {
  if (append) loadingMore.value = true;
  else if (!silent) loading.value = true;
  try {
    const offset = append ? chats.value.length : 0;
    const result = await apiFetch(`/api/chats?limit=${PAGE_SIZE}&offset=${offset}`);
    if (append) {
      const known = new Set(chats.value.map((chat) => chat.id));
      chats.value = [...chats.value, ...result.items.filter((chat) => !known.has(chat.id))];
    } else {
      const tail = chats.value.slice(PAGE_SIZE);
      const refreshedIds = new Set(result.items.map((chat) => chat.id));
      chats.value = [...result.items, ...tail.filter((chat) => !refreshedIds.has(chat.id))];
    }
    total.value = result.total;
    error.value = '';
  } catch (loadError) {
    error.value = loadError.message;
  } finally {
    loading.value = false;
    loadingMore.value = false;
  }
}

async function deleteAll() {
  if (!chats.value.length) return;
  if (!window.confirm('确定删除全部问题、回答和附件吗？此操作无法撤销。')) return;
  deleting.value = true;
  try {
    await apiFetch('/api/chats', { method: 'DELETE' });
    chats.value = [];
    total.value = 0;
  } catch (deleteError) {
    error.value = deleteError.message;
  } finally {
    deleting.value = false;
  }
}

onMounted(() => {
  load();
  pollTimer = window.setInterval(() => load({ silent: true }), 5000);
});
onBeforeUnmount(() => window.clearInterval(pollTimer));
</script>

<template>
  <div class="page history-page">
    <header class="page-heading history-heading">
      <div>
        <span class="eyebrow">HISTORY</span>
        <h1>问题历史</h1>
        <p>所有记录均保存在服务器的 chat 文件夹中。</p>
      </div>
      <button class="danger-button" type="button" :disabled="deleting || !chats.length" @click="deleteAll">
        {{ deleting ? '正在删除…' : '删除全部' }}
      </button>
    </header>

    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    <div v-if="loading" class="skeleton-list" aria-label="正在加载">
      <div v-for="n in 4" :key="n" class="skeleton-card"></div>
    </div>
    <div v-else-if="!chats.length" class="empty-state">
      <span>⌁</span>
      <h2>还没有问题</h2>
      <p>提交第一个问题后，它会出现在这里。</p>
      <button class="primary-button" type="button" @click="router.push('/')">开始提问</button>
    </div>
    <template v-else>
      <ol class="history-list">
        <li v-for="chat in chats" :key="chat.id">
          <button class="history-card" type="button" @click="router.push(`/chat/${chat.id}`)">
            <div class="history-card-top">
              <StatusPill :status="chat.status" />
              <time :datetime="chat.createdAt">{{ formatDate(chat.createdAt) }}</time>
            </div>
            <h2>{{ chat.title }}</h2>
            <p>{{ chat.promptPreview }}</p>
            <div class="history-meta">
              <span>{{ chat.modelLabel }}</span>
              <span v-if="chat.hasAttachments">{{ chat.attachmentCount }} 个附件 · {{ formatBytes(chat.attachmentBytes) }}</span>
              <span v-if="chat.shared" class="shared-badge">已分享</span>
            </div>
          </button>
        </li>
      </ol>
      <div class="history-pagination">
        <button v-if="hasMore" class="secondary-button load-more-button" type="button" :disabled="loadingMore" @click="load({ append: true })">
          {{ loadingMore ? '正在加载…' : `加载更多（已显示 ${chats.length} / ${total}）` }}
        </button>
        <span v-else>已显示全部 {{ total }} 条记录</span>
      </div>
    </template>
  </div>
</template>
