import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';
import LoginPage from './views/LoginPage.vue';
import NewChat from './views/NewChat.vue';
import HistoryPage from './views/HistoryPage.vue';
import ChatDetail from './views/ChatDetail.vue';
import PublicShare from './views/PublicShare.vue';
import { ensureAuthenticated } from './state.js';
import './styles.css';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', name: 'login', component: LoginPage, meta: { public: true, bare: true } },
    { path: '/share/:shareToken', name: 'share', component: PublicShare, meta: { public: true, bare: true } },
    { path: '/', name: 'new', component: NewChat },
    { path: '/history', name: 'history', component: HistoryPage },
    { path: '/chat/:id', name: 'chat', component: ChatDetail },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
  scrollBehavior: () => ({ top: 0 }),
});

router.beforeEach(async (to) => {
  if (to.name === 'share') return true;
  const authenticated = await ensureAuthenticated();
  if (to.name === 'login') return authenticated ? { name: 'new' } : true;
  if (authenticated) return true;
  return {
    name: 'login',
    query: { redirect: to.fullPath },
    replace: true,
  };
});

createApp(App).use(router).mount('#app');
