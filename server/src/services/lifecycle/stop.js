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

/** 两段式树杀：优雅 → 超时强杀。返回 { failedResult } 或 { exited, forced } */
async function terminate(runtime, id, session, pid) {
  const graceful = await runtime.adapter.killTree(pid, { force: false });
  if (!graceful.ok) {
    return { failedResult: markKillFailed(runtime, id, `停止失败：${graceful.message ?? 'taskkill 执行异常'}`, false) };
  }

  let exited = await waitForExit(runtime, session, pid, runtime.procConfig.stopGraceTimeoutMs);
  let forced = false;
  if (!exited) {
    forced = true;
    runtime.logger.warn?.(`服务 ${id} 优雅终止超时，改用 taskkill /T /F 强杀（pid=${pid}）`);
    const forcedResult = await runtime.adapter.killTree(pid, { force: true });
    if (!forcedResult.ok) {
      const message = `强制终止失败：${forcedResult.message ?? 'taskkill /F 执行异常'}`;
      return { failedResult: markKillFailed(runtime, id, message, true) };
    }
    exited = await waitForExit(runtime, session, pid, runtime.procConfig.stopGraceTimeoutMs);
  }
  return { exited, forced };
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

  runtime.patch(id, { status: PROC_STATES.STOPPING, message: `正在停止（pid=${pid}，taskkill /T）…` });
  session = ensureStopSession(runtime, id, current);

  const outcome = await terminate(runtime, id, session, pid);
  if (outcome.failedResult) return outcome.failedResult;

  runtime.clearSession(id, session);
  if (!outcome.exited) return stillAlive(runtime, id, pid);
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
