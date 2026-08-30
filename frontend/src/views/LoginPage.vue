<script setup>
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { loginWithToken } from '../state.js';

const route = useRoute();
const router = useRouter();
const token = ref('');
const error = ref('');
const submitting = ref(false);

function safeRedirect(value) {
  const candidate = typeof value === 'string' ? value : '/';
  return candidate.startsWith('/') && !candidate.startsWith('//') ? candidate : '/';
}

async function submit() {
  error.value = '';
  submitting.value = true;
  try {
    await loginWithToken(token.value);
    await router.replace(safeRedirect(route.query.redirect));
  } catch (loginError) {
    error.value = loginError.message;
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <main class="auth-page">
    <section class="auth-card" aria-labelledby="login-title">
      <div class="auth-brand"><span class="brand-mark">M</span><strong>模型问答</strong></div>
      <span class="eyebrow">TOKEN LOGIN</span>
      <h1 id="login-title">输入访问 token</h1>
      <p>token 由管理员在后端 config.json 中配置。登录后，本浏览器会保持登录状态，直到你退出或清除浏览器数据。</p>
      <form @submit.prevent="submit">
        <label for="login-token">访问 token</label>
        <input
          id="login-token"
          v-model="token"
          type="password"
          autocomplete="current-password"
          autocapitalize="none"
          spellcheck="false"
          :disabled="submitting"
          placeholder="请输入 token"
        />
        <p v-if="error" class="form-error" role="alert">{{ error }}</p>
        <button class="primary-button auth-submit" type="submit" :disabled="submitting || !token.trim()">
          <span v-if="submitting" class="spinner" aria-hidden="true"></span>
          {{ submitting ? '正在登录' : '登录' }}
        </button>
      </form>
      <p class="auth-security-note">通过纯 HTTP 访问时，网络中的中间设备可能看到 token 和内容；公网部署建议在反向代理层启用 HTTPS。</p>
    </section>
  </main>
</template>
