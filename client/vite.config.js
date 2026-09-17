import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 后端地址是唯一需要与 server 侧保持一致的外部依赖。
 * 这里留一个环境变量入口，避免把主机端口写死在多处（PRD §10：单端口生产部署 / 开发模式代理）。
 */
const serverOrigin = process.env.LSC_SERVER_ORIGIN || 'http://127.0.0.1:3010';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
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
