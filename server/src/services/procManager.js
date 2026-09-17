/**
 * 进程生命周期编排（T1.4，[Mac 可验（逻辑）]）。
 *
 * 本模块不碰任何平台 API，只依赖 proc/adapter.js 定义的接口，
 * 因此在 macOS 上可以用 fake adapter 跑完整状态机。
 *
 * 状态机（PRD §7.1）：
 *   stopped ──启动──▶ starting ──spawn 成功──▶ running
 *                       │                        │
 *                       │spawn 失败               ├─退出码=0──▶ stopped
 *                       ▼                        └─退出码≠0──▶ error
 *                  start_failed
 *   running ──停止──▶ stopping ──优雅终止/超时强杀──▶ stopped
 *
 * 对 PRD §7.3「.bat 阻塞式」这一**未确认假设**的防御（本模块的关键设计）：
 * 1. spawn 成功后延迟 startVerifyDelayMs 校验 PID 是否仍存活 → 不存活则 start_failed(pid_vanished)；
 * 2. 启动窗口（startFailureWindowMs）内退出即视为启动失败，**包括退出码 0** ——
 *    退出码 0 的「启动即退出」型脚本会留下无法跟踪的孤儿进程，必须显式暴露而不是显示「已停止」；
 * 3. 两种情况都输出可直接照做的诊断提示（改用 start /wait 等）。
 */
import { serviceBusy, serviceNotFound } from '../lib/errors.js';
import { createDiagBuffer } from '../proc/diagBuffer.js';
import { preflight, resolveServicePaths } from './paths.js';

export const PROC_STATES = Object.freeze({
  STOPPED: 'stopped',
  STARTING: 'starting',
  RUNNING: 'running',
  STOPPING: 'stopping',
  ERROR: 'error',
  START_FAILED: 'start_failed',
});

/** 启动失败原因码（对前端/报告可见，便于诊断） */
export const FAILURE_REASONS = Object.freeze({
  PREFLIGHT_WORKDIR_MISSING: 'preflight_workdir_missing',
  PREFLIGHT_SCRIPT_MISSING: 'preflight_script_missing',
  PREFLIGHT_SCRIPT_NOT_FILE: 'preflight_script_not_file',
  SPAWN_ERROR: 'spawn_error',
  EXITED_EARLY_ZERO: 'exited_early_zero',
  EXITED_EARLY_NONZERO: 'exited_early_nonzero',
  PID_VANISHED: 'pid_vanished',
  KILL_FAILED: 'kill_failed',
});

/** 停止/启动过程中可以被再次点击的状态 */
const BUSY_STATES = [PROC_STATES.STARTING, PROC_STATES.RUNNING, PROC_STATES.STOPPING];
const RUNNING_STATES = [PROC_STATES.RUNNING, PROC_STATES.STARTING];

export const NONBLOCKING_HINT =
  '这通常是「启动即退出」型 .bat（脚本内部用 start 拉起后台进程后自身退出），' +
  '控制台拿不到真正的服务进程 PID，既无法判断状态也无法树杀。' +
  '请把脚本改成阻塞式，例如：start /wait "" "C:\\服务目录\\app.exe"，或去掉 start 直接前台运行服务进程。';

function blankState() {
  return {
    status: PROC_STATES.STOPPED,
    pid: null,
    exitCode: null,
    startedAt: null,
    exitedAt: null,
    message: null,
    reason: null,
    forcedKill: false,
    diag: [],
    generation: 0,
  };
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * @param {{
 *   adapter: { spawn: Function, killTree: Function, isAlive: Function, platform?: string },
 *   store: { get: Function, list: Function },
 *   config: { proc: object },
 *   logger?: object,
 *   now?: () => number,
 * }} options
 */
export function createProcManager({ adapter, store, config, logger = console, now = Date.now }) {
  const procConfig = config.proc;
  /** @type {Map<string, object>} 对外可见的运行时状态（不持久化，PRD §9） */
  const states = new Map();
  /** @type {Map<string, object>} 内部会话：定时器、spawn promise、诊断缓冲等 */
  const sessions = new Map();
  /** @type {Map<string, Promise>} 进行中的停止操作，避免重复点击产生并发杀进程 */
  const stopping = new Map();
  const listeners = new Set();

  const stateOf = (id) => states.get(id) ?? blankState();

  function patch(id, changes) {
    const previous = stateOf(id);
    const next = { ...previous, ...changes };
    states.set(id, next);
    // 只在状态真正变化时回调（statusMessage / diag 更新不触发，避免噪音）
    if (previous.status === next.status) return next;
    for (const listener of listeners) {
      try {
        listener(id, next);
      } catch (err) {
        logger.error?.(`状态回调异常：${err.message}`);
      }
    }
    return next;
  }

  function clearSession(id, session) {
    if (!session) return;
    for (const timer of session.timers) clearTimeout(timer);
    session.timers.clear();
    if (sessions.get(id) === session) sessions.delete(id);
  }

  function scheduleVerify(id, session) {
    const timer = setTimeout(() => {
      session.timers.delete(timer);
      const current = stateOf(id);
      if (session.generation !== current.generation) return;
      if (current.status !== PROC_STATES.RUNNING) return;
      if (session.exited) return;
      if (adapter.isAlive(current.pid)) return;
      finishFailure(id, session, {
        reason: FAILURE_REASONS.PID_VANISHED,
        message:
          `spawn 成功，但 ${procConfig.startVerifyDelayMs}ms 后 PID ${current.pid} 已不存在。` +
          `服务很可能没有真正跑起来，或脚本启动后立即退出。${NONBLOCKING_HINT}`,
      });
    }, procConfig.startVerifyDelayMs);
    session.timers.add(timer);
  }

  function finishFailure(id, session, { reason, message }) {
    session.diagBuffer.flush();
    clearSession(id, session);
    return patch(id, {
      status: PROC_STATES.START_FAILED,
      reason,
      message,
      exitCode: stateOf(id).exitCode,
      diag: session.diagBuffer.lines(),
    });
  }

  function appendDiag(id, session, chunk) {
    if (session.generation !== stateOf(id).generation) return;
    if (session.diagFrozen) return;
    session.diagBuffer.push(chunk);
  }

  /** 子进程退出（自行退出 / 被我们杀掉） */
  function handleExit(id, session, { code, signal } = {}) {
    if (session.generation !== stateOf(id).generation) return; // 过期回调（上一代进程）
    // 已经处理过退出（例如 waitForExit 先一步确认进程已消失）→ 不再覆盖状态
    if (session.exitHandled) return;
    session.exitHandled = true;
    session.exited = true;
    session.diagBuffer.flush();
    clearSession(id, session);

    const current = stateOf(id);
    const exitCode = typeof code === 'number' ? code : null;
    const base = { exitCode, exitedAt: now(), diag: session.diagBuffer.lines() };

    // 用户主动停止：退出码无意义，一律视为已停止（幂等）
    if (current.status === PROC_STATES.STOPPING) {
      patch(id, { ...base, status: PROC_STATES.STOPPED, reason: null, exitCode: null, message: '已停止' });
      return;
    }

    const elapsed = current.startedAt === null ? 0 : now() - current.startedAt;
    if (elapsed < procConfig.startFailureWindowMs) {
      const reason = exitCode === 0 ? FAILURE_REASONS.EXITED_EARLY_ZERO : FAILURE_REASONS.EXITED_EARLY_NONZERO;
      const message =
        exitCode === 0
          ? `脚本启动后 ${elapsed}ms 内以退出码 0 退出，服务并未在后台运行。${NONBLOCKING_HINT}`
          : `脚本启动后 ${elapsed}ms 内以退出码 ${exitCode ?? '未知'}（signal=${signal ?? '无'}）退出，服务未能运行起来。` +
            '请查看下方启动诊断输出定位原因。';
      patch(id, { ...base, status: PROC_STATES.START_FAILED, reason, message, exitCode });
      return;
    }

    if (exitCode === 0) {
      patch(id, { ...base, status: PROC_STATES.STOPPED, reason: null, message: `服务已自行退出（退出码 0）` });
      return;
    }
    patch(id, {
      ...base,
      status: PROC_STATES.ERROR,
      reason: 'exited_nonzero',
      message: `服务异常退出（退出码 ${exitCode ?? '未知'}）`,
    });
  }

  /** 启动：契约上始终返回 Promise（失败一律 reject，不在调用点同步抛错） */
  async function start(id) {
    const service = store.get(id);
    if (!service) throw serviceNotFound(id);
    const current = stateOf(id);
    if (BUSY_STATES.includes(current.status)) throw serviceBusy(id, current.status);

    const paths = resolveServicePaths(service);
    const generation = current.generation + 1;
    const session = {
      generation,
      timers: new Set(),
      diagBuffer: createDiagBuffer({ maxLines: procConfig.diagBufferLines }),
      spawnPromise: null,
      startFlow: null,
      exited: false,
      exitHandled: false,
      diagFrozen: false,
    };

    patch(id, {
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
    sessions.set(id, session);

    // 启动窗口结束后停止收集诊断输出（PRD §8.5：只在启动失败时有价值），
    // 并把已捕获的启动输出固化到状态里，供「查看详情」时排查。
    const freezeTimer = setTimeout(() => {
      session.diagFrozen = true;
      session.timers.delete(freezeTimer);
      if (stateOf(id).status === PROC_STATES.RUNNING) {
        patch(id, { diag: session.diagBuffer.lines() });
      }
    }, procConfig.startFailureWindowMs);
    session.timers.add(freezeTimer);

    // startFlow 在整个「spawn 落地 + 状态落到 running」之后才 resolve，
    // 这样「启动中点停止」能确定性地等到 pid 就绪（避免拿着 null pid 去停止）。
    const flow = runSpawn(id, session, paths);
    session.startFlow = flow;
    return flow;
  }

  async function runSpawn(id, session, paths) {
    const check = await preflight(paths);
    if (session.generation !== stateOf(id).generation) return stateOf(id);
    if (!check.ok) {
      return finishFailure(id, session, { reason: check.reason, message: check.message });
    }

    let spawnResult;
    const spawnPromise = adapter.spawn({
      scriptPath: paths.scriptPath,
      workDir: paths.workDir,
      onStdout: (chunk) => appendDiag(id, session, chunk),
      onStderr: (chunk) => appendDiag(id, session, chunk),
      onExit: (info) => handleExit(id, session, info),
    });
    session.spawnPromise = spawnPromise;
    try {
      spawnResult = await spawnPromise;
    } catch (err) {
      return finishFailure(id, session, {
        reason: FAILURE_REASONS.SPAWN_ERROR,
        message: `启动失败：${err.message}（脚本 ${paths.scriptPath}）`,
      });
    }

    if (session.generation !== stateOf(id).generation) return stateOf(id);
    if (session.exited) {
      // spawn 与 exit 极快连续发生：交给 handleExit 已写入的状态，不再覆盖
      return stateOf(id);
    }

    patch(id, {
      status: PROC_STATES.RUNNING,
      pid: spawnResult.pid,
      startedAt: now(),
      message: null,
    });
    scheduleVerify(id, session);
    return stateOf(id);
  }

  /** 等待进程消失：优先看退出事件，其次直接问操作系统（覆盖「已死但没收到事件」） */
  async function waitForExit(id, session, pid, timeoutMs) {
    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      if (session.exited) return true;
      if (!adapter.isAlive(pid)) {
        // 进程已消失但没有收到 exit 事件：标记为已处理，避免稍后到达的 exit 回调覆盖最终状态
        session.exited = true;
        session.exitHandled = true;
        return true;
      }
      await sleep(procConfig.exitPollIntervalMs);
    }
    return session.exited || !adapter.isAlive(pid);
  }

  async function stop(id) {
    const service = store.get(id);
    if (!service) throw serviceNotFound(id);
    const inFlight = stopping.get(id);
    if (inFlight) return inFlight;

    const task = runStop(id).finally(() => stopping.delete(id));
    stopping.set(id, task);
    return task;
  }

  async function runStop(id) {
    let current = stateOf(id);
    let session = sessions.get(id);

    if (current.status === PROC_STATES.STARTING && session?.startFlow) {
      await session.startFlow.catch(() => {});
      current = stateOf(id);
      session = sessions.get(id);
    }

    // 幂等：已经停了，或处于失败终态 → 直接对齐为 stopped，不报错
    if (!RUNNING_STATES.includes(current.status)) {
      patch(id, { status: PROC_STATES.STOPPED, exitCode: null, reason: null, message: null, diag: [], pid: null });
      return { ...stateOf(id), alreadyStopped: true, forced: false };
    }

    const pid = current.pid;
    if (!Number.isInteger(pid)) {
      patch(id, {
        status: PROC_STATES.STOPPED,
        pid: null,
        exitCode: null,
        reason: null,
        message: '未记录到进程 PID，已重置为已停止',
      });
      return { ...stateOf(id), alreadyStopped: true, forced: false };
    }

    patch(id, { status: PROC_STATES.STOPPING, message: `正在停止（pid=${pid}，taskkill /T）…` });
    if (!session) {
      session = {
        generation: current.generation,
        timers: new Set(),
        diagBuffer: createDiagBuffer({ maxLines: 1 }),
        exited: false,
        exitHandled: false,
      };
      sessions.set(id, session);
    }

    const graceful = await adapter.killTree(pid, { force: false });
    if (!graceful.ok) {
      patch(id, {
        status: PROC_STATES.ERROR,
        reason: FAILURE_REASONS.KILL_FAILED,
        message: `停止失败：${graceful.message ?? 'taskkill 执行异常'}`,
      });
      return { ...stateOf(id), forced: false, killFailed: true };
    }

    let exited = await waitForExit(id, session, pid, procConfig.stopGraceTimeoutMs);
    let forced = false;
    if (!exited) {
      forced = true;
      logger.warn?.(`服务 ${id} 优雅终止超时，改用 taskkill /T /F 强杀（pid=${pid}）`);
      const forcedResult = await adapter.killTree(pid, { force: true });
      if (!forcedResult.ok) {
        patch(id, {
          status: PROC_STATES.ERROR,
          reason: FAILURE_REASONS.KILL_FAILED,
          message: `强制终止失败：${forcedResult.message ?? 'taskkill /F 执行异常'}`,
        });
        return { ...stateOf(id), forced: true, killFailed: true };
      }
      exited = await waitForExit(id, session, pid, procConfig.stopGraceTimeoutMs);
    }

    clearSession(id, session);

    if (!exited) {
      patch(id, {
        status: PROC_STATES.ERROR,
        reason: FAILURE_REASONS.KILL_FAILED,
        forcedKill: true,
        message: `已尝试 taskkill /T /F，但 pid=${pid} 仍存活。请在任务管理器中手动确认该进程。`,
      });
      return { ...stateOf(id), forced: true, killFailed: true };
    }

    patch(id, {
      status: PROC_STATES.STOPPED,
      pid: null,
      exitCode: null,
      reason: null,
      forcedKill: forced,
      message: forced ? '已强制终止（taskkill /T /F）' : '已停止',
    });
    return { ...stateOf(id), forced };
  }

  async function restart(id) {
    const service = store.get(id);
    if (!service) throw serviceNotFound(id);
    const current = stateOf(id);
    if (RUNNING_STATES.includes(current.status) || current.status === PROC_STATES.STOPPING) {
      await stop(id);
    }
    return start(id);
  }

  return {
    platform: adapter.platform,
    /** 当前主机的适配器是否真的能启停进程（非 Windows 上为 false） */
    isSupported: () => adapter.isSupported?.() !== false,
    getState: (id) => ({ ...stateOf(id) }),
    /** 供列表接口合并运行时状态：覆盖 store 里的每个服务，未运行过的一律 stopped */
    snapshot() {
      const result = {};
      for (const service of store.list()) {
        result[service.id] = { ...blankState(), ...(states.get(service.id) ?? {}) };
      }
      for (const [id, value] of states) {
        if (!(id in result)) result[id] = { ...value };
      }
      return result;
    },
    isBusy: (id) => BUSY_STATES.includes(stateOf(id).status),
    onStateChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start,
    stop,
    restart,
    /** 进程退出/控制台关闭时清理定时器 */
    dispose() {
      for (const [id, session] of sessions) clearSession(id, session);
      states.clear();
      stopping.clear();
    },
  };
}
