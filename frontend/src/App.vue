<script setup>
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { authState, logout } from './auth.js';
const route = useRoute(); const router = useRouter();
const showNav = computed(() => authState.authenticated && !route.meta.public);
async function signOut() { await logout(); router.replace('/login'); }
</script>
<template>
  <div class="app-shell">
    <header v-if="showNav" class="topbar">
      <router-link to="/" class="brand">模型聊天</router-link>
      <nav><router-link to="/">历史</router-link><router-link to="/new">提问</router-link><button type="button" class="link-button" @click="signOut">退出</button></nav>
    </header>
    <router-view />
  </div>
</template>
