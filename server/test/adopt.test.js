/**
 * 接管（adopt）测试：控制台重启后，对上个会话启动、且验明正身仍在跑的进程的认领。
 *
 * 关键路径全部覆盖：
 * - 正身证明链（pid 活着 + OS 创建时间精确相等）各断一环时分别发生什么；
 * - 接管后的三种归宿：正常停止 / 自行退出（轮询发现）/ 再次启动（先杀再起）；
 * - 档案写入：spawn 落地即写，终态即清。
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { PROC_STATES } from '../src/services/procManager.js';
import { createProcManager } from '../src/services/procManager.js';
import {
  createSilentLogger,
  makeHarness,
  makeProcConfig,
  waitForArchive,
  waitForArchiveGone,
  waitForStatus,
  waitForTreeSize,
} from '../testkit/harness.js';
import { cleanupTempDirs } from '../testkit/tmp.js';

after(cleanupTempDirs);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('完整闭环：启动写档案 → 新会话对账 → 接管为 adopted → 停止可用', async () => {
  const h = await makeHarness({ services: [{ name: 'svc' }] });
  const id = h.services[0].id;

  // 第一段：启动并等到 running，档案应有 pid + 创建时间（来自适配器的 OS 快照）
  const first = await h.procManager.start(id);
  assert.equal(first.status, PROC_STATES.RUNNING);
  const entry = await waitForArchive(h.runtimeStore, id);
  assert.ok(entry, 'spawn 落地后档案必须已写入');
  assert.equal(entry.pid, first.pid);
  // startedAt 跨「内存 epoch 毫秒 ↔ 档案 ISO 串」这道边界来回一趟，不能在这掉成 null
  assert.equal(typeof entry.startedAt, 'string', '档案里存 ISO 串');
  assert.equal(entry.startedAt, new Date(first.startedAt).toISOString());

  // 第二段：模拟「控制台重启」——同一个 store/档案/适配器，全新的 procManager（运行时状态清零）
  const reborn = createProcManager({
    adapter: h.adapter,
    store: h.store,
    config: makeProcConfig(),
    runtimeStore: h.runtimeStore,
    logger: createSilentLogger(),
  });
  await reborn.reconcileAdopted();
  const adopted = reborn.getState(id);
  assert.equal(adopted.status, PROC_STATES.ADOPTED);
  assert.equal(adopted.pid, first.pid, '接管后 pid 可见');
  assert.equal(adopted.startedAt, first.startedAt, '接管要把启动时刻一并带过来（ISO 串转回 epoch 毫秒）');
  assert.match(adopted.message, /已接管/);

  // 第三段：接管的进程能停（两段式树杀对非子进程同样成立）
  const stopped = await reborn.stop(id);
  assert.equal(stopped.status, PROC_STATES.STOPPED);
  assert.equal(h.adapter.isLive(first.pid), false);
  assert.equal(await waitForArchiveGone(h.runtimeStore, id), null, '停止后档案清空');
  reborn.dispose();
});

test('档案记的是整棵子树：壳 + 后续长出来的后代（补记靠启动窗口内的轮询）', async () => {
  const h = await makeHarness({ services: [{ name: 'svc' }] });
  const id = h.services[0].id;
  const started = await h.procManager.start(id);
  // spawn 那一刻后代还没出生——真机上 `.bat` 要先 powershell、ping、再拉 python，好几秒
  const child = h.adapter.seedChild(started.pid, { name: 'python.exe' });

  const entry = await waitForTreeSize(h.runtimeStore, id, 2);
  assert.deepEqual(
    entry?.tree?.map((member) => [member.pid, member.depth]),
    [
      [started.pid, 0],
      [child.pid, 1],
    ],
    '档案要同时记下壳和后代，且带上各自的创建时间',
  );
  assert.ok(entry.tree.every((member) => typeof member.creationDate === 'string' && member.creationDate.length > 0));
  h.procManager.dispose();
});

test('壳先死、后代还在跑 → 控制台重启后照样接管（代表 pid 取活着的后代）', async () => {
  const h = await makeHarness({ services: [{ name: 'svc' }] });
  const id = h.services[0].id;
  const started = await h.procManager.start(id);
  const child = h.adapter.seedChild(started.pid, { name: 'python.exe' });
  assert.ok(await waitForTreeSize(h.runtimeStore, id, 2), '先等档案把后代记下来');

  h.procManager.dispose(); // 模拟控制台被杀
  h.adapter.vanish(started.pid); // 停机期间壳退出了——真机实测 3/3 都是这样

  await h.procManager.reconcileAdopted();
  const state = h.procManager.getState(id);
  assert.equal(state.status, PROC_STATES.ADOPTED, '壳没了不等于服务没了');
  assert.equal(state.pid, child.pid, '卡片上显示的是活着的那个（用户能在任务管理器里找到它）');
  assert.match(state.message, /已接管/);
  assert.match(state.message, /原启动壳/, '文案要交代壳已退出，否则用户对不上自己看到的 pid');

  // 停止必须能杀掉后代：`taskkill /T` 顺着一棵断掉的树是够不到它的
  const stopped = await h.procManager.stop(id);
  assert.equal(stopped.status, PROC_STATES.STOPPED);
  assert.equal(h.adapter.isLive(child.pid), false, '后代被杀掉，服务才算真停');
  assert.equal(await waitForArchiveGone(h.runtimeStore, id), null);
});

test('运行中壳退出、后代还在跑 → 判「已接管」而不是「异常退出」（真机退出码 1 的那一幕）', async () => {
  const h = await makeHarness({ services: [{ name: 'svc' }] });
  const id = h.services[0].id;
  const started = await h.procManager.start(id);
  const child = h.adapter.seedChild(started.pid, { name: 'python.exe' });
  assert.ok(await waitForTreeSize(h.runtimeStore, id, 2));

  h.adapter.exit(started.pid, 1); // 现场：壳带退出码 1 退出，它拉起的 python 继续监听着端口
  const state = await waitForStatus(h.procManager, id, PROC_STATES.ADOPTED);
  assert.equal(state.pid, child.pid, '代表 pid 取活着的后代');
  assert.equal(state.reason, null);
  assert.match(state.message, /子进程仍在运行/);
  assert.ok(h.runtimeStore.get(id), '档案必须留着——它是下次「启动」清掉旧实例的唯一凭据');
});

test('壳死后转接管：没配端口的服务也能保证唯一性（点「启动」先清掉那批后代）', async () => {
  const h = await makeHarness({ services: [{ name: 'svc', port: null }] });
  const id = h.services[0].id;
  const first = await h.procManager.start(id);
  const child = h.adapter.seedChild(first.pid, { name: 'python.exe' });
  assert.ok(await waitForTreeSize(h.runtimeStore, id, 2));
  h.adapter.exit(first.pid, 1);
  await waitForStatus(h.procManager, id, PROC_STATES.ADOPTED);

  const second = await h.procManager.start(id);
  assert.equal(second.status, PROC_STATES.RUNNING);
  assert.equal(h.adapter.isLive(child.pid), false, '真正占着服务的后代必须先死，否则就是两个实例');
  assert.notEqual(second.pid, first.pid);
  assert.equal((await waitForArchive(h.runtimeStore, id))?.pid, second.pid, '档案指向新实例');
});

test('对账：档案里的 pid 已死 → 不接管、清档案、状态保持 stopped', async () => {
  const h = await makeHarness({ services: [{ name: 'svc' }] });
  const id = h.services[0].id;
  const started = await h.procManager.start(id);
  h.procManager.dispose(); // 模拟控制台直接被杀：进程还在，状态没了

  h.adapter.vanish(started.pid); // 停机期间进程自己退了
  await h.procManager.reconcileAdopted();
  assert.equal(h.procManager.getState(id).status, PROC_STATES.STOPPED);
  assert.equal(h.runtimeStore.get(id), null);
});

test('对账：pid 活着但创建时间对不上（pid 被复用）→ 丢弃档案 + 卡片上留可见提示', async () => {
  const h = await makeHarness({ services: [{ name: 'svc' }] });
  const id = h.services[0].id;
  const started = await h.procManager.start(id);
  h.procManager.dispose();

  // 停机间隙：pid 被系统回收又分给了别的进程（同 pid、不同创建时间）
  h.adapter.seedProcess(started.pid, { name: 'unrelated.exe', creationDate: '20300101000000.000000+480' });
  await h.procManager.reconcileAdopted();

  const state = h.procManager.getState(id);
  assert.equal(state.status, PROC_STATES.STOPPED, '绝不认领别人的进程');
  assert.equal(state.pid, null);
  assert.match(state.message, /已被其他进程复用/, '卡片上必须能看到这句话（statusMessage 通道）');
  assert.equal(h.runtimeStore.get(id), null);
  assert.equal(h.adapter.isLive(started.pid), true, '那个无关进程毫发无损');
});

test('对账：台账里已删除的服务，档案条目随之清除', async () => {
  const h = await makeHarness({ services: [{ name: 'svc' }] });
  const id = h.services[0].id;
  await h.procManager.start(id);
  h.procManager.dispose();
  assert.ok(await waitForArchive(h.runtimeStore, id));

  await h.store.remove(id);
  await h.procManager.reconcileAdopted();
  assert.equal(h.runtimeStore.get(id), null);
});

test('接管的进程自行退出：低频轮询发现后落回 stopped，不撒谎', async () => {
  const h = await makeHarness({ services: [{ name: 'svc' }] });
  const id = h.services[0].id;
  const started = await h.procManager.start(id);
  h.procManager.dispose();
  await h.procManager.reconcileAdopted();
  assert.equal(h.procManager.getState(id).status, PROC_STATES.ADOPTED);

  h.adapter.vanish(started.pid); // 没有 exit 事件，静默消失——只能靠轮询
  await sleep(120); // adoptedPollIntervalMs=40（harness），两个周期足够
  const state = h.procManager.getState(id);
  assert.equal(state.status, PROC_STATES.STOPPED);
  assert.match(state.message, /接管的进程已退出/);
  assert.equal(await waitForArchiveGone(h.runtimeStore, id), null);
});

test('adopted 下点「启动」= 杀掉接管的进程再起新的（确保只有一个实例）', async () => {
  const h = await makeHarness({ services: [{ name: 'svc' }] });
  const id = h.services[0].id;
  const first = await h.procManager.start(id);
  h.procManager.dispose();
  await h.procManager.reconcileAdopted();
  assert.equal(h.procManager.getState(id).status, PROC_STATES.ADOPTED);

  const second = await h.procManager.start(id);
  assert.equal(second.status, PROC_STATES.RUNNING);
  assert.notEqual(second.pid, first.pid);
  assert.equal(h.adapter.isLive(first.pid), false, '接管的旧实例被杀');
  assert.equal(h.adapter.isLive(second.pid), true);
  assert.equal((await waitForArchive(h.runtimeStore, id))?.pid, second.pid, '档案指向新实例');
});

test('adopted 计入 BUSY：编辑/删除被拒（与 running 同权）', async () => {
  const h = await makeHarness({ services: [{ name: 'svc' }] });
  const id = h.services[0].id;
  const started = await h.procManager.start(id);
  h.procManager.dispose();
  await h.procManager.reconcileAdopted();
  assert.equal(h.procManager.isBusy(id), true);
  assert.equal(h.procManager.getState(id).status, PROC_STATES.ADOPTED);
  assert.equal(h.adapter.isLive(started.pid), true);
});

test('进程正常退出后档案被清（终态监听器），不留死 pid 给下次对账', async () => {
  const h = await makeHarness({ services: [{ name: 'svc' }] });
  const id = h.services[0].id;
  const started = await h.procManager.start(id);
  assert.ok(await waitForArchive(h.runtimeStore, id));

  h.adapter.exit(started.pid, 1); // 立即退出 → 落在失败窗口内 → start_failed
  await sleep(30);
  assert.equal(h.procManager.getState(id).status, PROC_STATES.START_FAILED);
  assert.equal(await waitForArchiveGone(h.runtimeStore, id), null, '终态必须清档案，否则下次对账拿着死 pid 空欢喜');
});
