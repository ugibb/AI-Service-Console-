/**
 * 停止流程与进程树终止（从 procManager.js 拆出，Task D）。
 *
 * 两段式树杀：`taskkill /T`（优雅）→ 等 stopGraceTimeoutMs → 未退出则 `/T /F` 强杀。
 * `stop` 用 stopping 表做并发去重（重复点击复用同一个 Promise），runStop 里再保证幂等。
 */
import { serviceNotFound } from '../../lib/errors.js';
import { createDiagBuffer } from '../../proc/diagBuffer.js';
import { PROC_STATES, FAILURE_REASONS, RUNNING_STATES, sleep } from './constants.js';

/** 等进程消失：优先看退出事件，其次直接问操作系统（覆盖「已死但没收到事件」） */
async function waitForExit(runtime, session, pid, timeoutMs) {
  const deadline = runtime.now() + timeoutMs;
  while (runtime.now() < deadline) {
    if (session.exited) return true;
    if (!runtime.adapter.isAlive(pid)) {
      // 进程已消失但没有收到 exit 事件：标记为已处理，避免稍后到达的 exit 回调覆盖最终状态
      session.exited = true;
      session.exitHandled = true;
      return true;
    }
    await sleep(runtime.procConfig.exitPollIntervalMs);
  }
  return session.exited || !runtime.adapter.isAlive(pid);
}

/** 幂等：已经停了/失败终态 → 对齐为 stopped，不报错 */
function resetStopped(runtime, id) {
  runtime.patch(id, { status: PROC_STATES.STOPPED, exitCode: null, reason: null, message: null, diag: [], pid: null });
  return { ...runtime.stateOf(id), alreadyStopped: true, forced: false };
}

/** 运行态却拿不到可用 PID：绝不拿脏 PID 去 taskkill */
function resetPidMissing(runtime, id) {
  runtime.patch(id, {
    status: PROC_STATES.STOPPED,
    pid: null,
    exitCode: null,
    reason: null,
    message: '未记录到进程 PID，已重置为已停止',
  });
  return { ...runtime.stateOf(id), alreadyStopped: true, forced: false };
}

/** 会话已不存在时的最小重建（供 exit 事件/waitForExit 标记，避免迟到回调覆盖终态） */
function ensureStopSession(runtime, id, current) {
  const existing = runtime.sessions.get(id);
  if (existing) return existing;
  const session = {
    generation: current.generation,
    timers: new Set(),
    diagBuffer: createDiagBuffer({ maxLines: 1 }),
    exited: false,
    exitHandled: false,
  };
  runtime.sessions.set(id, session);
  return session;
}

function markKillFailed(runtime, id, message, forced) {
  runtime.patch(id, { status: PROC_STATES.ERROR, reason: FAILURE_REASONS.KILL_FAILED, message });
  return { ...runtime.stateOf(id), forced, killFailed: true };
}

/**
 * 两段式树杀：优雅 → 超时强杀。返回 { failedResult } 或 { exited, forced, stubborn }
 *
 * ⚠️ 优雅失败**不是**终点（与 cleanup.js 同一条政策，2026-09-18 真机实测）：
 * `taskkill /PID N /T` 对 python 这类没有窗口消息循环的进程直接退出码 255、
 * 文案「只能强制终止此进程(带 /F 选项)」。若在这里判死，用户点「停止」拿到的
 * 是一个红色失败态 + 「去任务管理器」，而进程照样在跑——正是这条断头路要被铲掉。
 * 强杀再失败才是真的杀不掉。
 *
 * ⚠️ 为什么是**一组** pid 而不是一个：`taskkill /T` 只能顺着一棵树往下杀，
 * 前提是根还活着。启动壳先死的那种局面下根已经没了（`/T` 直接报找不到进程），
 * 而真正占着端口的后代活得好好的——「停止」必须逐个成员点名。
 */
async function terminate(runtime, id, session, pids) {
  const targets = [...pids];

  let gracefulAllOk = true;
  for (const pid of targets) {
    const graceful = await runtime.adapter.killTree(pid, { force: false });
    if (graceful.ok) continue;
    // 优雅这一路已经明确「杀不动」→ 不给它白等宽限期，直接进强杀（老行为，别退化）
    gracefulAllOk = false;
    runtime.logger.warn?.(`服务 ${id} 优雅终止失败（${graceful.message ?? 'taskkill 执行异常'}），改用 taskkill /T /F 强杀（pid=${pid}）`);
  }
  if (gracefulAllOk && (await waitForAllGone(runtime, session, targets, runtime.procConfig.stopGraceTimeoutMs))) {
    return { exited: true, forced: false };
  }

  // 强杀这一轮按「谁还活着」逐个来：已死的再报一次 taskkill 只会多一行错误输出
  for (const pid of targets) {
    if (!runtime.adapter.isAlive(pid)) continue;
    if (gracefulAllOk) runtime.logger.warn?.(`服务 ${id} 优雅终止超时，改用 taskkill /T /F 强杀（pid=${pid}）`);
    const forcedResult = await runtime.adapter.killTree(pid, { force: true });
    if (!forcedResult.ok) {
      const message = `强制终止失败：${forcedResult.message ?? 'taskkill /F 执行异常'}`;
      return { failedResult: markKillFailed(runtime, id, message, true) };
    }
  }
  const exited = await waitForAllGone(runtime, session, targets, runtime.procConfig.stopGraceTimeoutMs);
  return { exited, forced: true };
}

/** 等这一组 pid 全部消失（逐个问操作系统，退出事件只覆盖主进程） */
async function waitForAllGone(runtime, session, pids, timeoutMs) {
  if (pids.length === 1) return waitForExit(runtime, session, pids[0], timeoutMs);
  const deadline = runtime.now() + timeoutMs;
  while (runtime.now() < deadline) {
    if (session.exited && pids.every((pid) => !runtime.adapter.isAlive(pid))) return true;
    if (pids.every((pid) => !runtime.adapter.isAlive(pid))) {
      session.exited = true;
      session.exitHandled = true;
      return true;
    }
    await sleep(runtime.procConfig.exitPollIntervalMs);
  }
  return pids.every((pid) => !runtime.adapter.isAlive(pid));
}

/** 强杀后仍存活：只能让用户去任务管理器手动确认 */
function stillAlive(runtime, id, pid) {
  runtime.patch(id, {
    status: PROC_STATES.ERROR,
    reason: FAILURE_REASONS.KILL_FAILED,
    forcedKill: true,
    message: `已尝试 taskkill /T /F，但 pid=${pid} 仍存活。请在任务管理器中手动确认该进程。`,
  });
  return { ...runtime.stateOf(id), forced: true, killFailed: true };
}

function finishStopped(runtime, id, forced) {
  runtime.patch(id, {
    status: PROC_STATES.STOPPED,
    pid: null,
    exitCode: null,
    reason: null,
    forcedKill: forced,
    message: forced ? '已强制终止（taskkill /T /F）' : '已停止',
  });
  return { ...runtime.stateOf(id), forced };
}

async function runStop(runtime, id) {
  let current = runtime.stateOf(id);
  let session = runtime.sessions.get(id);

  // 启动中点停止：等 spawn 落地（pid 就绪）再动手，避免拿 null pid 去 kill
  if (current.status === PROC_STATES.STARTING && session?.startFlow) {
    await session.startFlow.catch(() => {});
    current = runtime.stateOf(id);
    session = runtime.sessions.get(id);
  }

  if (!RUNNING_STATES.includes(current.status)) return resetStopped(runtime, id);

  const pid = current.pid;
  if (!Number.isInteger(pid)) return resetPidMissing(runtime, id);

  // 要杀的**不止**主 pid：接管来的服务里，壳可能早就死了而真正占端口的后代还活着，
  // `taskkill /T` 顺着一棵断掉的树是杀不到它们的（见 adopt.js 的说明）。
  // 取不到档案（runtimeStore 关掉/条目已被清）时退化成只杀主 pid，与老行为一致。
  let provenPids = [];
  try {
    provenPids = (await runtime.provenPids?.(id)) ?? [];
  } catch (err) {
    runtime.logger.warn?.(`停止前读取接管档案失败：${err.message}`);
  }
  const targets = [...new Set([pid, ...provenPids])];

  runtime.patch(id, {
    status: PROC_STATES.STOPPING,
    message: `正在停止（pid=${targets.join('、')}，taskkill /T）…`,
  });
  session = ensureStopSession(runtime, id, current);

  const outcome = await terminate(runtime, id, session, targets);
  if (outcome.failedResult) return outcome.failedResult;

  runtime.clearSession(id, session);
  if (!outcome.exited) return stillAlive(runtime, id, pid);
  runtime.clearAdoptPids?.(id); // 认领清单随服务停止一起失效
  return finishStopped(runtime, id, outcome.forced);
}

export function createStopOps(runtime) {
  async function stop(id) {
    const service = runtime.store.get(id);
    if (!service) throw serviceNotFound(id);
    const inFlight = runtime.stopping.get(id);
    if (inFlight) return inFlight;

    const task = runStop(runtime, id).finally(() => runtime.stopping.delete(id));
    runtime.stopping.set(id, task);
    return task;
  }

  return { stop };
}
