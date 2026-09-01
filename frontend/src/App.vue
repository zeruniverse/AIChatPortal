<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { authState, logout } from './auth.js';
const route = useRoute(); const router = useRouter();
const showNav = computed(() => authState.authenticated && !route.meta.public);
const showScrollButton = computed(() => route.path !== '/login');
const atBottom = ref(false);
let pageResizeObserver;
function updateScrollPosition() {
  atBottom.value = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
}
function jumpPage() {
  window.scrollTo({ top: atBottom.value ? 0 : document.documentElement.scrollHeight, behavior: 'smooth' });
}
async function signOut() { await logout(); router.replace('/login'); }
onMounted(() => { updateScrollPosition(); window.addEventListener('scroll', updateScrollPosition, { passive: true }); window.addEventListener('resize', updateScrollPosition); pageResizeObserver = new ResizeObserver(updateScrollPosition); pageResizeObserver.observe(document.documentElement); });
onBeforeUnmount(() => { window.removeEventListener('scroll', updateScrollPosition); window.removeEventListener('resize', updateScrollPosition); pageResizeObserver?.disconnect(); });
watch(() => route.fullPath, () => nextTick(updateScrollPosition));
</script>
<template>
  <div class="app-shell">
    <header v-if="showNav" class="topbar">
      <router-link to="/" class="brand">模型聊天</router-link>
      <nav><router-link to="/">历史</router-link><router-link to="/new">提问</router-link><button type="button" class="link-button" @click="signOut">退出</button></nav>
    </header>
    <router-view />
    <button v-if="showScrollButton" type="button" class="scroll-fab" :title="atBottom ? '回到顶部' : '到达底部'" :aria-label="atBottom ? '回到顶部' : '到达底部'" @click="jumpPage">{{ atBottom ? '↑' : '↓' }}</button>
  </div>
</template>
