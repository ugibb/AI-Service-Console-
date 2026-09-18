import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { DEV_CLIENT_PORT, PROFILES } from '../server/src/profiles.js';

/**
 * 后端地址与前端端口都取自 server 侧的**环境档案**（server/src/profiles.js）。
 *
 * 此前这里另写了一份 `http://127.0.0.1:3010`，与服务端 config.js 的默认端口重复：
 * 改一处漏一处，代理就会静默指向另一个服务。现在开发档的端口只有那一个定义处。
 * `LSC_SERVER_ORIGIN` 仍保留为逃生口（PRD §10：单端口生产部署 / 开发模式代理）。
 */
const serverOrigin = process.env.LSC_SERVER_ORIGIN || `http://127.0.0.1:${PROFILES.development.port}`;

export default defineConfig({
  plugins: [react()],
  server: {
    /**
     * 显式绑 IPv4：Vite 默认 host 是 `localhost`，在 Windows 上会解析成 `::1` 只绑 IPv6，
     * 于是 `http://127.0.0.1:5173` 拒连、`http://localhost:5173` 才通。文档和习惯用语都是
     * 前者，照着敲会以为环境坏了。顺带与「默认仅监听 127.0.0.1」的既有姿态一致。
     */
    host: '127.0.0.1',
    port: DEV_CLIENT_PORT,
    strictPort: false,
    proxy: {
      '/api': { target: serverOrigin, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.js'],
    include: ['src/**/*.test.{js,jsx}'],
    css: false,
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.{js,jsx}'],
      exclude: ['src/main.jsx', 'src/test/**', 'src/**/*.test.{js,jsx}'],
    },
  },
});
