<script setup>
import { computed, watch } from 'vue';
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router';
import { appState, loadAppConfig, logout } from './state.js';

const route = useRoute();
const router = useRouter();
const privateLayout = computed(() => !route.meta.public);

watch(
  () => route.fullPath,
  () => {
    if (privateLayout.value && appState.user) loadAppConfig().catch(() => {});
  },
  { immediate: true },
);

async function signOut() {
  await logout();
  await router.replace('/login');
}
</script>

<template>
  <div class="app-shell" :class="{ 'public-shell': !privateLayout }">
    <aside v-if="privateLayout" class="desktop-sidebar" aria-label="主导航">
      <RouterLink class="brand" to="/" aria-label="模型问答首页">
        <span class="brand-mark">M</span>
        <span><strong>模型问答</strong><small>单轮 · 本地存储</small></span>
      </RouterLink>
      <nav class="sidebar-nav">
        <RouterLink to="/" exact-active-class="active"><span>＋</span>新问题</RouterLink>
        <RouterLink to="/history" active-class="active"><span>⌕</span>问题历史</RouterLink>
      </nav>
      <div class="sidebar-account">
        <strong>{{ appState.user?.label }}</strong>
        <small>不同 token 的记录互相隔离</small>
        <button type="button" @click="signOut">退出登录</button>
      </div>
      <div class="sidebar-note">
        <span class="privacy-dot"></span>
        <p>关闭页面不会停止已提交任务。任务状态保存在服务器本地。</p>
      </div>
    </aside>

    <main class="main-panel">
      <header v-if="privateLayout" class="mobile-header">
        <RouterLink class="mobile-brand" to="/">
          <span class="brand-mark">M</span><strong>模型问答</strong>
        </RouterLink>
        <button class="mobile-logout" type="button" @click="signOut">退出</button>
      </header>
      <div v-if="privateLayout && appState.error" class="global-error" role="alert">
        {{ appState.error }}
        <button type="button" @click="loadAppConfig(true).catch(() => {})">重试</button>
      </div>
      <RouterView />
    </main>

    <nav v-if="privateLayout" class="mobile-nav" aria-label="移动端主导航">
      <RouterLink to="/" exact-active-class="active"><span>＋</span><small>新问题</small></RouterLink>
      <RouterLink to="/history" active-class="active"><span>⌕</span><small>历史</small></RouterLink>
    </nav>
  </div>
</template>
