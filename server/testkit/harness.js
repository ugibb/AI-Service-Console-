/**
 * 测试夹具：临时数据目录 + 假 .bat 文件 + 真实 configStore + fake 适配器的 procManager。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createConfigStore } from '../src/db/configStore.js';
import { createProcManager } from '../src/services/procManager.js';
import { createFakeAdapter } from './fakeAdapter.js';
import { makeTempDir } from './tmp.js';

export function createSilentLogger() {
  const noop = () => {};
  const logger = { debug: noop, info: noop, warn: noop, error: noop };
  logger.child = () => logger;
  return logger;
}

/** 小时间参数，让状态机测试跑得快 */
export function makeProcConfig(overrides = {}) {
  return {
    proc: {
      startVerifyDelayMs: 40,
      startFailureWindowMs: 150,
      stopGraceTimeoutMs: 200,
      exitPollIntervalMs: 20,
      diagBufferLines: 50,
      ...overrides,
    },
  };
}

/**
 * 建一个可直接用的环境。services 里传的字段会覆盖默认值。
 *
 * adapter 可选：默认用 fakeAdapter；需要模拟「适配器行为不合契约」这类防御场景时，
 * 传一个自定义 stub 进来（见 procManagerDefensive.test.js）。
 */
export async function makeHarness({ procConfig = {}, services = [], firstPid = 4000, adapter = null } = {}) {
  const dir = await makeTempDir();
  const workDir = path.join(dir, 'svc');
  await fs.mkdir(workDir, { recursive: true });
  const scriptPath = path.join(workDir, 'run.bat');
  await fs.writeFile(scriptPath, '@echo off\r\necho service starting\r\n');
  const logFile = path.join(workDir, 'service.log');

  const store = createConfigStore({
    filePath: path.join(dir, 'data', 'services.json'),
    corruptBackupDir: path.join(dir, 'data', 'corrupt'),
    logger: createSilentLogger(),
  });
  await store.init();

  const created = [];
  for (const input of services) {
    created.push(await store.create({ name: input.name ?? 'svc', workDir, startScript: scriptPath, logFile, ...input }));
  }

  const procAdapter = adapter ?? createFakeAdapter({ firstPid });
  const procManager = createProcManager({
    adapter: procAdapter,
    store,
    config: makeProcConfig(procConfig),
    logger: createSilentLogger(),
  });

  return { dir, workDir, scriptPath, logFile, store, adapter: procAdapter, procManager, services: created };
}

export { makeTempDir };
