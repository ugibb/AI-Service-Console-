/**
 * 测试夹具：临时数据目录 + 假 .bat 文件 + 真实 configStore + fake 适配器的 procManager。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createConfigStore } from '../src/db/configStore.js';
import { createRuntimeStore } from '../src/db/runtimeStore.js';
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
      adoptedPollIntervalMs: 40,
      treeRefreshIntervalMs: 30,
      treeRefreshWindowMs: 400,
      ...overrides,
    },
  };
}

/**
 * 建一个可直接用的环境。services 里传的字段会覆盖默认值。
 *
 * adapter 可选：默认用 fakeAdapter；需要模拟「适配器行为不合契约」这类防御场景时，
 * 传一个自定义 stub 进来（见 procManagerDefensive.test.js）。
 * runtimeStore 默认建在临时目录（接管/清理路径默认在场）；测试旧边界时传 false 关掉。
 */
export async function makeHarness({ procConfig = {}, services = [], firstPid = 4000, adapter = null, runtimeStore = null } = {}) {
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

  const runtimeStoreInstance =
    runtimeStore ??
    createRuntimeStore({
      filePath: path.join(dir, 'data', 'runtime-3010.json'),
      corruptBackupDir: path.join(dir, 'data', 'corrupt'),
      logger: createSilentLogger(),
    });
  await runtimeStoreInstance.init();

  const procAdapter = adapter ?? createFakeAdapter({ firstPid });
  const procManager = createProcManager({
    adapter: procAdapter,
    store,
    config: makeProcConfig(procConfig),
    runtimeStore: runtimeStore === false ? null : runtimeStoreInstance,
    logger: createSilentLogger(),
  });

  return {
    dir,
    workDir,
    scriptPath,
    logFile,
    store,
    runtimeStore: runtimeStore === false ? null : runtimeStoreInstance,
    adapter: procAdapter,
    procManager,
    services: created,
  };
}

/**
 * 轮询等到接管档案里出现该服务的条目，返回它（超时则返回当时的值，可能是 null）。
 *
 * **不要用固定 sleep 代替它**：`start()` 里的 persistPid 是 fire-and-forget
 * （`void runtime.persistPid?.(id, pid)`，见 start.js:102），要先跑一次 wmic 快照再落盘。
 * 机器一忙，几十毫秒就不够——测试会在「档案还没写」时就 dispose/断言，
 * 于是对账无从接管、断言以「状态不是 adopted」失败，看着像产品缺陷，其实是测试自己抢跑。
 */
export async function waitForArchive(runtimeStore, id, { timeoutMs = 2000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let entry = runtimeStore.get(id);
  while (!entry && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    entry = runtimeStore.get(id);
  }
  return entry ?? null;
}

/**
 * 轮询等到接管档案里记的子树长到 n 个成员。
 *
 * 「等」是必须的：子树是启动窗口内**陆续**补记上去的（procManager.refreshTree 每个
 * treeRefreshIntervalMs 回看一眼），spawn 那一拍写下的往往只有一个壳。
 */
export async function waitForTreeSize(runtimeStore, id, size, { timeoutMs = 2000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let entry = runtimeStore.get(id);
  while ((entry?.tree?.length ?? 0) < size && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    entry = runtimeStore.get(id);
  }
  return entry ?? null;
}

/** 轮询等到某个服务落到指定状态（退出/接管的收尾可能是异步的，固定 sleep 会随机失败） */
export async function waitForStatus(procManager, id, status, { timeoutMs = 2000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let state = procManager.getState(id);
  while (state.status !== status && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    state = procManager.getState(id);
  }
  return state;
}

/** 轮询等到接管档案里的条目被清掉（终态清理是异步的，同样不能拿固定 sleep 赌） */
export async function waitForArchiveGone(runtimeStore, id, { timeoutMs = 2000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let entry = runtimeStore.get(id);
  while (entry && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    entry = runtimeStore.get(id);
  }
  return entry ?? null;
}

export { makeTempDir };
