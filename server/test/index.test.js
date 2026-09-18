/**
 * 进程入口（src/index.js）测试。
 *
 * 这里补的是「进程级」行为——listen 成功/失败、信号关闭、装配时把状态流转写进日志。
 * 前两项只有在真实子进程里才有意义（模块内的 main() 只在被直接执行时调用），
 * 因此用 spawn 起 `node src/index.js` 来验，而不是去 mock process。
 *
 * 平台无关：EADDRINUSE、SIGTERM、监听回调在 macOS 与 Windows 上语义一致。
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { bootstrap, selectAdapter } from '../src/index.js';
import { createWin32Adapter } from '../src/proc/win32.js';
import { loadConfig } from '../src/config.js';
import { createSilentLogger } from '../testkit/harness.js';
import { cleanupTempDirs, makeTempDir } from '../testkit/tmp.js';

after(cleanupTempDirs);

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(SERVER_ROOT, 'src', 'index.js');

/** 占住一个端口，返回 { port, release } */
async function occupyPort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    port: server.address().port,
    release: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** 起一个真实的后端子进程，收集 stdout/stderr，返回退出码与文本 */
function runEntry(env, { killAfter } = {}) {
  const child = spawn(process.execPath, [ENTRY], {
    cwd: SERVER_ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });

  const exited = once(child, 'exit').then(([code, signal]) => ({ code, signal }));
  return {
    child,
    exited,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    killAfter,
  };
}

/** 轮询等待条件成立（避免依赖固定 sleep 时长造成的抖动） */
async function waitFor(predicate, { timeoutMs = 8000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

// ——————————————————————————————————————————————
// 装配层：状态流转回调（覆盖 index.js 的 onStateChange 分支）
// ——————————————————————————————————————————————

test('bootstrap：服务状态流转会写进控制台日志（启动 → 启动失败可见）', async () => {
  const dir = await makeTempDir();
  const logged = [];
  const logger = createSilentLogger();
  logger.info = (message) => logged.push(message);
  const warn = [];
  logger.warn = (message) => warn.push(message);

  const cfg = loadConfig({ LSC_DATA_DIR: path.join(dir, 'data'), LSC_SERVE_CLIENT: '0', LSC_PROC_ADAPTER: 'unsupported' });
  const runtime = await bootstrap({ cfg, logger });

  const service = await runtime.store.create({
    name: '订单服务',
    workDir: dir,
    startScript: path.join(dir, 'start.bat'),
    logFile: path.join(dir, 'app.log'),
  });

  // 非 Windows 上适配器是占位实现：start 会走到 start_failed，但状态流转必须先发生
  const state = await runtime.procManager.start(service.id);
  assert.equal(state.status, 'start_failed');
  assert.ok(
    logged.some((line) => line.includes('[订单服务]') && line.includes('starting')),
    `应记录 starting 状态，实际：${JSON.stringify(logged)}`,
  );
  assert.ok(
    logged.some((line) => line.includes('[订单服务]') && line.includes('start_failed')),
    `应记录 start_failed 状态，实际：${JSON.stringify(logged)}`,
  );
});

test('selectAdapter：platform 为 win32 时返回真实 Windows 适配器', () => {
  const original = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  try {
    const adapter = selectAdapter({ adapter: 'win32' }, createSilentLogger());
    assert.equal(adapter.platform, 'win32');
    assert.equal(adapter.isSupported(), true);
    // 与直接构造的适配器同构（同一个工厂产出）
    assert.deepEqual(Object.keys(adapter).sort(), Object.keys(createWin32Adapter({ logger: createSilentLogger() })).sort());
  } finally {
    Object.defineProperty(process, 'platform', { value: original, configurable: true });
  }
});

// ——————————————————————————————————————————————
// 进程级：真实子进程（覆盖 main() 的 listen / error / shutdown 分支）
// ——————————————————————————————————————————————

test('main：端口被占用 → 明确报错并非 0 退出，不静默失败（PRD §12「端口被占」）', async () => {
  const occupied = await occupyPort();
  const dir = await makeTempDir();
  const proc = runEntry({
    LSC_PORT: String(occupied.port),
    LSC_HOST: '127.0.0.1',
    LSC_DATA_DIR: path.join(dir, 'data'),
    LSC_SERVE_CLIENT: '0',
  });

  try {
    const { code } = await proc.exited;
    assert.equal(code, 1, '端口被占应显式以退出码 1 结束');
    assert.match(proc.stderr, /已被占用/);
    assert.match(proc.stderr, /LSC_PORT/, '应提示如何改端口，而不是让人干瞪眼');
  } finally {
    if (proc.child.exitCode === null && proc.child.signalCode === null) proc.child.kill('SIGKILL');
    await occupied.release();
  }
});

test('main：正常启动打印就绪信息，收到 SIGTERM 优雅退出（退出码 0）', async () => {
  const free = await occupyPort();
  const port = free.port;
  await free.release();

  const dir = await makeTempDir();
  const proc = runEntry({
    LSC_PORT: String(port),
    LSC_HOST: '127.0.0.1',
    LSC_DATA_DIR: path.join(dir, 'data'),
    LSC_SERVE_CLIENT: '0',
  });

  try {
    const ready = await waitFor(() => proc.stdout.includes('控制台已就绪'));
    assert.ok(ready, `应在 stdout 打印就绪信息，实际：${proc.stdout}`);

    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.status, 'ok');

    // Windows 上 process.kill(pid,'SIGTERM') 是**无条件强杀**（等价 TerminateProcess）：
    // 退出码为 null、信号为 SIGTERM，进程里的 on('SIGTERM') 处理器根本不会执行
    // （Node 文档明说 SIGTERM 在 Windows 上无法投递）。所以「优雅退出」这段在 Windows 上不可达，
    // 只能用别的手段验证；这里只验跨平台成立的部分（起来了 + health 正常）。
    if (process.platform === 'win32') {
      proc.child.kill('SIGTERM');
      await proc.exited;
      return;
    }

    proc.child.kill('SIGTERM');
    const { code } = await proc.exited;
    assert.equal(code, 0, 'SIGTERM 应触发优雅退出');
    assert.match(proc.stdout, /收到 SIGTERM/);
    assert.match(proc.stdout, /已启动的子服务不会被停止/, 'PRD §9：控制台退出不杀子服务，日志里要说清楚');
  } finally {
    if (proc.child.exitCode === null && proc.child.signalCode === null) proc.child.kill('SIGKILL');
  }
});
