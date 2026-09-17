/**
 * 装配层测试（T1.9 / M0 骨架）：验证 bootstrap 能真正把依赖接起来。
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { bootstrap, selectAdapter } from '../src/index.js';
import { createSilentLogger } from '../testkit/harness.js';
import { cleanupTempDirs, makeTempDir } from '../testkit/tmp.js';

after(cleanupTempDirs);

test('selectAdapter：配置为 win32 但当前不是 Windows → 占位适配器（拒绝启停而不是假装成功）', async () => {
  const logger = createSilentLogger();
  const warnings = [];
  logger.warn = (message) => warnings.push(message);

  const adapter = selectAdapter({ adapter: 'win32' }, logger);
  if (process.platform === 'win32') {
    assert.equal(adapter.isSupported(), true);
  } else {
    assert.equal(adapter.isSupported(), false);
    assert.equal(adapter.platform, process.platform);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /仅在 Windows 上可用/);

    await assert.rejects(() => adapter.spawn({ scriptPath: 'x.bat', workDir: '.' }), (err) => {
      assert.equal(err.code, 'ADAPTER_UNSUPPORTED');
      assert.equal(err.status, 501);
      return true;
    });
    await assert.rejects(() => adapter.killTree(1), (err) => err.code === 'ADAPTER_UNSUPPORTED');
    assert.equal(adapter.isAlive(1), false);
  }
});

test('selectAdapter：显式配置 unsupported → 占位适配器且不再告警', () => {
  const logger = createSilentLogger();
  const warnings = [];
  logger.warn = (message) => warnings.push(message);
  const adapter = selectAdapter({ adapter: 'unsupported' }, logger);
  assert.equal(adapter.isSupported(), false);
  assert.deepEqual(warnings, []);
});

test('bootstrap：装配 store / procManager / app，数据目录自动建立，配置告警会打出日志', async () => {
  const dir = await makeTempDir();
  const logger = createSilentLogger();
  const logged = [];
  logger.warn = (message) => logged.push(message);

  const cfg = loadConfig({
    LSC_DATA_DIR: path.join(dir, 'data'),
    LSC_PORT: 'not-a-number',
    LSC_SERVE_CLIENT: '0',
  });
  const runtime = await bootstrap({ cfg, logger });

  assert.equal(runtime.store.isLoaded(), true);
  assert.equal(runtime.store.count(), 0);
  assert.equal(runtime.procManager.platform, process.platform);
  assert.equal(typeof runtime.app.listen, 'function', 'app 应是 express 实例');
  assert.ok(logged.some((line) => line.includes('已回退默认值')), '非法环境变量应产生告警日志');

  // 真起一次 HTTP，确认装配后可服务
  const server = runtime.app.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/health`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.status, 'ok');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('bootstrap：启停操作在非 Windows 上返回 501（不静默失败、不误报服务故障）', async () => {
  if (process.platform === 'win32') return;

  const dir = await makeTempDir();
  const cfg = loadConfig({ LSC_DATA_DIR: path.join(dir, 'data'), LSC_SERVE_CLIENT: '0' });
  const runtime = await bootstrap({ cfg, logger: createSilentLogger() });

  const server = runtime.app.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const created = await fetch(`${base}/api/services`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'svc', workDir: dir, startScript: 'run.bat', logFile: 'app.log' }),
    });
    const id = (await created.json()).data.id;

    for (const action of ['start', 'stop', 'restart']) {
      const response = await fetch(`${base}/api/services/${id}/${action}`, { method: 'POST' });
      assert.equal(response.status, 501, `${action} 应返回 501`);
      const body = await response.json();
      assert.equal(body.error.code, 'ADAPTER_UNSUPPORTED');
      assert.match(body.error.message, /仅在 Windows 上可用/);
    }

    // 配置管理不受平台限制：非 Windows 上依然能登记服务（逻辑层可 Mac 验）
    assert.equal((await fetch(`${base}/api/services`)).status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
