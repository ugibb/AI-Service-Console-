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
import { createRuntimeStore } from '../src/db/runtimeStore.js';
import { createProcManager } from '../src/services/procManager.js';
import { createApp } from '../src/app.js';
import { createFakeAdapter } from '../testkit/fakeAdapter.js';
import { waitForArchive } from '../testkit/harness.js';
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

async function makeApi({ serveClient = false, clientDistDir, adopt = false } = {}) {
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
  // adopt=true 时接上接管档案（与 index.js 的装配一致），让「已接管」能经由 HTTP 序列化出去
  let runtimeStore = null;
  if (adopt) {
    runtimeStore = createRuntimeStore({ filePath: config.runtimeFile, corruptBackupDir: config.corruptBackupDir, logger });
    await runtimeStore.init();
  }
  const procManager = createProcManager({ adapter, store, config: { proc: TEST_PROC }, runtimeStore, logger });
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
    runtimeStore,
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

test('GET /api/health：adapter 报告的是「实际生效的适配器」，不是配置值（QA 6.2）', async () => {
  const api = await makeApi();
  try {
    const { body } = await call(api.base, '/api/health');
    // 配置里写的是 win32，但本机不是 Windows → 真正在用的是 fake/unsupported
    assert.equal(body.data.adapter, api.adapter.platform, 'adapter 必须等于 procManager 实际持有的适配器');
    assert.equal(body.data.adapterSupported, true);
    assert.equal(body.data.adapterConfigured, api.config.adapter, '配置值另开字段，不再冒充实际值');
  } finally {
    await api.close();
  }
});

test('POST 超过 body 上限：413 + 中文提示 + 专用错误码（QA 6.3）', async () => {
  const api = await makeApi();
  try {
    const huge = 'x'.repeat(300 * 1024); // 默认 jsonBodyLimit 为 256kb
    const { status, body } = await call(api.base, '/api/services', {
      method: 'POST',
      body: { name: huge, workDir: 'C:\\x', startScript: 'C:\\x\\a.bat', logFile: 'C:\\x\\a.log' },
    });
    assert.equal(status, 413);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'PAYLOAD_TOO_LARGE');
    assert.match(body.error.message, /请求体过大/);
    assert.doesNotMatch(body.error.message, /request entity too large/, '不能把 body-parser 的英文原文透给用户');
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

    // running 下再点「启动」不再是 409：语义是「确保只有一个实例」= 先停旧再起新
    const restartedByStart = await call(api.base, `/api/services/${id}/start`, { method: 'POST' });
    assert.equal(restartedByStart.status, 200);
    assert.equal(restartedByStart.body.data.service.status, 'running');
    assert.equal(restartedByStart.body.data.service.pid, 4001, '杀旧起新');
    assert.equal(api.adapter.isLive(4000), false, '旧进程已被杀掉');

    const list = await call(api.base, '/api/services');
    assert.equal(list.body.data.services[0].status, 'running', '列表应反映运行时状态');

    const restarted = await call(api.base, `/api/services/${id}/restart`, { method: 'POST' });
    assert.equal(restarted.body.data.service.status, 'running');
    assert.equal(restarted.body.data.service.pid, 4002);

    const stopped = await call(api.base, `/api/services/${id}/stop`, { method: 'POST' });
    assert.equal(stopped.body.data.action.name, 'stop');
    assert.equal(stopped.body.data.action.forced, false);
    assert.equal(stopped.body.data.service.status, 'stopped');
    assert.equal(stopped.body.data.service.pid, null);
  } finally {
    await api.close();
  }
});

test('startupGraceMs：新增写入、列表/详情回读一致，非法值 400（AI 服务的启动宽限期）', async () => {
  const api = await makeApi();
  try {
    const created = await call(api.base, '/api/services', {
      method: 'POST',
      body: sampleService(api.workDir, api.scriptPath, api.logFile, { startupGraceMs: 60000 }),
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.data.startupGraceMs, 60000);

    const list = await call(api.base, '/api/services');
    assert.equal(list.body.data.services[0].startupGraceMs, 60000);

    const noGrace = await call(api.base, '/api/services', {
      method: 'POST',
      body: sampleService(api.workDir, api.scriptPath, api.logFile, { name: '默认宽限期', startupGraceMs: null }),
    });
    assert.equal(noGrace.body.data.startupGraceMs, null, '未配置 → null（沿用全局默认）');

    const bad = await call(api.base, '/api/services', {
      method: 'POST',
      body: sampleService(api.workDir, api.scriptPath, api.logFile, { name: '非法宽限期', startupGraceMs: -5 }),
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'VALIDATION_FAILED');
  } finally {
    await api.close();
  }
});

test('AI 服务宽限期：start 先返回 starting，宽限期结束后才 running（API 层可见）', async () => {
  const api = await makeApi();
  try {
    const created = await call(api.base, '/api/services', {
      method: 'POST',
      body: sampleService(api.workDir, api.scriptPath, api.logFile, { startupGraceMs: 250 }),
    });
    const id = created.body.data.id;

    const started = await call(api.base, `/api/services/${id}/start`, { method: 'POST' });
    assert.equal(started.body.data.service.status, 'starting', '宽限期内不能让用户以为服务已经能用');
    assert.equal(started.body.data.service.pid, 4000);
    assert.ok(started.body.data.service.startedAt, 'starting 阶段要带 startedAt，前端据此显示已启动时长');

    await new Promise((resolve) => setTimeout(resolve, 340));
    const list = await call(api.base, '/api/services');
    assert.equal(list.body.data.services[0].status, 'running');
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

test('控制台重启后「已接管」经 HTTP 透出：状态、PID 与说明都在列表里（真接管取代旧的免责声明）', async () => {
  const api = await makeApi({ adopt: true });
  try {
    const id = (await call(api.base, '/api/services', { method: 'POST', body: sampleService(api.workDir, api.scriptPath, api.logFile) }))
      .body.data.id;
    const started = (await call(api.base, `/api/services/${id}/start`, { method: 'POST' })).body.data.service;
    assert.equal(started.status, 'running');
    assert.ok(started.pid, '启动后 pid 可见');

    // 模拟控制台被杀（状态清零、进程还活着、档案已落盘），再对账——即控制台重启那一步
    await waitForArchive(api.runtimeStore, id); // persistPid 是 fire-and-forget，固定 sleep 会抢跑
    api.procManager.dispose();
    await api.procManager.reconcileAdopted();

    const list = (await call(api.base, '/api/services')).body.data.services;
    const item = list.find((service) => service.id === id);
    assert.equal(item.status, 'adopted');
    assert.equal(item.pid, started.pid, '接管后 PID 必须可见——否则用户没法核对，又回到「去任务管理器对」那条断头路');
    assert.match(item.statusMessage, /已接管/);

    // 接管态与 running 同权：编辑/删除被拒（否则会丢 PID、留下无法管理的孤儿进程）
    const del = await call(api.base, `/api/services/${id}`, { method: 'DELETE' });
    assert.equal(del.status, 409);

    // 且「停止」真的能停掉接管的进程（两段式树杀对非子进程同样成立）
    const stopped = (await call(api.base, `/api/services/${id}/stop`, { method: 'POST' })).body.data.service;
    assert.equal(stopped.status, 'stopped');
    assert.equal(api.adapter.isLive(started.pid), false);
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

test('GET logs：logFile 里的 {date} 按当天展开，读到的是当天那个文件', async () => {
  const api = await makeApi();
  try {
    // 期望值在测试里独立算一遍（不用被测的 formatDateToken），否则函数算错也照样通过
    const now = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

    const template = path.join(api.workDir, '{date}.log');
    const id = (await call(api.base, '/api/services', { method: 'POST', body: sampleService(api.workDir, api.scriptPath, template) })).body
      .data.id;

    // 昨天那份必须读不到：只存在今天这个文件时，能读到就说明确实展开成了今天
    await fs.writeFile(path.join(api.workDir, `${today}.log`), '今天的日志\n');

    const { status, body } = await call(api.base, `/api/services/${id}/logs`);
    assert.equal(status, 200);
    assert.equal(body.data.available, true);
    assert.deepEqual(body.data.lines, ['今天的日志']);
    assert.equal(body.data.path, path.join(api.workDir, `${today}.log`), '响应里的 path 是展开后的具体文件');
  } finally {
    await api.close();
  }
});

test('GET logs：当天文件没生成 → 回退到最近一天（跨夜常驻的进程不必等重启）', async () => {
  const api = await makeApi();
  try {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12, 0, 0);

    const template = path.join(api.workDir, '{date}.log');
    const id = (await call(api.base, '/api/services', { method: 'POST', body: sampleService(api.workDir, api.scriptPath, template) })).body
      .data.id;

    // 只写昨天那份：worker 昨天启动、今天还在写它 —— 2026-09-18 的 inFlow 就是这个状态
    const yesterdayPath = path.join(api.workDir, `${stamp(yesterday)}.log`);
    await fs.writeFile(yesterdayPath, '昨晚启动，今天还在写\n');

    const { status, body } = await call(api.base, `/api/services/${id}/logs`);
    assert.equal(status, 200);
    assert.equal(body.data.available, true, '当天文件不存在也要能读到日志，而不是「尚未生成」');
    assert.deepEqual(body.data.lines, ['昨晚启动，今天还在写']);
    assert.equal(body.data.path, yesterdayPath, '响应里的 path 是真正读到的那个文件');
  } finally {
    await api.close();
  }
});

test('GET logs：整个回退窗口内都没有文件 → 200 + available:false（不报错）', async () => {
  const api = await makeApi();
  try {
    const template = path.join(api.workDir, 'logs', '{date}.log');
    const id = (await call(api.base, '/api/services', { method: 'POST', body: sampleService(api.workDir, api.scriptPath, template) })).body
      .data.id;

    const { status, body } = await call(api.base, `/api/services/${id}/logs`);
    assert.equal(status, 200);
    assert.equal(body.data.available, false);
    assert.equal(body.data.kind, 'missing');
    assert.match(body.data.path, /logs[\\/]\d{4}-\d{2}-\d{2}\.log$/, '降级信息里带的是当天该有的那个路径，便于排查');
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
