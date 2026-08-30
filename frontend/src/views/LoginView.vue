<script setup>
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { login } from '../auth.js';
const token = ref(''); const show = ref(false); const error = ref(''); const busy = ref(false);
const route = useRoute(); const router = useRouter();
async function submit() {
  if (!token.value || busy.value) return;
  busy.value = true; error.value = '';
  try { await login(token.value); await router.replace(String(route.query.redirect || '/')); }
  catch (e) { error.value = e.message; }
  finally { busy.value = false; }
}
</script>
<template>
  <main class="center-page">
    <form class="card login-card" @submit.prevent="submit">
      <h1>登录</h1>
      <p class="muted">请输入你的访问码。</p>
      <input class="visually-hidden" name="username" autocomplete="username" value="token-user" tabindex="-1" />
      <label>访问码
        <div class="input-row"><input v-model="token" :type="show ? 'text' : 'password'" name="password" autocomplete="current-password" autofocus /><button type="button" class="button ghost" @click="show = !show">{{ show ? '隐藏' : '显示' }}</button></div>
      </label>
      <p v-if="error" class="error-box">{{ error }}</p>
      <button class="button primary full" :disabled="busy || !token">{{ busy ? '登录中…' : '登录' }}</button>
    </form>
  </main>
</template>
