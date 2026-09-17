import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { FAILURE_REASONS, PROC_STATES } from '../src/services/procManager.js';
import { makeHarness, makeTempDir } from '../testkit/harness.js';
import { cleanupTempDirs } from '../testkit/tmp.js';

after(cleanupTempDirs);

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const STATE = PROC_STATES;

test('start：stopped → starting → running，记录 pid 并携带解析后的路径', async () => {
  const h = await makeHarness({ services: [{ name: 'svc' }] });
  const id = h.services[0].id;

  const state = await h.procManager.start(id);
  assert.equal(state.status, STATE.RUNNING);
  assert.equal(state.pid, 4000);
  assert.equal(state.reason, null);
  assert.equal(h.adapter.isAlive(4000), true);
  assert.equal(h.adapter.calls.spawn[0].workDir, path.resolve(h.workDir));
  assert.equal(h.adapter.calls.spawn[0].scriptPath, h.scriptPath);
});

test('start：未知服务 id 抛 SERVICE_NOT_FOUND', async () => {
  const h = await makeHarness();
  await assert.rejects(() => h.procManager.start('nope'), (err) => err.code === 'SERVICE_NOT_FOUND');
});

test('start：已在运行/启动中/停止中 → 拒绝并提示（PRD §12「对启动中服务再次点启动」）', async () => {
  const h = await makeHarness({ services: [{ name: 'svc' }] });
  const id = h.services[0].id;
  await h.procManager.start(id);

  await assert.rejects(
    () => h.procManager.start(id),
    (err) => {
      assert.equal(err.code, 'SERVICE_BUSY');
      assert.equal(err.status, 409);
      assert.match(err.message, /正在运行中/);
      return true;
    },
  );
});

test('start：start 进行中（starting）时再次 start 也被拒绝', async () => {
  const h = await makeHarness({ services: [{ name: 'svc' }] });
  const id = h.services[0].id;
  h.adapter.setBehavior({ spawnDelayMs: 60 });

  const pending = h.procManager.start(id);
  assert.equal(h.procManager.getState(id).status, STATE.STARTING);
  await assert.rejects(() => h.procManager.start(id), (err) => err.code === 'SERVICE_BUSY');

  const state = await pending;
  assert.equal(state.status, STATE.RUNNING);
});

test('start：spawn 抛错 → start_failed(spawn_error)，带可读原因', async () => {
  const h = await makeHarness({ services: [{ name: 'svc' }] });
  h.adapter.setBehavior({ spawnError: new Error('ENOENT: cmd.exe not found') });

  const state = await h.procManager.start(h.services[0].id);
  assert.equal(state.status, STATE.START_FAILED);
  assert.equal(state.reason, FAILURE_REASONS.SPAWN_ERROR);
  assert.match(state.message, /启动失败：ENOENT/);
});

test('start：启动脚本不存在 → start_failed(preflight_script_missing)，不进 spawn', async () => {
  const dir = await makeTempDir();
  const h = await makeHarness({ services: [{ name: 'svc' }] });
  const svc = await h.store.create({
    name: 'missing-script',
    workDir: h.workDir,
    startScript: path.join(dir, 'not-here.bat'),
    logFile: h.logFile,
  });

  const state = await h.procManager.start(svc.id);
  assert.equal(state.status, STATE.START_FAILED);
  assert.equal(state.reason, FAILURE_REASONS.PREFLIGHT_SCRIPT_MISSING);
  assert.match(state.message, /启动脚本不可用/);
  assert.equal(h.adapter.calls.spawn.length, 0, '预检失败不应真的 spawn');
});

test('start：工作目录不存在 → start_failed(preflight_workdir_missing)', async () => {
  const dir = await makeTempDir();
  const h = await makeHarness({ services: [{ name: 'svc' }] });
  const svc = await h.store.create({
    name: 'missing-workdir',
    workDir: path.join(dir, 'nope'),
    startScript: h.scriptPath,
    logFile: h.logFile,
  });

  const state = await h.procManager.start(svc.id);
  assert.equal(state.reason, FAILURE_REASONS.PREFLIGHT_WORKDIR_MISSING);
  assert.match(state.message, /工作目录不可用/);
});

test('防御「启动即退出」型 .bat：窗口内退出码 0 → start_failed 并给出改造建议', async () => {
  const h = await makeHarness({ services: [{ name: 'svc' }] });
  h.adapter.setBehavior({ exitAfterSpawn: { code: 0, delayMs: 10 } });
  await h.procManager.start(h.services[0].id);
  await sleep(60);

  const state = h.procManager.getState(h.services[0].id);
  assert.equal(state.status, STATE.START_FAILED);
  assert.equal(state.reason, FAILURE_REASONS.EXITED_EARLY_ZERO);
  assert.match(state.message, /退出码 0/);
  assert.match(state.message, /start \/wait/, '必须给出可照做的改造建议');
});

test('防御「启动即退出」型 .bat：窗口内退出码非 0 → start_failed 并保留退出码', async () => {
  const h = await makeHarness({ services: [{ name: 'svc' }] });
  h.adapter.setBehavior({ exitAfterSpawn: { code: 7, delayMs: 10 } });
  await h.procManager.start(h.services[0].id);
  await sleep(60);

  const state = h.procManager.getState(h.services[0].id);
  assert.equal(state.status, STATE.START_FAILED);
  assert.equal(state.reason, FAILURE_REASONS.EXITED_EARLY_NONZERO);
  assert.equal(state.exitCode, 7);
  assert.match(state.message, /退出码 7/);
});

test('防御：spawn 成功但 PID 立刻消失（无 exit 事件）→ start_failed(pid_vanished)', async () => {
  const h = await makeHarness({ services: [{ name: 'svc' }] });
  const id = h.services[0].id;
  const started = await h.procManager.start(id);
  assert.equal(started.status, STATE.RUNNING);

  h.adapter.vanish(4000); // 进程静默消失，没有任何 exit 通知
  await sleep(120);

  const state = h.procManager.getState(id);
  assert.equal(state.status, STATE.START_FAILED);
  assert.equal(state.reason, FAILURE_REASONS.PID_VANISHED);
  assert.match(state.message, /PID 4000 已不存在/);
  assert.match(state.message, /start \/wait/);
});

test('启动窗口过后自行退出：退出码 0 → stopped', async () => {
  const h = await makeHarness({ services: [{ name: 'svc' }] });
  const id = h.services[0].id;
  await h.procManager.start(id);
  await sleep(200); // 超过 startFailureWindowMs(150)
  h.adapter.exit(4000, 0);

  const state = h.procManager.getState(id);
  assert.equal(state.status, STATE.STOPPED);
  assert.equal(state.exitCode, 0);
  assert.match(state.message, /自行退出/);
});

test('启动窗口过后异常退出：退出码非 0 → error 且记录 exitCode', async () => {
  const h = await makeHarness({ services: [{ name: 'svc' }] });
  const id = h.services[0].id;
  await h.procManager.start(id);
  await sleep(200);
  h.adapter.exit(4000, 3);

  const state = h.procManager.getState(id);
  assert.equal(state.status, STATE.ERROR);
  assert.equal(state.exitCode, 3);
  assert.match(state.message, /异常退出（退出码 3）/);
});

test('启动诊断：窗口内收集 stdout/stderr（跨块拼接），窗口后固化', async () => {
  const h = await makeHarness({ services: [{ name: 'svc' }] });
  const id = h.services[0].id;
  await h.procManager.start(id);

  h.adapter.stdout(4000, 'Java HotSpot 17\n');
  h.adapter.stdout(4000, '正在连接数据');
  h.adapter.stdout(4000, '库...\n');
  h.adapter.stderr(4000, 'ERROR: 端口被占用\n');

  await sleep(200); // 让启动窗口结束、诊断固化
  assert.deepEqual(h.procManager.getState(id).diag, [
    'Java HotSpot 17',
    '正在连接数据库...',
    'ERROR: 端口被占用',
  ]);

  // 窗口结束后不再收集
  h.adapter.stdout(4000, '后续输出不应进入诊断缓冲\n');
  assert.equal(h.procManager.getState(id).diag.length, 3);
});

test('启动失败的诊断输出会随状态一起返回（起不来时能看到原因）', async () => {
  const h = await makeHarness({ services: [{ name: 'svc' }] });
  h.adapter.setBehavior({ exitAfterSpawn: { code: 1, delayMs: 30 } });

  await h.procManager.start(h.services[0].id);
  await sleep(10);
  h.adapter.stdout(4000, 'Error: cannot find module server.js\n');
  await sleep(60);

  const final = h.procManager.getState(h.services[0].id);
  assert.equal(final.status, STATE.START_FAILED);
  assert.deepEqual(final.diag, ['Error: cannot find module server.js']);
});

test('stop：优雅终止成功 → stopped，且只调用一次 taskkill（不带 /F）', async () => {
  const h = await makeHarness({ services: [{ name: 'svc' }] });
  const id = h.services[0].id;
  await h.procManager.start(id);

  const result = await h.procManager.stop(id);
  assert.equal(result.status, STATE.STOPPED);
  assert.equal(result.forced, false);
  assert.equal(result.killFailed, undefined);
  assert.deepEqual(h.adapter.calls.killTree, [{ pid: 4000, force: false }]);
});

test('stop：超时未退出 → 自动强杀（/T /F），记录「已强制终止」', async () => {
  const h = await makeHarness({ services: [{ name: 'svc' }] });
  const id = h.services[0].id;
  h.adapter.setBehavior({ ignoreGracefulKill: true });
  await h.procManager.start(id);

  const result = await h.procManager.stop(id);
  assert.equal(result.forced, true);
  assert.equal(result.status, STATE.STOPPED);
  assert.equal(result.forcedKill, true);
  assert.match(result.message, /已强制终止/);
  assert.deepEqual(h.adapter.calls.killTree, [
    { pid: 4000, force: false },
    { pid: 4000, force: true },
  ]);
});

test('stop：连强杀都杀不掉 → error(kill_failed)，提示去任务管理器处理', async () => {
  const h = await makeHarness({ services: [{ name: 'svc' }] });
  const id = h.services[0].id;
  h.adapter.setBehavior({ ignoreGracefulKill: true, ignoreForceKill: true });
  await h.procManager.start(id);

  const result = await h.procManager.stop(id);
  assert.equal(result.killFailed, true);
  assert.equal(result.status, STATE.ERROR);
  assert.equal(result.reason, FAILURE_REASONS.KILL_FAILED);
  assert.match(result.message, /任务管理器/);
});

test('stop：taskkill 自身执行失败 → error(kill_failed)，带 taskkill 原始信息', async () => {
  const h = await makeHarness({ services: [{ name: 'svc' }] });
  const id = h.services[0].id;
  h.adapter.setBehavior({ killFailure: { appliesTo: 'graceful', message: 'Access is denied.' } });
  await h.procManager.start(id);

  const result = await h.procManager.stop(id);
  assert.equal(result.killFailed, true);
  assert.equal(result.status, STATE.ERROR);
  assert.match(result.message, /停止失败：Access is denied\./);
});

test('stop：进程已自行退出时是幂等的（不报错、不调用 taskkill）', async () => {
  const h = await makeHarness({ services: [{ name: 'svc' }] });
  const id = h.services[0].id;

  const result = await h.procManager.stop(id);
  assert.equal(result.alreadyStopped, true);
  assert.equal(result.status, STATE.STOPPED);
  assert.equal(h.adapter.calls.killTree.length, 0);
});

test('stop：start_failed / error 状态下点击停止 → 直接对齐为 stopped', async () => {
  const h = await makeHarness({ services: [{ name: 'svc' }] });
  const id = h.services[0].id;
  h.adapter.setBehavior({ spawnError: new Error('boom') });
  await h.procManager.start(id);
  assert.equal(h.procManager.getState(id).status, STATE.START_FAILED);

  const result = await h.procManager.stop(id);
  assert.equal(result.alreadyStopped, true);
  assert.equal(result.status, STATE.STOPPED);
  assert.equal(result.reason, null);
});

test('stop：并发点击只杀一次（进行中的停止被复用）', async () => {
  const h = await makeHarness({ services: [{ name: 'svc' }] });
  const id = h.services[0].id;
  h.adapter.setBehavior({ ignoreGracefulKill: true });
  await h.procManager.start(id);

  const [a, b] = await Promise.all([h.procManager.stop(id), h.procManager.stop(id)]);
  assert.equal(a.status, STATE.STOPPED);
  assert.equal(b.status, STATE.STOPPED);
  assert.deepEqual(h.adapter.calls.killTree, [
    { pid: 4000, force: false },
    { pid: 4000, force: true },
  ]);
});

test('stop：start 尚未完成时点停止 → 等 spawn 落地后再停止', async () => {
  const h = await makeHarness({ services: [{ name: 'svc' }] });
  const id = h.services[0].id;
  h.adapter.setBehavior({ spawnDelayMs: 60 });

  const starting = h.procManager.start(id);
  await sleep(10);
  const stopped = await h.procManager.stop(id);
  await starting;

  assert.equal(stopped.status, STATE.STOPPED);
  assert.deepEqual(h.adapter.calls.killTree, [{ pid: 4000, force: false }]);
});

test('restart：运行中 → 先停后起，得到新的 pid', async () => {
  const h = await makeHarness({ services: [{ name: 'svc' }] });
  const id = h.services[0].id;
  await h.procManager.start(id);

  const state = await h.procManager.restart(id);
  assert.equal(state.status, STATE.RUNNING);
  assert.equal(state.pid, 4001);
  assert.equal(h.adapter.calls.killTree.length, 1);
  assert.equal(h.adapter.calls.spawn.length, 2);
});

test('restart：已停止状态下直接启动', async () => {
  const h = await makeHarness({ services: [{ name: 'svc' }] });
  const state = await h.procManager.restart(h.services[0].id);
  assert.equal(state.status, STATE.RUNNING);
  assert.equal(h.adapter.calls.killTree.length, 0);
});

test('restart：未知服务抛 SERVICE_NOT_FOUND', async () => {
  const h = await makeHarness();
  await assert.rejects(() => h.procManager.restart('nope'), (err) => err.code === 'SERVICE_NOT_FOUND');
});

test('过期回调不会污染新一代状态（上一代进程的 exit 事件）', async () => {
  const h = await makeHarness({ services: [{ name: 'svc' }] });
  const id = h.services[0].id;
  await h.procManager.start(id);
  await h.procManager.stop(id);

  const firstSpawn = h.adapter.calls.spawn[0];
  await h.procManager.start(id); // 第二次启动，pid=4001
  assert.equal(h.procManager.getState(id).status, STATE.RUNNING);

  firstSpawn.onExit({ code: 1, signal: null }); // 上一代的迟到事件
  const state = h.procManager.getState(id);
  assert.equal(state.status, STATE.RUNNING, '状态不应被过期回调改成 start_failed');
  assert.equal(state.pid, 4001);
});

test('getState / snapshot / isBusy：默认 stopped，便于列表合并', async () => {
  const h = await makeHarness({ services: [{ name: 'a' }, { name: 'b' }] });
  const [a, b] = h.services.map((s) => s.id);
  await h.procManager.start(a);

  assert.equal(h.procManager.getState('unknown').status, STATE.STOPPED);
  assert.equal(h.procManager.isBusy(a), true);
  assert.equal(h.procManager.isBusy(b), false);

  const snapshot = h.procManager.snapshot();
  assert.equal(snapshot[a].status, STATE.RUNNING);
  assert.equal(snapshot[b].status, STATE.STOPPED);
  assert.equal(h.procManager.platform, 'fake');
});

test('onStateChange：收到状态流转；监听器抛错不影响主流程', async () => {
  const h = await makeHarness({ services: [{ name: 'svc' }] });
  const id = h.services[0].id;
  const transitions = [];

  const unsubscribe = h.procManager.onStateChange((changedId, state) => {
    transitions.push(`${changedId}:${state.status}`);
    if (state.status === STATE.RUNNING) throw new Error('监听器故意抛错');
  });

  await h.procManager.start(id);
  await h.procManager.stop(id);

  assert.deepEqual(transitions, [`${id}:starting`, `${id}:running`, `${id}:stopping`, `${id}:stopped`]);
  unsubscribe();
});

test('dispose：清理定时器与运行时状态，不残留 tick', async () => {
  const h = await makeHarness({ services: [{ name: 'svc' }] });
  const id = h.services[0].id;
  await h.procManager.start(id);
  h.procManager.dispose();

  await sleep(120);
  assert.equal(h.procManager.getState(id).status, STATE.STOPPED, 'dispose 后运行时状态清零');
});
