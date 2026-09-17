/**
 * E2E 用的控制台后端（真实 HTTP 服务 + 真实前端构建产物）。
 *
 * 复用了后端全部生产代码路径：真实的 Express 路由、真实的 configStore（原子写）、
 * 真实的 logTail（读真实文件）。**唯一被替换的是 OS 进程层**（proc/adapter）：
 * 它用的是测试夹具 fakeAdapter —— 因为本机是 macOS，M1 的进程实现只在 Windows 上工作
 * （非 Windows 会返回 501，无法驱动「启动/停止」的 UI 流程）。
 *
 * 也就是说：这个 E2E 覆盖的是「浏览器 → HTTP API → 状态机 → logTail → 浏览器」这条链路，
 * Windows 专属的 spawn/taskkill 行为仍然不在覆盖范围内（见报告「未验证清单」）。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../../server/src/config.js';
import { createConfigStore } from '../../server/src/db/configStore.js';
import { createProcManager } from '../../server/src/services/procManager.js';
import { createApp } from '../../server/src/app.js';
import { createFakeAdapter } from '../../server/testkit/fakeAdapter.js';
import { createSilentLogger } from '../../server/testkit/harness.js';

import { DATA_DIR, E2E_PORT, E2E_ROOT, SCRIPT, WORK_DIR } from './e2e-env.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(here, '..', 'dist');

const logger = createSilentLogger();

// 每次启动都从零开始，保证用例之间互不污染
await fs.rm(E2E_ROOT, { recursive: true, force: true });
await fs.mkdir(WORK_DIR, { recursive: true });
await fs.writeFile(SCRIPT, '@echo off\r\necho e2e service\r\n');

const config = loadConfig({
  LSC_DATA_DIR: DATA_DIR,
  LSC_SERVE_CLIENT: '1',
  LSC_CLIENT_DIST: clientDist,
  LSC_PORT: String(E2E_PORT),
  LSC_HOST: '127.0.0.1',
});

const store = createConfigStore({
  filePath: config.servicesFile,
  corruptBackupDir: config.corruptBackupDir,
  logger,
});
await store.init();

const adapter = createFakeAdapter({ firstPid: 7000 });
const procManager = createProcManager({
  adapter,
  store,
  config: {
    proc: {
      startVerifyDelayMs: 250,
      startFailureWindowMs: 2000,
      stopGraceTimeoutMs: 1000,
      exitPollIntervalMs: 100,
      diagBufferLines: 50,
    },
  },
  logger,
});

const app = createApp({ store, procManager, config, logger });

const server = app.listen(config.port, config.host, () => {
  process.stdout.write(`[e2e] 控制台就绪 http://${config.host}:${config.port}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    procManager.dispose();
    server.close(() => process.exit(0));
  });
}
