import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';
import LoginView from './views/LoginView.vue';
import HistoryView from './views/HistoryView.vue';
import NewView from './views/NewView.vue';
import ConversationView from './views/ConversationView.vue';
import ShareView from './views/ShareView.vue';
import { authState, initAuth } from './auth.js';
import './styles.css';

const routes = [
  { path: '/login', component: LoginView, meta: { public: true } },
  { path: '/share/:token', component: ShareView, meta: { public: true } },
  { path: '/', component: HistoryView },
  { path: '/new', component: NewView },
  { path: '/chat/:id', component: ConversationView }
];
const router = createRouter({ history: createWebHistory(), routes, scrollBehavior: () => ({ top: 0 }) });
router.beforeEach(async (to) => {
  await initAuth();
  if (to.meta.public) return true;
  if (!authState.authenticated) return { path: '/login', query: { redirect: to.fullPath } };
  return true;
});
createApp(App).use(router).mount('#app');
