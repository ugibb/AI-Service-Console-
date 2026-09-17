/**
 * procManager 的防御性分支测试（QA 报告 6.1）。
 *
 * QA 对 procManager.js 做了变异测试，发现以下分支「没有任何用例保护」——
 * 把它们的返回值反转，全部用例仍然绿：
 *   - runSpawn：spawn 与 exit 极快连续发生（进程先退出，spawn 的 Promise 才 resolve）
 *   - waitForExit：进程静默消失（没有 exit 事件，只能问操作系统）
 *   - runStop：处于运行态但 PID 不是整数
 *   - runStop：内部会话已不存在时重建最小会话（见文件末尾说明：经分析不可达）
 *
 * 这些都是「上游给了不符合预期的输入时不要崩、不要做出错误动作」的护栏，
 * 平时跑不到，出事时是最后一道防线——正因如此必须有用例钉住。
 *
 * 为了让它们可确定性触发，这里用自定义 stub 适配器精确控制 spawn/onExit 的时序。
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness } from '../testkit/harness.js';
import { cleanupTempDirs } from '../testkit/tmp.js';

after(cleanupTempDirs);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('防御 runSpawn：spawn 与 exit 极快连续发生 → 保留退出诊断，不被迟到的 spawn 结果覆盖成 running', async () => {
  const h = await makeHarness({
    services: [{ name: 'race' }],
    adapter: {
      platform: 'stub-race',
      isSupported: () => true,
      // 进程先退出，spawn 的 Promise 才 resolve —— 真实世界里 .bat 秒退时会出现
      spawn({ onExit }) {
        return new Promise((resolve) => {
          setTimeout(() => {
            onExit({ code: 3, signal: null });
            resolve({ pid: 4242 });
          }, 5);
        });
      },
      async killTree() {
        return { ok: true, notFound: true };
      },
      isAlive: () => false,
    },
  });

  const id = h.services[0].id;
  await h.procManager.start(id);

  const state = h.procManager.getState(id);
  assert.equal(state.status, 'start_failed', '必须保留「启动失败」，不能被写成 running');
  assert.equal(state.reason, 'exited_early_nonzero');
  assert.equal(state.exitCode, 3);
  assert.equal(state.pid, null, '迟到的 pid 不能写进状态（进程已经没了）');
});

test('防御 waitForExit：停止时进程静默消失（收不到 exit 事件）→ 判定为已停止，且迟到的 exit 回调不再覆盖状态', async () => {
  const live = new Set();
  let exitHandler = null;
  const h = await makeHarness({
    services: [{ name: 'vanish' }],
    adapter: {
      platform: 'stub-vanish',
      isSupported: () => true,
      async spawn({ onExit }) {
        exitHandler = onExit;
        live.add(5000);
        return { pid: 5000 };
      },
      // taskkill 「成功」但进程其实没死
      async killTree() {
        return { ok: true, notFound: false };
      },
      isAlive: (pid) => live.has(pid),
    },
  });

  const id = h.services[0].id;
  await h.procManager.start(id);
  assert.equal(h.procManager.getState(id).pid, 5000);

  const stopping = h.procManager.stop(id);
  await sleep(10);
  live.delete(5000); // 静默消失：操作系统层面进程没了，但一个 exit 事件都没收到

  const result = await stopping;
  assert.equal(result.forced, false, '不是强杀，是等到进程自己没了');

  const state = h.procManager.getState(id);
  assert.equal(state.status, 'stopped');
  assert.equal(state.pid, null);
  assert.equal(state.exitCode, null, '没有 exit 事件 → 没有退出码可言');

  // 迟到的 exit 事件（真实世界里 taskkill 的收尾回调可能晚到）不能再改写已经确认的终态
  exitHandler({ code: 1, signal: null });
  assert.equal(h.procManager.getState(id).status, 'stopped', '已确认退出的会话必须忽略迟到的 exit 回调');
});

test('防御 runStop：处于运行态却拿不到整数 PID → 重置为已停止，绝不拿脏 PID 去 taskkill', async () => {
  const killCalls = [];
  const h = await makeHarness({
    services: [{ name: 'no-pid' }],
    adapter: {
      platform: 'stub-no-pid',
      isSupported: () => true,
      // 进程「起来了」，但适配器没给出可用 PID（契约是 resolve({ pid })，这里故意违约）
      async spawn() {
        return { pid: undefined };
      },
      async killTree(pid, options) {
        killCalls.push({ pid, ...options });
        return { ok: true, notFound: true };
      },
      isAlive: () => false,
    },
  });

  const id = h.services[0].id;
  await h.procManager.start(id);

  const result = await h.procManager.stop(id);

  assert.equal(result.alreadyStopped, true);
  assert.equal(killCalls.length, 0, 'pid 不是整数时不能去 killTree（会杀错对象或直接抛错）');

  const state = h.procManager.getState(id);
  assert.equal(state.status, 'stopped');
  assert.equal(state.pid, null);
  assert.match(state.message, /未记录到进程 PID/);
});

/*
 * 第四处 QA 标记的未覆盖分支是 runStop 里的 `if (!session) { …重建最小会话… }`（原 350-358 行）。
 *
 * 经逐条追查 `sessions` 的写入/删除点后，它在本实现里**不可达**，因此没有为它硬造用例：
 * `clearSession()`（唯一会从 sessions 里删除条目的函数）只有 4 个调用点，
 * 每一处都同时（或紧随其后）把状态打到终态 stopped / error / start_failed：
 *   - finishFailure()  → START_FAILED
 *   - handleExit()     → STOPPED / ERROR / START_FAILED
 *   - runStop() 第 440 行 → 紧跟 patch STOPPED
 *   - dispose()        → 连 states 一起清空
 * 而唯一的「运行态」入口 runSpawn/scheduleRunning 在那一刻必然持有仍存活会话……
 * 也就是说「状态是 running/starting（且 pid 是整数）却没有会话」这一前提构造不出来。
 * 详见交付报告：建议要么删掉该分支，要么保留为纯防御并接受它长期零覆盖。
 */
