/**
 * 后端入口：装配依赖 → 监听端口。
 *
 * 启动失败必须显式报错退出（PRD §12「端口被占（3010）→ 启动报错并提示改配置，不得静默失败」）。
 * 退出时不杀子服务：PRD §9 明确「控制台自身退出后，已启动的子服务继续存活」。
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config as defaultConfig, loadConfig, PROJECT_ROOT } from './config.js';
import { DEFAULT_PROFILE, PROFILES, overriddenKeys, profileEnv, readProfileArg } from './profiles.js';
import { createLogger, logger as defaultLogger } from './lib/logger.js';
import { createMultiSink, createRotatingFileSink } from './lib/fileSink.js';
import { createConfigStore } from './db/configStore.js';
import { createRuntimeStore } from './db/runtimeStore.js';
import { createProcManager } from './services/procManager.js';
import { createWin32Adapter } from './proc/win32.js';
import { createUnsupportedAdapter, UNSUPPORTED_MESSAGE } from './proc/adapter.js';
import { createApp } from './app.js';

/**
 * 适配器选择：默认 win32，但只有真在 Windows 上才启用，否则用占位适配器明确报错
 * （而不是在 macOS 上假装能启停）。
 */
export function selectAdapter(cfg, logger) {
  if (cfg.adapter !== 'win32') return createUnsupportedAdapter();
  if (process.platform !== 'win32') {
    logger.warn(`当前平台 ${process.platform} 不是 Windows：${UNSUPPORTED_MESSAGE}`);
    return createUnsupportedAdapter();
  }
  return createWin32Adapter({ logger });
}

/**
 * 装配全部依赖（不监听端口，便于测试直接注入）
 */
export async function bootstrap({ cfg = defaultConfig, logger = defaultLogger } = {}) {
  for (const warning of cfg.warnings) logger.warn(`配置告警：${warning}`);

  const store = createConfigStore({
    filePath: cfg.servicesFile,
    corruptBackupDir: cfg.corruptBackupDir,
    logger: logger.child('store'),
  });
  const { warnings } = await store.init();
  for (const warning of warnings) logger.warn(`配置告警：${warning}`);

  const adapter = selectAdapter(cfg, logger.child('proc'));

  const runtimeStore = createRuntimeStore({ filePath: cfg.runtimeFile, logger: logger.child('runtime') });
  await runtimeStore.init();

  const procManager = createProcManager({ adapter, store, config: cfg, runtimeStore, logger: logger.child('proc') });

  procManager.onStateChange((id, state) => {
    const service = store.get(id);
    logger.info(`[${service?.name ?? id}] ${state.status}${state.message ? ` - ${state.message}` : ''}`);
  });

  // 开机对账：上个会话启动、且验明正身仍在跑的进程，接管为 adopted 状态。
  // 必须在 createApp 之前完成——首个列表接口给出的就该是真实状态，不能先谎报 stopped 再翻供。
  await procManager.reconcileAdopted();

  const app = createApp({ store, procManager, config: cfg, logger });
  return { store, procManager, adapter, app };
}

/**
 * 构造控制台自己的日志器：stdout/stderr **+ 落盘文件**。
 *
 * 桌面版（Electron）没有控制台窗口，stdout 进黑洞；落盘是现场排障的唯一途径，
 * 所以这里默认开启，而不是让调用方自己记得开。纯 CLI 场景（`start.bat`）开着也无害。
 *
 * 导出给 `desktop/main.js` 复用——桌面版必须用同一个日志器，
 * 否则「控制台起不来」时 Electron 那边和 Express 这边各说各话。
 *
 * @param {object} cfg loadConfig() 的产物
 */
export function createConsoleLogger(cfg) {
  if (!cfg.consoleLogEnabled) return defaultLogger;

  const fileSink = createRotatingFileSink({
    filePath: cfg.consoleLogFile,
    maxBytes: cfg.consoleLogMaxBytes,
    maxBackups: cfg.consoleLogMaxBackups,
  });

  const logger = createLogger({
    level: process.env.LSC_LOG_LEVEL || 'info',
    scope: 'console',
    sink: createMultiSink([process.stdout, fileSink]),
    errorSink: createMultiSink([process.stderr, fileSink]),
  });

  // 落盘失败不能让控制台起不来，但必须让人知道「你现在查不到日志」——否则排障时会白找
  if (fileSink.lastError) {
    logger.warn(`控制台日志无法写入 ${cfg.consoleLogFile}：${fileSink.lastError.message}（本次仅输出到标准输出）`);
  }
  return logger;
}

/**
 * 解析本次启动用哪个环境档案。
 *
 * 名字**只从 argv 取**（不看环境变量，理由见 profiles.js 文件头），认不出的名字直接退出而不是
 * 回退默认档：`--env=dev` 这种笔误若静默落到生产档，人会以为自己在开发、实际在写生产台账，
 * 而 3010 上通常已经有一个控制台在跑。
 *
 * 档案只提供默认值，显式环境变量优先（见 profileEnv）——所以 `overridden` 要报出来，
 * 否则「档案写着 3011、实际起在 3010」在现场是没法解释的。
 */
function resolveProfile() {
  let name;
  try {
    name = readProfileArg(process.argv) ?? DEFAULT_PROFILE;
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
  return {
    name,
    label: PROFILES[name].label,
    cfg: loadConfig({ ...process.env, ...profileEnv(name, { root: PROJECT_ROOT }) }),
    overridden: overriddenKeys(name, { root: PROJECT_ROOT }),
  };
}

async function main() {
  const { name: profileName, label: profileLabel, cfg, overridden } = resolveProfile();
  const logger = createConsoleLogger(cfg);
  let runtime;
  try {
    runtime = await bootstrap({ cfg, logger });
  } catch (err) {
    logger.error(`启动失败：${err.stack ?? err.message}`);
    process.exitCode = 1;
    return;
  }

  const { app, procManager } = runtime;
  const server = app.listen(cfg.port, cfg.host);

  server.on('listening', () => {
    // 环境名打在最前面：同时开着开发档与生产档时，两个窗口的第一行就能区分。
    // 打印的是**生效值**而非档案值——环境变量覆盖过什么，这里必须看得见。
    logger.info(`环境：${profileLabel}（--env=${profileName}）`);
    logger.info(`控制台已就绪：http://${cfg.host}:${cfg.port}`);
    logger.info(`数据文件：${cfg.servicesFile}`);
    if (cfg.serveClient) logger.info(`前端：托管构建产物 ${cfg.clientDistDir}`);
    else logger.info(`前端：未托管（本档只出 API，界面由 Vite dev server 提供，见 npm run dev:client）`);
    if (cfg.consoleLogEnabled) logger.info(`控制台日志：${cfg.consoleLogFile}`);
    logger.info(`适配器：${runtime.adapter.platform}${runtime.adapter.isSupported() ? '' : '（当前平台不支持启停操作）'}`);
    if (overridden.length > 0) {
      logger.warn(`档案「${profileLabel}」的默认值被环境变量覆盖：${overridden.join('、')}（以上为生效值）`);
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      logger.error(`端口 ${cfg.port} 已被占用，控制台无法启动。` + `请关掉占用该端口的程序，或设置环境变量 LSC_PORT 换一个端口后重试。`);
    } else if (err.code === 'EACCES') {
      logger.error(`没有权限绑定 ${cfg.host}:${cfg.port}：${err.message}`);
    } else {
      logger.error(`HTTP 服务异常：${err.stack ?? err.message}`);
    }
    process.exitCode = 1;
    process.exit(1);
  });

  const shutdown = (signal) => {
    logger.info(`收到 ${signal}，正在关闭控制台（已启动的子服务不会被停止）…`);
    procManager.dispose();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  main();
}
