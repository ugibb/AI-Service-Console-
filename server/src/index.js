/**
 * 后端入口：装配依赖 → 监听端口。
 *
 * 启动失败必须显式报错退出（PRD §12「端口被占（3010）→ 启动报错并提示改配置，不得静默失败」）。
 * 退出时不杀子服务：PRD §9 明确「控制台自身退出后，已启动的子服务继续存活」。
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config as defaultConfig } from './config.js';
import { logger as defaultLogger } from './lib/logger.js';
import { createConfigStore } from './db/configStore.js';
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
  const procManager = createProcManager({ adapter, store, config: cfg, logger: logger.child('proc') });

  procManager.onStateChange((id, state) => {
    const service = store.get(id);
    logger.info(`[${service?.name ?? id}] ${state.status}${state.message ? ` - ${state.message}` : ''}`);
  });

  const app = createApp({ store, procManager, config: cfg, logger });
  return { store, procManager, adapter, app };
}

async function main() {
  const logger = defaultLogger;
  let runtime;
  try {
    runtime = await bootstrap({ cfg: defaultConfig, logger });
  } catch (err) {
    logger.error(`启动失败：${err.stack ?? err.message}`);
    process.exitCode = 1;
    return;
  }

  const { app, procManager } = runtime;
  const server = app.listen(defaultConfig.port, defaultConfig.host);

  server.on('listening', () => {
    logger.info(`控制台已就绪：http://${defaultConfig.host}:${defaultConfig.port}`);
    logger.info(`数据文件：${defaultConfig.servicesFile}`);
    logger.info(`适配器：${runtime.adapter.platform}${runtime.adapter.isSupported() ? '' : '（当前平台不支持启停操作）'}`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      logger.error(
        `端口 ${defaultConfig.port} 已被占用，控制台无法启动。` + `请关掉占用该端口的程序，或设置环境变量 LSC_PORT 换一个端口后重试。`,
      );
    } else if (err.code === 'EACCES') {
      logger.error(`没有权限绑定 ${defaultConfig.host}:${defaultConfig.port}：${err.message}`);
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
