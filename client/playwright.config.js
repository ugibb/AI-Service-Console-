import { defineConfig, devices } from '@playwright/test';
import { E2E_PORT } from './e2e/e2e-env.mjs';

/**
 * 浏览器 E2E 配置（Playwright）。
 *
 * 与 vitest 完全分开：vitest 只跑 `src/**`(jsdom 组件测试)，这里只跑 `e2e/*.spec.js`（真实浏览器）。
 * 用系统 Chrome（channel: 'chrome'）而不是下载 Chromium，避免引入上百 MB 的浏览器下载。
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.js',
  timeout: 45_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${E2E_PORT}`,
    trace: 'off',
    video: 'off',
  },
  projects: [
    {
      name: 'chrome',
      use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    },
  ],
  webServer: {
    command: 'node e2e/console-server.mjs',
    url: `http://127.0.0.1:${E2E_PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { E2E_PORT: String(E2E_PORT) },
  },
});
