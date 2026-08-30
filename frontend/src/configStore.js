import { reactive } from 'vue';
import { api } from './api.js';
export const publicConfig = reactive({ ready: false, models: [], limits: {} });
let promise;
export async function loadPublicConfig() {
  if (!promise) promise = api('/api/config').then((data) => { publicConfig.models = data.models || []; publicConfig.limits = data.limits || {}; publicConfig.ready = true; return data; });
  return promise;
}
