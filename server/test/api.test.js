/**
 * API 层测试：直接起真实 HTTP 服务（端口 0），用 fetch 打真实请求。
 * 进程操作使用 fake 适配器（Windows 层行为见 win32.test.js + README「Windows 验证清单」）。
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import iconv from 'iconv-lite';
import { loadConfig } from '../src/config.js';
import { createConfigStore } from '../src/db/configStore.js';
import { createProcManager } from '../src/services/procManager.js';
import { createApp } from '../src/app.js';
import { createFakeAdapter } from '../testkit/fakeAdapter.js';
import { createSilentLogger } from '../testkit/harness.js';
import { cleanupTempDirs, makeTempDir } from '../testkit/tmp.js';

after(cleanupTempDirs);

const TEST_PROC = {
  startVerifyDelayMs: 30,
  startFailureWindowMs: 100,
  stopGraceTimeoutMs: 150,
  exitPollIntervalMs: 20,
  diagBufferLines: 20,
};

async function makeApi({ serveClient = false, clientDistDir } = {}) {
  const dir = await makeTempDir();
  const workDir = path.join(dir, 'svc');
  await fs.mkdir(workDir, { recursive: true });
  const scriptPath = path.join(workDir, 'start.bat');
  await fs.writeFile(scriptPath, '@echo off\r\n');
  const logFile = path.join(workDir, 'app.log');

  const config = loadConfig({
    LSC_DATA_DIR: path.join(dir, 'data'),
    LSC_SERVE_CLIENT: serveClient ? '1' : '0',
    ...(clientDistDir ? { LSC_CLIENT_DIST: clientDistDir } : {}),
  });

  const logger = createSilentLogger();
  const store = createConfigStore({
    filePath: config.servicesFile,
    corruptBackupDir: config.corruptBackupDir,
    logger,
  });
  await store.init();

  const adapter = createFakeAdapter();
  const procManager = createProcManager({ adapter, store, config: { proc: TEST_PROC }, logger });
  const app = createApp({ store, procManager, config, logger });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    dir,
    workDir,
    scriptPath,
    logFile,
    base,
    config,
    store,
    adapter,
    procManager,
    app,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function call(base, url, { method = 'GET', body } = {}) {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, contentType: response.headers.get('content-type'), body: json, text };
}

const sampleService = (workDir, scriptPath, logFile, extra = {}) => ({
  name: '订单服务',
  workDir,
  startScript: scriptPath,
  logFile,
  port: 8081,
  ...extra,
});

test('GET /api/health：返回 ok、平台与轮询节奏（T0.4 联调探针）', async () => {
  const api = await makeApi();
  try {
    const { status, body } = await call(api.base, '/api/health');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.data.status, 'ok');
    assert.equal(body.data.platform, process.platform);
    assert.equal(body.data.poll.logsMs, 1000);
    assert.equal(body.data.poll.servicesMs, 1500);
    assert.equal(body.data.log.defaultTailLines, 500);
  } finally {
    await api.close();
  }
});

test('GET /api/services：空列表 + 无告警', async () => {
  const api = await makeApi();
  try {
    const { status, body } = await call(api.base, '/api/services');
    assert.equal(status, 200);
    assert.deepEqual(body.data.services, []);
    assert.deepEqual(body.data.warnings, []);
    assert.equal(body.data.poll.logsMs, 1000);
  } finally {
    await api.close();
  }
});

test('CRUD 全流程：新增 → 列表 → 详情 → 编辑 → 删除', async () => {
  const api = await makeApi();
  try {
    const created = await call(api.base, '/api/services', {
      method: 'POST',
      body: sampleService(api.workDir, api.scriptPath, api.logFile),
    });
    assert.equal(created.status, 201);
    const id = created.body.data.id;
    assert.ok(id);
    assert.equal(created.body.data.status, 'stopped');
    assert.equal(created.body.data.pid, null);
    assert.deepEqual(created.body.data.startupDiagnostics, []);

    const list = await call(api.base, '/api/services');
    assert.equal(list.body.data.services.length, 1);
    assert.equal(list.body.data.services[0].id, id);
    assert.equal(list.body.data.services[0].status, 'stopped');

    const detail = await call(api.base, `/api/services/${id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.data.name, '订单服务');

    const updated = await call(api.base, `/api/services/${id}`, {
      method: 'PUT',
      body: sampleService(api.workDir, api.scriptPath, api.logFile, { name: '订单服务 v2', port: null }),
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.data.name, '订单服务 v2');
    assert.equal(updated.body.data.port, null);

    const removed = await call(api.base, `/api/services/${id}`, { method: 'DELETE' });
    assert.equal(removed.status, 200);
    assert.equal(removed.body.data.removed, true);
    assert.equal((await call(api.base, `/api/services/${id}`)).status, 404);
    assert.deepEqual((await call(api.base, '/api/services')).body.data.services, []);
  } finally {
    await api.close();
  }
});

test('POST /api/services：校验失败 → 400 + 逐字段中文提示', async () => {
  const api = await makeApi();
  try {
    const { status, body } = await call(api.base, '/api/services', { method: 'POST', body: { name: '' } });
    assert.equal(status, 400);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'VALIDATION_FAILED');
    assert.ok(body.error.details.errors.length >= 4);
  } finally {
    await api.close();
  }
});

test('POST /api/services：请求体不是合法 JSON → 400 BAD_REQUEST', async () => {
  const api = await makeApi();
  try {
    const response = await fetch(`${api.base}/api/services`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ 这不是 JSON',
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error.code, 'BAD_REQUEST');
  } finally {
    await api.close();
  }
});

test('未知服务 id：GET / PUT / DELETE / start 全部 404 且错误码一致', async () => {
  const api = await makeApi();
  try {
    for (const [method, url] of [
      ['GET', '/api/services/nope'],
      ['PUT', '/api/services/nope'],
      ['DELETE', '/api/services/nope'],
      ['POST', '/api/services/nope/start'],
      ['GET', '/api/services/nope/logs'],
    ]) {
      const { status, body } = await call(api.base, url, { method, body: method === 'PUT' ? sampleService('a', 'b', 'c') : undefined });
      assert.equal(status, 404, `${method} ${url}`);
      assert.equal(body.error.code, 'SERVICE_NOT_FOUND');
    }
  } finally {
    await api.close();
  }
});

test('未知 API 路径 → 404 且保持统一信封', async () => {
  const api = await makeApi();
  try {
    const { status, body } = await call(api.base, '/api/nope');
    assert.equal(status, 404);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'NOT_FOUND');
    assert.match(body.error.message, /接口不存在/);
  } finally {
    await api.close();
  }
});

test('内部异常 → 500 且不泄漏堆栈', async () => {
  const api = await makeApi();
  try {
    // 用一个会抛异常的 store 触发错误中间件
    const brokenApp = createApp({
      store: {
        list: () => {
          throw new Error('数据库炸了：内部细节不应外泄');
        },
        warnings: () => [],
      },
      procManager: api.procManager,
      config: api.config,
      logger: createSilentLogger(),
    });
    const server = brokenApp.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const { status, body } = await call(base, '/api/services');
    assert.equal(status, 500);
    assert.equal(body.error.code, 'INTERNAL_ERROR');
    assert.equal(body.error.message, '服务器内部错误，请查看控制台日志');
    assert.ok(!JSON.stringify(body).includes('数据库炸了'));
    await new Promise((resolve) => server.close(resolve));
  } finally {
    await api.close();
  }
});

test('POST start / stop / restart：返回动作结果与最新服务状态', async () => {
  const api = await makeApi();
  try {
    const id = (await call(api.base, '/api/services', { method: 'POST', body: sampleService(api.workDir, api.scriptPath, api.logFile) }))
      .body.data.id;

    const started = await call(api.base, `/api/services/${id}/start`, { method: 'POST' });
    assert.equal(started.status, 200);
    assert.equal(started.body.data.action.name, 'start');
    assert.equal(started.body.data.service.status, 'running');
    assert.equal(started.body.data.service.pid, 4000);

    const conflict = await call(api.base, `/api/services/${id}/start`, { method: 'POST' });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, 'SERVICE_BUSY');

    const list = await call(api.base, '/api/services');
    assert.equal(list.body.data.services[0].status, 'running', '列表应反映运行时状态');

    const restarted = await call(api.base, `/api/services/${id}/restart`, { method: 'POST' });
    assert.equal(restarted.body.data.service.status, 'running');
    assert.equal(restarted.body.data.service.pid, 4001);

    const stopped = await call(api.base, `/api/services/${id}/stop`, { method: 'POST' });
    assert.equal(stopped.body.data.action.name, 'stop');
    assert.equal(stopped.body.data.action.forced, false);
    assert.equal(stopped.body.data.service.status, 'stopped');
    assert.equal(stopped.body.data.service.pid, null);
  } finally {
    await api.close();
  }
});

test('运行中的服务禁止编辑与删除（否则会丢 PID、留下无法管理的孤儿进程）', async () => {
  const api = await makeApi();
  try {
    const id = (await call(api.base, '/api/services', { method: 'POST', body: sampleService(api.workDir, api.scriptPath, api.logFile) }))
      .body.data.id;
    await call(api.base, `/api/services/${id}/start`, { method: 'POST' });

    const put = await call(api.base, `/api/services/${id}`, {
      method: 'PUT',
      body: sampleService(api.workDir, api.scriptPath, api.logFile, { name: '改名' }),
    });
    assert.equal(put.status, 409);
    assert.equal(put.body.error.code, 'CONFLICT');

    const del = await call(api.base, `/api/services/${id}`, { method: 'DELETE' });
    assert.equal(del.status, 409);

    await call(api.base, `/api/services/${id}/stop`, { method: 'POST' });
    const afterStop = await call(api.base, `/api/services/${id}`, {
      method: 'PUT',
      body: sampleService(api.workDir, api.scriptPath, api.logFile, { name: '改名成功' }),
    });
    assert.equal(afterStop.status, 200);
    assert.equal(afterStop.body.data.name, '改名成功');
  } finally {
    await api.close();
  }
});

test('GET logs：返回尾部 N 行 + 编码 + hasMore', async () => {
  const api = await makeApi();
  try {
    const id = (await call(api.base, '/api/services', { method: 'POST', body: sampleService(api.workDir, api.scriptPath, api.logFile) }))
      .body.data.id;
    await fs.writeFile(api.logFile, '第一行\n第二行\n第三行\n');

    const all = await call(api.base, `/api/services/${id}/logs`);
    assert.equal(all.status, 200);
    assert.equal(all.body.data.available, true);
    assert.equal(all.body.data.tail, 500, '默认 500 行（PRD §8.2）');
    assert.deepEqual(all.body.data.lines, ['第一行', '第二行', '第三行']);
    assert.equal(all.body.data.encoding, 'utf8');
    assert.equal(all.body.data.hasMore, false);
    assert.equal(all.body.data.path, api.logFile);

    const tailTwo = await call(api.base, `/api/services/${id}/logs?tail=2`);
    assert.deepEqual(tailTwo.body.data.lines, ['第二行', '第三行']);
    assert.equal(tailTwo.body.data.hasMore, true);

    await fs.writeFile(api.logFile, iconv.encode('服务启动失败\n', 'gbk'));
    const gbk = await call(api.base, `/api/services/${id}/logs`);
    assert.equal(gbk.body.data.encoding, 'gbk');
    assert.deepEqual(gbk.body.data.lines, ['服务启动失败']);
  } finally {
    await api.close();
  }
});

test('GET logs：非法 tail 参数回退默认值，超大 tail 被夹到上限', async () => {
  const api = await makeApi();
  try {
    const id = (await call(api.base, '/api/services', { method: 'POST', body: sampleService(api.workDir, api.scriptPath, api.logFile) }))
      .body.data.id;
    await fs.writeFile(api.logFile, 'only\n');

    assert.equal((await call(api.base, `/api/services/${id}/logs?tail=abc`)).body.data.tail, 500);
    assert.equal((await call(api.base, `/api/services/${id}/logs?tail=-5`)).body.data.tail, 500);
    assert.equal((await call(api.base, `/api/services/${id}/logs?tail=999999`)).body.data.tail, 20000);
  } finally {
    await api.close();
  }
});

test('GET logs：日志文件不存在 → 200 + available:false + 引导文案（不报错）', async () => {
  const api = await makeApi();
  try {
    const id = (await call(api.base, '/api/services', { method: 'POST', body: sampleService(api.workDir, api.scriptPath, api.logFile) }))
      .body.data.id;
    const { status, body } = await call(api.base, `/api/services/${id}/logs`);
    assert.equal(status, 200);
    assert.equal(body.data.available, false);
    assert.equal(body.data.kind, 'missing');
    assert.match(body.data.message, /尚未生成/);
    assert.deepEqual(body.data.lines, []);
  } finally {
    await api.close();
  }
});

test('GET logs：日志路径是目录 → 200 + kind:directory + 明确提示', async () => {
  const api = await makeApi();
  try {
    const asDir = path.join(api.workDir, 'logdir');
    await fs.mkdir(asDir, { recursive: true });
    const id = (await call(api.base, '/api/services', { method: 'POST', body: sampleService(api.workDir, api.scriptPath, asDir) })).body
      .data.id;

    const { status, body } = await call(api.base, `/api/services/${id}/logs`);
    assert.equal(status, 200);
    assert.equal(body.data.available, false);
    assert.equal(body.data.kind, 'directory');
    assert.match(body.data.message, /目录/);
  } finally {
    await api.close();
  }
});

test('启动失败原因通过详情/动作接口透出（含启动诊断输出）', async () => {
  const api = await makeApi();
  try {
    api.adapter.setBehavior({ exitAfterSpawn: { code: 1, delayMs: 10 } });
    const id = (await call(api.base, '/api/services', { method: 'POST', body: sampleService(api.workDir, api.scriptPath, api.logFile) }))
      .body.data.id;

    await call(api.base, `/api/services/${id}/start`, { method: 'POST' });
    await new Promise((resolve) => setTimeout(resolve, 60));

    const detail = await call(api.base, `/api/services/${id}`);
    assert.equal(detail.body.data.status, 'start_failed');
    assert.equal(detail.body.data.statusReason, 'exited_early_nonzero');
    assert.equal(detail.body.data.exitCode, 1);
    assert.match(detail.body.data.statusMessage, /退出码 1/);
    assert.ok(Array.isArray(detail.body.data.startupDiagnostics));
  } finally {
    await api.close();
  }
});

test('未构建前端时会话首页给出构建指引（不让用户看到空白 404）', async () => {
  const api = await makeApi({ serveClient: true, clientDistDir: '/tmp/lsc-does-not-exist-dist' });
  try {
    const { status, contentType, text } = await call(api.base, '/');
    assert.equal(status, 200);
    assert.match(contentType, /text\/html/);
    assert.match(text, /npm run build/);
  } finally {
    await api.close();
  }
});

test('生产模式：托管前端构建产物，且 /api 不被 SPA 兜底吞掉', async () => {
  const distDir = await makeTempDir();
  await fs.writeFile(path.join(distDir, 'index.html'), '<!doctype html><title>console</title><div id="root">SPA</div>');
  await fs.mkdir(path.join(distDir, 'assets'), { recursive: true });
  await fs.writeFile(path.join(distDir, 'assets', 'app.js'), 'console.log("bundle")');

  const api = await makeApi({ serveClient: true, clientDistDir: distDir });
  try {
    const home = await call(api.base, '/');
    assert.equal(home.status, 200);
    assert.match(home.text, /SPA/);

    const asset = await fetch(`${api.base}/assets/app.js`);
    assert.equal(asset.status, 200);
    assert.match(await asset.text(), /bundle/);

    const spaRoute = await fetch(`${api.base}/services/whatever`, { headers: { accept: 'text/html' } });
    assert.equal(spaRoute.status, 200);
    assert.match(await spaRoute.text(), /SPA/);

    const apiRoute = await call(api.base, '/api/services');
    assert.equal(apiRoute.status, 200);
    assert.equal(apiRoute.body.ok, true);

    const apiMissing = await call(api.base, '/api/nope');
    assert.equal(apiMissing.status, 404);
    assert.equal(apiMissing.body.error.code, 'NOT_FOUND');
  } finally {
    await api.close();
  }
});
