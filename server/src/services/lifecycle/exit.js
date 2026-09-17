/**
 * 子进程退出 / 启动失败的处理（从 procManager.js 拆出，Task D）。
 *
 * 这里集中回答一个问题：**进程没了，该把状态定成什么、给用户什么话**。
 * 三种走向——主动停止（stopping）、启动窗口内退出（start_failed）、窗口后异常退出（stopped / error）。
 */
import { PROC_STATES, FAILURE_REASONS, NONBLOCKING_HINT } from './constants.js';

/** 启动窗口内退出的失败原因与文案（纯函数，零/非零退出码分开给建议） */
function earlyExitFailure(exitCode, signal, elapsed) {
  if (exitCode === 0) {
    return {
      reason: FAILURE_REASONS.EXITED_EARLY_ZERO,
      message: `脚本启动后 ${elapsed}ms 内以退出码 0 退出，服务并未在后台运行。${NONBLOCKING_HINT}`,
    };
  }
  return {
    reason: FAILURE_REASONS.EXITED_EARLY_NONZERO,
    message:
      `脚本启动后 ${elapsed}ms 内以退出码 ${exitCode ?? '未知'}（signal=${signal ?? '无'}）退出，服务未能运行起来。` +
      '请查看下方启动诊断输出定位原因。',
  };
}

export function createExitHandling(runtime) {
  const { stateOf, patch, clearSession, now, procConfig } = runtime;

  /** 启动失败：固化诊断缓冲、清掉会话，把原因落到状态里（供 UI 展示） */
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
    const window = session.failureWindowMs ?? procConfig.startFailureWindowMs;
    if (elapsed < window) {
      patch(id, { ...base, status: PROC_STATES.START_FAILED, ...earlyExitFailure(exitCode, signal, elapsed), exitCode });
      return;
    }

    if (exitCode === 0) {
      patch(id, { ...base, status: PROC_STATES.STOPPED, reason: null, message: '服务已自行退出（退出码 0）' });
      return;
    }
    patch(id, {
      ...base,
      status: PROC_STATES.ERROR,
      reason: 'exited_nonzero',
      message: `服务异常退出（退出码 ${exitCode ?? '未知'}）`,
    });
  }

  return { finishFailure, handleExit };
}
