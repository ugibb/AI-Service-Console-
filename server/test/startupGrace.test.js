/**
 * 启动宽限期（startupGraceMs）行为测试。
 *
 * 背景：被纳管的服务基本都是 AI / LLM 服务，加载模型需要几十秒到几分钟。
 * 固定的启动窗口会带来两个真实问题：
 *   1. 宽限期一结束就显示「运行中」，用户以为能用了，实际模型还在加载；
 *   2. 反过来把窗口设长，真正的启动失败（显存不足 / 模型文件缺失）又要等很久才报出来。
 *
 * 因此宽限期做成**按服务可配**：宽限期内显示「启动中」（并带上已启动时长），
 * 宽限期结束才转「运行中」；宽限期内退出算启动失败，宽限期后退出才算异常退出。
 * 只靠进程状态 + 时间表达，不引入端口探测 / 健康检查（PRD §5.3 明确排除）。
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { FAILURE_REASONS, PROC_STATES } from '../src/services/procManager.js';
import { makeHarness } from '../testkit/harness.js';
import { cleanupTempDirs } from '../testkit/tmp.js';

after(cleanupTempDirs);

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const STATE = PROC_STATES;

test('宽限期内：进程存活 → starting（并给出 startedAt 供 UI 显示已启动时长）', async () => {
  const h = await makeHarness({ services: [{ name: 'svc', startupGraceMs: 300 }] });
  const id = h.services[0].id;

  const state = await h.procManager.start(id);
  assert.equal(state.status, STATE.STARTING, '宽限期内不能显示「运行中」');
  assert.equal(state.pid, 4000);
  assert.ok(Number.isFinite(state.startedAt), 'starting 阶段就要有 startedAt，否则 UI 无法显示已启动时长');
  assert.match(state.message, /启动中/);
});

test('宽限期结束后：进程仍存活 → running', async () => {
  const h = await makeHarness({ services: [{ name: 'svc', startupGraceMs: 120 }] });
  const id = h.services[0].id;

  await h.procManager.start(id);
  assert.equal(h.procManager.getState(id).status, STATE.STARTING);

  await sleep(200);
  assert.equal(h.procManager.getState(id).status, STATE.RUNNING);
});

test('宽限期内退出 → start_failed + 退出码 + 启动诊断输出', async () => {
  const h = await makeHarness({ services: [{ name: 'svc', startupGraceMs: 400 }] });
  const id = h.services[0].id;
  h.adapter.setBehavior({ exitAfterSpawn: { code: 2, delayMs: 20 } });

  await h.procManager.start(id);
  h.adapter.stdout(4000, 'CUDA out of memory: tried to allocate 4.00 GiB\n');
  await sleep(90);

  const state = h.procManager.getState(id);
  assert.equal(state.status, STATE.START_FAILED);
  assert.equal(state.reason, FAILURE_REASONS.EXITED_EARLY_NONZERO);
  assert.equal(state.exitCode, 2);
  assert.deepEqual(state.diag, ['CUDA out of memory: tried to allocate 4.00 GiB']);
});

test('宽限期后退出 → error（异常退出），不是 start_failed', async () => {
  const h = await makeHarness({ services: [{ name: 'svc', startupGraceMs: 100 }] });
  const id = h.services[0].id;

  await h.procManager.start(id);
  await sleep(160);
  assert.equal(h.procManager.getState(id).status, STATE.RUNNING);

  h.adapter.exit(4000, 3);
  const state = h.procManager.getState(id);
  assert.equal(state.status, STATE.ERROR);
  assert.equal(state.exitCode, 3);
});

test('服务未配置 startupGraceMs → 用全局默认（config.proc.startupGraceMs）', async () => {
  const h = await makeHarness({ services: [{ name: 'svc' }], procConfig: { startupGraceMs: 150 } });
  const id = h.services[0].id;

  const state = await h.procManager.start(id);
  assert.equal(state.status, STATE.STARTING);

  await sleep(220);
  assert.equal(h.procManager.getState(id).status, STATE.RUNNING);
});

test('startupGraceMs = 0：显式关闭宽限期，spawn 成功即 running（保留旧行为）', async () => {
  const h = await makeHarness({ services: [{ name: 'svc', startupGraceMs: 0 }] });
  const id = h.services[0].id;

  const state = await h.procManager.start(id);
  assert.equal(state.status, STATE.RUNNING);
});

test('宽限期内点停止：等 spawn 落地后正常停止（不停留在「启动中」）', async () => {
  const h = await makeHarness({ services: [{ name: 'svc', startupGraceMs: 5000 }] });
  const id = h.services[0].id;

  await h.procManager.start(id);
  assert.equal(h.procManager.getState(id).status, STATE.STARTING);

  const stopped = await h.procManager.stop(id);
  assert.equal(stopped.status, STATE.STOPPED);
  assert.deepEqual(h.adapter.calls.killTree, [{ pid: 4000, force: false }]);
});

test('宽限期内点启动：拒绝（SERVICE_BUSY），提示「正在启动中」', async () => {
  const h = await makeHarness({ services: [{ name: 'svc', startupGraceMs: 5000 }] });
  const id = h.services[0].id;
  await h.procManager.start(id);

  await assert.rejects(
    () => h.procManager.start(id),
    (err) => {
      assert.equal(err.code, 'SERVICE_BUSY');
      assert.equal(err.status, 409);
      assert.match(err.message, /正在启动中/);
      return true;
    },
  );
});

test('宽限期内 PID 静默消失（无 exit 事件）→ start_failed(pid_vanished)', async () => {
  const h = await makeHarness({ services: [{ name: 'svc', startupGraceMs: 5000 }], procConfig: { startVerifyDelayMs: 30 } });
  const id = h.services[0].id;
  await h.procManager.start(id);

  h.adapter.vanish(4000);
  await sleep(90);

  const state = h.procManager.getState(id);
  assert.equal(state.status, STATE.START_FAILED);
  assert.equal(state.reason, FAILURE_REASONS.PID_VANISHED);
});
