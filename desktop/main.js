/**
 * Electron 主进程：桌面版外壳（见 `02-doc/02-design/030-desktop-packaging.md`）。
 *
 * 它做五件事，除此之外不碰任何业务逻辑：
 *   1. 单实例锁 —— 双击两次不会起两个控制台；
 *   2. 把数据目录定到 exe 同级（便携：拷走整个目录 = 带走全部配置）；
 *   3. 用系统分配端口在本机起后端（顺带消灭「3010 被占用起不来」这个历史问题）；
 *   4. 开窗口加载 `http://127.0.0.1:<port>` —— 前端一行都不用改；
 *   5. 退出时只做 `procManager.dispose()`，**绝不杀已启动的子服务**（PRD §9）。
 *
 * ⚠️ **调试时若看到 `app` 是 undefined，先查 `ELECTRON_RUN_AS_NODE`**。
 * 这个环境变量一旦存在，`electron.exe` 会退化成纯 Node 运行（`--version` 打的是 Node 版本
 * 而不是 Electron 版本），`import { app } from 'electron'` 拿到的自然全是 undefined。
 * 它会被父进程继承——从 IDE / 其他 Electron 应用里拉起调试时尤其容易中招。
 * 临时解法：`env -u ELECTRON_RUN_AS_NODE npx electron .`
 *
 * 两个容易踩的点：
 * - **没有控制台就没有 stdout**。任何启动期的失败都必须走 `dialog.showErrorBox`，
 *   否则用户看到的是「双击了没反应」。这是本文件里 `fail()` 存在的唯一理由。
 * - **窗口里的界面仍然是 HTTP**。HTTP 在这里只是进程内部实现细节，不对外暴露：
 *   始终绑 `127.0.0.1`，不做鉴权也不绑 `0.0.0.0`（见方案 §10-D6）。
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { app, BrowserWindow, dialog, shell } from 'electron';

const here = path.dirname(fileURLToPath(import.meta.url));

/** 后端打包产物（由 `npm run bundle:server` 生成），随 exe 一起打包进 asar */
const SERVER_BUNDLE = path.join(here, 'build', 'server.bundle.mjs');

/** 启动期失败：GUI 进程没有控制台可看，只能弹窗 */
function fail(title, message) {
  dialog.showErrorBox(title, message);
  app.exit(1);
}

/**
 * 数据目录：**默认在 exe 同级**，不写 `%APPDATA%`。
 *
 * 这样整个安装目录可以整体拷走（换机器、做备份都只是复制文件夹），
 * 也满足「不写注册表、不写用户目录」的便携预期。
 * 同时它必须在 asar 之外——asar 是只读归档，`services.json` 写不进去。
 *
 * `LSC_DATA_DIR` 仍然可以覆盖默认值：桌面版是「给默认值」，不是「锁死」，
 * 与 README 环境变量表里「所有路径都可用 LSC_* 覆盖」的约定保持一致。
 */
function resolveDataDir() {
  const override = process.env.LSC_DATA_DIR?.trim();
  if (override) return path.resolve(override);

  if (!app.isPackaged) return path.join(app.getAppPath(), 'data');
  // portable 目标下 electron-builder 会注入这个变量；取不到就退回 exe 所在目录
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
  if (portableDir) return path.join(portableDir, 'data');
  return path.join(path.dirname(app.getPath('exe')), 'data');
}

/**
 * 起后端，返回 { server, port, procManager, logger }。
 *
 * 端口默认交给系统分配（listen 0），而不是用配置里的 3010：
 * 桌面版没有「我得去访问 3010」这个需求，固定端口只会带来被占用的风险。
 * 仍保留 `LSC_PORT` 作为逃生口——有外部工具要固定端口时用得上。
 */
async function startServer() {
  if (!fs.existsSync(SERVER_BUNDLE)) {
    throw new Error(`缺少后端打包产物：${SERVER_BUNDLE}\n请先执行 npm run bundle:server 再启动。`);
  }

  const { loadConfig, bootstrap, createConsoleLogger } = await import(pathToFileURL(SERVER_BUNDLE).href);

  const dataDir = resolveDataDir();
  const cfg = loadConfig({
    ...process.env,
    LSC_HOST: '127.0.0.1',
    LSC_DATA_DIR: dataDir,
    LSC_SERVE_CLIENT: '1',
    LSC_CLIENT_DIST: path.join(app.getAppPath(), 'client', 'dist'),
  });

  const logger = createConsoleLogger(cfg);
  logger.info(`桌面版启动：data=${dataDir}，packaged=${app.isPackaged}`);

  const { app: expressApp, procManager } = await bootstrap({ cfg, logger });

  // 0 = 让系统挑一个空闲端口。注意这不能经 loadConfig 传（LSC_PORT 的合法范围是 1~65535，0 会被判非法回退）
  const requestedPort = Number.parseInt(process.env.LSC_PORT ?? '', 10);
  const port = Number.isInteger(requestedPort) && requestedPort > 0 ? requestedPort : 0;

  const server = expressApp.listen(port, cfg.host);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  const actualPort = server.address().port;
  logger.info(`控制台已就绪：http://${cfg.host}:${actualPort}`);
  logger.info(`控制台日志：${cfg.consoleLogFile}`);

  return { server, port: actualPort, procManager, logger, cfg };
}

/** 把启动期的技术性错误翻成用户能照着做的话 */
function describeStartupError(err, dataDir) {
  const logHint = `\n\n详细日志：${path.join(dataDir, 'logs', 'console.log')}`;
  if (err?.code === 'EADDRINUSE') {
    return { title: '端口被占用', message: `端口已被别的程序占用，控制台无法启动。${logHint}` };
  }
  if (err?.code === 'EACCES') {
    return { title: '权限不足', message: `没有权限监听本机端口。请换一个位置或换一个端口后重试。${logHint}` };
  }
  return { title: '控制台启动失败', message: `${err?.message ?? err}${logHint}` };
}

function createWindow(url) {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    title: 'AI 服务控制台',
    backgroundColor: '#12151b',
    // 先隐藏、等首帧就绪再显示，避免启动时闪一下白屏
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once('ready-to-show', () => win.show());

  // 界面只应该停留在本机这个地址上。外链一律丢给系统浏览器，
  // 免得窗口被导航走之后就再也回不来了（桌面版没有地址栏）
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, target) => {
    if (target.startsWith(url)) return;
    event.preventDefault();
    shell.openExternal(target);
  });

  win.loadURL(url);
  return win;
}

// 单实例锁：两个实例会各自起一个后端、各自往同一份 services.json 写，必须挡住
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let runtime = null;
  let mainWindow = null;

  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    // Windows 任务栏分组与通知归属
    app.setAppUserModelId('com.lsc.ai-service-console');

    try {
      runtime = await startServer();
    } catch (err) {
      const { title, message } = describeStartupError(err, resolveDataDir());
      fail(title, message);
      return;
    }

    mainWindow = createWindow(`http://127.0.0.1:${runtime.port}`);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow(`http://127.0.0.1:${runtime.port}`);
    });
  });

  app.on('window-all-closed', () => app.quit());

  app.on('before-quit', () => {
    // PRD §9：控制台退出后，已启动的子服务继续存活。
    // dispose() 只做内部清理（清定时器、卸监听），不发任何 kill 信号——这一点不能改。
    runtime?.procManager?.dispose();
  });
}
