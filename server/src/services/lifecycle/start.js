/**
 * 启动流程与「存活校验」（从 procManager.js 拆出，Task D）。
 *
 * 对 PRD §7.3「.bat 阻塞式」这一**未确认假设**的防御集中在这里：
 * 1. spawn 成功后在宽限期内保持 `starting`，期满仍存活才置 `running`（AI 服务加载慢的适配）；
 * 2. 延迟 startVerifyDelayMs 复查 PID 是否仍存活 → 不存活则 start_failed(pid_vanished)；
 * 3. 启动窗口内退出即视为启动失败（见 exit.js，**包括退出码 0**）。
 */
import { serviceBusy, serviceNotFound } from '../../lib/errors.js';
import { createDiagBuffer } from '../../proc/diagBuffer.js';
import { preflight, resolveServicePaths } from '../paths.js';
import {
  PROC_STATES,
  FAILURE_REASONS,
  TRANSIENT_STATES,
  RUNNING_STATES,
  NONBLOCKING_HINT,
  resolveProcTiming,
  formatGrace,
} from './constants.js';

/** 会话是否已被新的一代取代（上一代 spawn 的迟到结果不该写状态） */
const isStale = (runtime, id, session) => session.generation !== runtime.stateOf(id).generation;

function createStartSession(runtime, service, generation) {
  return {
    generation,
    timers: new Set(),
    diagBuffer: createDiagBuffer({ maxLines: runtime.procConfig.diagBufferLines }),
    spawnPromise: null,
    startFlow: null,
    exited: false,
    exitHandled: false,
    diagFrozen: false,
    ...resolveProcTiming(service, runtime.procConfig),
  };
}

/** 启动窗口结束后停止收集诊断输出（PRD §8.5：只在启动失败时有价值），并把已捕获的输出固化 */
function scheduleDiagFreeze(runtime, id, session) {
  const timer = setTimeout(() => {
    session.diagFrozen = true;
    session.timers.delete(timer);
    const status = runtime.stateOf(id).status;
    if (status === PROC_STATES.RUNNING || status === PROC_STATES.STARTING) {
      runtime.patch(id, { diag: session.diagBuffer.lines() });
    }
  }, session.failureWindowMs);
  session.timers.add(timer);
}

/** 宽限期结束仍存活 → running（AI 服务加载模型期间的「启动中」到此结束） */
function scheduleRunning(runtime, id, session) {
  const timer = setTimeout(() => {
    session.timers.delete(timer);
    if (isStale(runtime, id, session)) return;
    if (session.exited) return;
    if (runtime.stateOf(id).status !== PROC_STATES.STARTING) return;
    // 清理备注要跟着进 running：那是用户点的这一次「启动」实际做了什么的交代
    runtime.patch(id, { status: PROC_STATES.RUNNING, message: session.cleanupNote ?? null });
  }, session.graceMs);
  session.timers.add(timer);
}

/** spawn 成功后延迟校验 PID 存活（防御「启动即退出」型 .bat 的静默消失） */
function scheduleVerify(runtime, id, session, exits) {
  const timer = setTimeout(() => {
    session.timers.delete(timer);
    const current = runtime.stateOf(id);
    if (session.generation !== current.generation) return;
    // 宽限期内是 starting、之后是 running，两种状态都要盯 PID 存活
    if (current.status !== PROC_STATES.RUNNING && current.status !== PROC_STATES.STARTING) return;
    if (session.exited) return;
    if (runtime.adapter.isAlive(current.pid)) return;
    exits.finishFailure(id, session, {
      reason: FAILURE_REASONS.PID_VANISHED,
      message:
        `spawn 成功，但 ${runtime.procConfig.startVerifyDelayMs}ms 后 PID ${current.pid} 已不存在。` +
        `服务很可能没有真正跑起来，或脚本启动后立即退出。${NONBLOCKING_HINT}`,
    });
  }, runtime.procConfig.startVerifyDelayMs);
  session.timers.add(timer);
}

/**
 * 启动窗口内反复补记子树。
 *
 * 为什么不能只写一次：`persistPid` 跑在 spawn 落地的**那一拍**，而真正的服务进程
 * 往往几秒后才出生（现场那只 `start-calibre-web.bat` 要先 powershell 清旧进程、
 * 再 `ping -n 3` 等一下，最后才拉起 python）。只写一次，档案里就永远只有一个壳——
 * 而壳恰恰是会先死的那个。
 *
 * 有界（treeRefreshWindowMs 到点即停）+ 只在树真变了才落盘（procManager.refreshTree 里判）。
 */
function scheduleTreeRefresh(runtime, id, session, pid) {
  if (!runtime.refreshTree) return;
  const deadline = runtime.now() + runtime.procConfig.treeRefreshWindowMs;
  // 一次补记要跑一遍 wmic（真机 ~150ms），机器忙时可能超过间隔——用 inFlight 挡住叠加，
  // 免得后一次扫描与前一次的结果互相覆盖
  let inFlight = false;
  const timer = setInterval(() => {
    const state = runtime.stateOf(id);
    // 过期一代、或已经不在「这次启动」的轨道上（被停止/重启取代）→ 收工
    if (isStale(runtime, id, session) || session.exited) {
      stopRefresh();
      return;
    }
    if (state.status !== PROC_STATES.STARTING && state.status !== PROC_STATES.RUNNING) {
      stopRefresh();
      return;
    }
    if (runtime.now() >= deadline) {
      stopRefresh();
      return;
    }
    if (inFlight) return;
    inFlight = true;
    void runtime.refreshTree(id, pid).finally(() => {
      inFlight = false;
    });
  }, runtime.procConfig.treeRefreshIntervalMs);
  function stopRefresh() {
    clearInterval(timer);
    session.timers.delete(timer);
  }
  session.timers.add(timer);
}

/** spawn 落地后落状态：宽限期 > 0 保持 starting（计时），否则直接 running */
function settleSpawn(runtime, id, session, pid) {
  const startedAt = runtime.now();
  if (session.graceMs > 0) {
    // 宽限期内保持「启动中」：AI 服务此时模型还没加载完，不能显示成「运行中」骗用户。
    // 状态没变（start 时已是 starting），因此 patch 不会触发状态回调，只更新 pid / startedAt。
    runtime.patch(id, {
      pid,
      startedAt,
      message: `启动中：进程已拉起（pid=${pid}），等待服务就绪（宽限期 ${formatGrace(session.graceMs)}）`,
    });
    scheduleRunning(runtime, id, session);
  } else {
    runtime.patch(id, { status: PROC_STATES.RUNNING, pid, startedAt, message: session.cleanupNote ?? null });
  }
  // pid 是此刻已知的——立即把「壳 + 子树 + OS 创建时间」写进接管档案（见 procManager.persistPid）。
  // 控制台随时可能被杀，晚一拍写就少一拍能接管。
  void runtime.persistPid?.(id, pid);
  // 后代这时候多半还没出生，启动窗口内持续补记（见上）
  scheduleTreeRefresh(runtime, id, session, pid);
}

async function runSpawn(runtime, exits, id, session, paths) {
  const check = await preflight(paths);
  if (isStale(runtime, id, session)) return runtime.stateOf(id);
  if (!check.ok) return exits.finishFailure(id, session, { reason: check.reason, message: check.message });

  const spawnPromise = runtime.adapter.spawn({
    scriptPath: paths.scriptPath,
    workDir: paths.workDir,
    onStdout: (chunk) => runtime.appendDiag(id, session, chunk),
    onStderr: (chunk) => runtime.appendDiag(id, session, chunk),
    onExit: (info) => exits.handleExit(id, session, info),
  });
  session.spawnPromise = spawnPromise;

  let spawnResult;
  try {
    spawnResult = await spawnPromise;
  } catch (err) {
    return exits.finishFailure(id, session, {
      reason: FAILURE_REASONS.SPAWN_ERROR,
      message: `启动失败：${err.message}（脚本 ${paths.scriptPath}）`,
    });
  }

  if (isStale(runtime, id, session)) return runtime.stateOf(id);
  if (session.exited) {
    // spawn 与 exit 极快连续发生：交给 handleExit 已写入的状态，不再覆盖
    return runtime.stateOf(id);
  }

  settleSpawn(runtime, id, session, spawnResult.pid);
  scheduleVerify(runtime, id, session, exits);
  return runtime.stateOf(id);
}

export function createStartOps(runtime, exits, { stop } = {}) {
  /**
   * 启动：契约上始终返回 Promise（失败一律 reject，不在调用点同步抛错）。
   *
   * 「启动」的语义是**确保系统里只有一个实例在跑**，不是「再起一个」：
   * - starting / stopping：过渡态，等它走完（SERVICE_BUSY，与既有行为一致）；
   * - running / adopted：先走完整停止流程（两段式树杀 + 档案清理），再重新启动；
   * - 其余（stopped / error / start_failed）：进入启动前清理。
   *
   * entering 状态（STARTING patch）保持在第一个 await 之前完成：
   * 点下的那一拍状态就是 starting——并发的第二次点进来直接被 TRANSIENT 守卫拦住。
   */
  async function start(id) {
    const service = runtime.store.get(id);
    if (!service) throw serviceNotFound(id);
    const current = runtime.stateOf(id);
    if (TRANSIENT_STATES.includes(current.status)) throw serviceBusy(id, current.status);

    // 正在跑的（含接管的）先停干净——不先杀就 spawn，新旧两个实例会抢同一个端口
    if (RUNNING_STATES.includes(current.status)) {
      await stop(id);
    }

    const paths = resolveServicePaths(service);
    // 代数从 runtime 的全局计数器取（单调递增、dispose 不复位），
    // 而不是「当前状态里的代数 +1」——状态表清空后后者会从头计数，
    // 让旧会话的迟到回调冒充当代（见 runtime.js 的 nextGeneration 注释）
    const generation = runtime.nextGeneration();
    const session = createStartSession(runtime, service, generation);

    runtime.patch(id, {
      status: PROC_STATES.STARTING,
      pid: null,
      exitCode: null,
      startedAt: null,
      exitedAt: null,
      forcedKill: false,
      reason: null,
      message: `正在启动：${paths.scriptPath}`,
      diag: [],
      generation,
    });
    runtime.sessions.set(id, session);
    scheduleDiagFreeze(runtime, id, session);

    // 启动前清理（spawn 之前）：档案残留的旧 pid + 占用声明端口的进程。
    // 用户的明确选择：端口写在服务配置里就是声明归属，占用者一律清掉。
    if (runtime.cleanup) {
      const outcome = await runtime.cleanup.clearForeign(service, runtime.stateOf(id));
      if (!outcome.ok) {
        return runtime.patch(id, {
          status: PROC_STATES.START_FAILED,
          pid: null,
          exitCode: null,
          startedAt: null,
          reason: FAILURE_REASONS.PRESTART_CLEANUP_FAILED,
          message: outcome.message,
          diag: [],
        });
      }
      if (outcome.killed.length > 0) {
        const summary = outcome.killed.map((item) => `${item.name}(${item.pid})`).join('、');
        session.cleanupNote = `本次启动前已清理 ${outcome.killed.length} 个旧进程：${summary}`;
        runtime.patch(id, { message: `正在启动：${paths.scriptPath}（${session.cleanupNote}）` });
      }
      // 清理期间若被并发操作改了状态（如点了停止把状态打回 stopped），
      // 尊重后发生的那次操作，不再 spawn——与 runSpawn 里的过期检查同一原则
      if (runtime.stateOf(id).status !== PROC_STATES.STARTING) return runtime.stateOf(id);
    }

    // startFlow 在整个「spawn 落地 + 状态落到 running」之后才 resolve，
    // 这样「启动中点停止」能确定性地等到 pid 就绪（避免拿着 null pid 去停止）。
    const flow = runSpawn(runtime, exits, id, session, paths);
    session.startFlow = flow;
    return flow;
  }

  return { start };
}
