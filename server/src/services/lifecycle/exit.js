/**
 * 子进程退出 / 启动失败的处理（从 procManager.js 拆出，Task D）。
 *
 * 这里集中回答一个问题：**进程没了，该把状态定成什么、给用户什么话**。
 * 三种走向——主动停止（stopping）、启动窗口内退出（start_failed）、窗口后异常退出（stopped / error）。
 */
import { representativePid } from '../../proc/tree.js';
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

  /** 落终态：启动窗口内退出 → start_failed；窗口后退出 → stopped（码 0）/ error（码非 0） */
  function settleTerminal(id, session, current, base, { exitCode, signal }) {
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

  /**
   * 壳退了，但档案里记的后代还在跑 → 服务本体仍在运行，转「已接管」而不是判失败。
   *
   * 这是 2026-09-18 真机实测倒逼出来的一条分支。现场那只 `start-calibre-web.bat`：
   * cmd.exe 壳先退出（退出码 1），它拉起的 python 继续监听 8083 几个小时。
   * 老逻辑此时判 `start_failed` / `error`，一下丢掉两样东西：
   *   1. 卡片与现实相反——服务在跑，界面说它异常退出；
   *   2. **唯一性兜底**——终态监听器顺手清掉接管档案，而没配端口的服务又没有端口那道网，
   *      此时再点「启动」就是起第二个实例，正好是用户最担心的那件事。
   *
   * 判定完全交给档案里的整棵子树（存活 + 创建时间精确相等），没有把握就退回老逻辑——
   * 宁可显示失败，也不凭空认领一个不属于本控制台的进程。
   */
  async function confirmAdoption(id, session, base, { code, signal, exitCode }) {
    let proven = [];
    try {
      // 二次核验要连创建时间一起比，只能扫一次 wmic 快照（异步）
      proven = (await runtime.provenMembers?.(id)) ?? [];
    } catch (err) {
      runtime.logger.warn?.(`壳退出后核对子树失败：${err.message}`);
    }

    // 过期守卫：取快照期间用户可能已经点了停止/重启，或新一代已经起来
    const current = stateOf(id);
    if (session.generation !== current.generation) return;
    if (current.status !== PROC_STATES.STARTING && current.status !== PROC_STATES.RUNNING) return;

    if (proven.length === 0) {
      // 刚才那个「还活着」的 pid 经不起创建时间的核验（多半是 pid 复用或刚好退干净了）
      settleTerminal(id, session, current, base, { code, signal, exitCode });
      return;
    }

    const pid = representativePid(proven);
    const anchor = proven.find((member) => member.pid === pid);
    const message =
      `启动壳已退出（退出码 ${exitCode ?? '未知'}），但其子进程仍在运行，已接管` +
      `（pid=${pid}${anchor?.name ? `，${anchor.name}` : ''}，共 ${proven.length} 个存活成员）。`;
    runtime.logger.info?.(`[${id}] ${message}`);
    runtime.setAdoptPids(
      id,
      proven.map((member) => member.pid),
    );
    patch(id, {
      status: PROC_STATES.ADOPTED,
      pid,
      exitCode: null,
      exitedAt: null,
      forcedKill: false,
      reason: null,
      diag: base.diag,
      message,
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

    // 判终态前先问一句：壳没了，服务本体是不是还在？
    //
    // 这一问必须**同步**（isAlive 是 process.kill(pid,0)，0ms）——终态是同步落下的，
    // 不能为了这个增强把「退出→状态」这条路径整体改成异步：调用方（stop 的 waitForExit、
    // 各类测试）都依赖「退出事件到达时状态已经定下」。
    // 真有一个还活着，再异步做一次带创建时间核验的确认（confirmAdoption）。
    if (runtime.aliveArchivePids?.(id, current.pid).length > 0) {
      void confirmAdoption(id, session, base, { code, signal, exitCode });
      return;
    }
    settleTerminal(id, session, current, base, { code, signal, exitCode });
  }

  return { finishFailure, handleExit };
}
