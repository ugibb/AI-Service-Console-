/**
 * 启动前清理（cleanup）测试：「确保系统里只有一个实例在跑」的那半边。
 *
 * 覆盖两类占用者与两条红线：
 * - 档案残留的旧 pid（上个会话异常退出没走终态清理）；
 * - 占用服务声明端口的进程（用户的明确选择：占用者一律清掉）；
 * - 红线一：占用者是控制台自己/其祖先 → 拒绝启动，绝不能自杀；
 * - 红线二：进程杀不掉 → 中止启动（宁可不起，不能起出第二个实例）。
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { PROC_STATES, FAILURE_REASONS } from '../src/services/procManager.js';
import { makeHarness, waitForArchive, waitForTreeSize } from '../testkit/harness.js';
import { cleanupTempDirs } from '../testkit/tmp.js';

after(cleanupTempDirs);

test('档案残留：上个会话的 pid 还活着 → 启动前杀掉，且只起新的一个', async () => {
  const h = await makeHarness({ services: [{ name: 'svc' }] });
  const id = h.services[0].id;
  const started = await h.procManager.start(id);
  await waitForArchive(h.runtimeStore, id); // persistPid 是 fire-and-forget，不能拿固定 sleep 赌
  h.procManager.dispose(); // 模拟控制台被杀：状态没了，档案还在，进程也还在

  const rebornState = await h.procManager.start(id); // 同一 manager 复用（对账没跑，状态 stopped 但档案有货）
  assert.equal(rebornState.status, PROC_STATES.RUNNING);
  assert.notEqual(rebornState.pid, started.pid);
  assert.equal(h.adapter.isLive(started.pid), false, '档案里的旧实例必须被清理');
  assert.equal(h.adapter.isLive(rebornState.pid), true);
  assert.match(rebornState.message ?? '', /已清理 1 个旧进程/, '启动消息里交代清理了谁');
  assert.ok(h.adapter.calls.killTree.some((call) => call.pid === started.pid));
});

test('端口占用：占用者是无关进程 → 照样清掉（端口是服务声明的归属）', async () => {
  const h = await makeHarness({ services: [{ name: 'svc', port: 8083 }] });
  const id = h.services[0].id;
  h.adapter.seedProcess(9001, { name: 'python.exe' });
  h.adapter.seedPortOwner(8083, 9001);

  const state = await h.procManager.start(id);
  assert.equal(state.status, PROC_STATES.RUNNING);
  assert.equal(h.adapter.isLive(9001), false, '占用者被杀');
  assert.match(state.message ?? '', /python\.exe\(9001\)/, '消息里点名占用者');
  assert.equal((await waitForArchive(h.runtimeStore, id))?.pid, state.pid, '档案指向新实例');
});

test('端口占用：占用者只吃强杀（真机实测的退出码 255）→ 降级 /F 清掉，启动照常', async () => {
  // 真机现场：`taskkill /PID 10824 /T` → code=255
  // 「原因: 只能强制终止此进程(带 /F 选项)。」——python 这类没有窗口消息循环的进程就是这样。
  // 旧实现在这里 return false，于是「占用就杀」落空：启动被否，占用者原样活着还在占端口。
  const h = await makeHarness({ services: [{ name: 'svc', port: 8083 }] });
  h.adapter.setBehavior({ killFailure: { appliesTo: 'graceful', message: '只能强制终止此进程(带 /F 选项)。' } });
  h.adapter.seedProcess(9003, { name: 'python.exe' });
  h.adapter.seedPortOwner(8083, 9003);

  const state = await h.procManager.start(h.services[0].id);
  assert.equal(state.status, PROC_STATES.RUNNING, '优雅杀不掉不等于清不掉');
  assert.equal(h.adapter.isLive(9003), false, '强杀把占用者清掉了');
  assert.deepEqual(h.adapter.calls.killTree, [
    { pid: 9003, force: false },
    { pid: 9003, force: true },
  ]);
});

test('红线一：端口被控制台自身占用 → 拒绝启动，给出可读原因，不杀任何进程', async () => {
  const h = await makeHarness({ services: [{ name: 'svc', port: 3010 }] });
  const id = h.services[0].id;
  // 控制台自己既是快照里的进程、也是监听者（真实世界里 netstat/wmic 都看得到它）
  h.adapter.seedProcess(process.pid, { name: 'node.exe' });
  h.adapter.seedPortOwner(3010, process.pid);

  const state = await h.procManager.start(id);
  assert.equal(state.status, PROC_STATES.START_FAILED);
  assert.equal(state.reason, FAILURE_REASONS.PRESTART_CLEANUP_FAILED);
  assert.match(state.message, /控制台自身/);
  assert.equal(h.adapter.calls.spawn.length, 0, '绝不能在这种情况下起服务');
  assert.equal(h.adapter.calls.killTree.length, 0, '更不能杀自己');
});

test('红线二：占用进程杀不掉 → 中止启动（不能起出第二个实例去抢端口）', async () => {
  const h = await makeHarness({ services: [{ name: 'svc', port: 8083 }], procConfig: { stopGraceTimeoutMs: 80, exitPollIntervalMs: 10 } });
  h.adapter.setBehavior({ ignoreGracefulKill: true, ignoreForceKill: true });
  h.adapter.seedProcess(9002, { name: 'stubborn.exe' });
  h.adapter.seedPortOwner(8083, 9002);

  const state = await h.procManager.start(h.services[0].id);
  assert.equal(state.status, PROC_STATES.START_FAILED);
  assert.equal(state.reason, FAILURE_REASONS.PRESTART_CLEANUP_FAILED);
  assert.match(state.message, /无法结束/);
  assert.equal(h.adapter.calls.spawn.length, 0, '杀不掉就不起');
  assert.equal(h.adapter.isLive(9002), true);
});

test('档案 pid 已被复用：不杀无关进程，但启动照常进行', async () => {
  const h = await makeHarness({ services: [{ name: 'svc' }] });
  const id = h.services[0].id;
  const started = await h.procManager.start(id);
  h.procManager.dispose();
  h.adapter.vanish(started.pid);
  // 同一个 pid 被复用成了别的进程，档案里还留着旧的创建时间
  h.adapter.seedProcess(started.pid, { name: 'unrelated.exe', creationDate: '20300101000000.000000+480' });

  const state = await h.procManager.start(id);
  assert.equal(state.status, PROC_STATES.RUNNING, '复用的 pid 不杀，启动继续');
  assert.equal(h.adapter.isLive(started.pid), true, '无关进程毫发无损');
  assert.equal(state.message ?? '', '', '正常启动不夹带清理噪音');
});

test('档案残留只剩后代活着（壳已死）→ 照样清掉，没配端口的服务也不会起出第二个实例', async () => {
  // 「没配端口」= 唯一性没有端口那道网兜底，档案里这棵树就成了唯一的凭据。
  // 只认壳的实现会在这里彻底失守：壳早死了 → 一个都不杀 → 新实例与老实例的后代同时跑。
  const h = await makeHarness({ services: [{ name: 'svc', port: null }] });
  const id = h.services[0].id;
  const started = await h.procManager.start(id);
  const child = h.adapter.seedChild(started.pid, { name: 'python.exe' });
  assert.ok(await waitForTreeSize(h.runtimeStore, id, 2), '先等档案把后代记下来');

  h.procManager.dispose(); // 控制台被杀：状态没了，档案还在
  h.adapter.vanish(started.pid); // 停机期间壳退出，后代还活着

  const state = await h.procManager.start(id);
  assert.equal(state.status, PROC_STATES.RUNNING);
  assert.equal(h.adapter.isLive(child.pid), false, '真正在跑的那个必须先死');
  assert.match(state.message ?? '', /已清理 1 个旧进程/, '消息里交代清理过谁');
});

test('无端口的服务：跳过端口清理，直接启动', async () => {
  const h = await makeHarness({ services: [{ name: 'svc', port: null }] });
  const state = await h.procManager.start(h.services[0].id);
  assert.equal(state.status, PROC_STATES.RUNNING);
  assert.equal(h.adapter.calls.portOwners.length, 0, '没配端口就不该去问 netstat');
});
