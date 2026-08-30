import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'node:path';

export default defineConfig({
  root: path.resolve('frontend'),
  plugins: [vue()],
  build: {
    outDir: path.resolve('dist'),
    emptyOutDir: true,
    sourcemap: false
  },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3000' }
  }
});
