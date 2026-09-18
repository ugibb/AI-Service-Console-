/**
 * 生命周期运行时容器（从 procManager.js 拆出，Task D）。
 *
 * 持有所有可变状态（对外状态表、内部会话表、进行中的停止操作、状态监听器），
 * 并提供唯一的写入入口 `patch`——状态只在真正变化（status 变）时通知监听器，
 * 其余字段更新（pid/诊断/文案）静默进行，避免回调噪音。
 */
import { blankState } from './constants.js';

export function createRuntime({ adapter, store, procConfig, logger, now }) {
  /** @type {Map<string, object>} 对外可见的运行时状态（不持久化，PRD §9） */
  const states = new Map();
  /** @type {Map<string, object>} 内部会话：定时器、spawn promise、诊断缓冲等 */
  const sessions = new Map();
  /** @type {Map<string, Promise>} 进行中的停止操作，避免重复点击产生并发杀进程 */
  const stopping = new Map();
  const listeners = new Set();
  /**
   * @type {Map<string, number[]>} adopted 状态下**验明正身**的全部 pid（壳 + 活着的后代）。
   *
   * 为什么不放在对外状态里：状态对象会原样进 /api/services 的响应，多一个字段就是多一处
   * 需要前端忽略的噪音；而这份数据只服务两个内部用途——停止时「要杀掉哪些 pid」、
   * 存活轮询时「盯哪些 pid」。
   *
   * 为什么不能只有 state.pid：真机实测（2026-09-18）壳会先死而 python 后代还活着，
   * 那时 state.pid（=代表 pid）或许还在，但**其余成员同样在占端口**，
   * 只盯一个、只杀一个都会漏。
   */
  const adoptPids = new Map();

  /** 全局单调递增的代数号：dispose 清空状态表也不复位。
   *  代数一旦复用，旧会话残留的迟到回调（如 killTree 触发的 onExit）就能冒充当代
   *  骗过各处的过期守卫——「模拟控制台重启」的 dispose 复用场景恰好会踩中。 */
  let generationSeq = 0;
  const nextGeneration = () => {
    generationSeq += 1;
    return generationSeq;
  };

  const stateOf = (id) => states.get(id) ?? blankState();

  function notify(id, state) {
    for (const listener of listeners) {
      try {
        listener(id, state);
      } catch (err) {
        logger.error?.(`状态回调异常：${err.message}`);
      }
    }
  }

  function patch(id, changes) {
    const previous = stateOf(id);
    const next = { ...previous, ...changes };
    states.set(id, next);
    // 只在状态真正变化时回调（statusMessage / diag 更新不触发，避免噪音）
    if (previous.status !== next.status) notify(id, next);
    return next;
  }

  function clearSession(id, session) {
    if (!session) return;
    for (const timer of session.timers) clearTimeout(timer);
    session.timers.clear();
    if (sessions.get(id) === session) sessions.delete(id);
  }

  /** 启动窗口内收集诊断输出；过期一代或已固化的会话直接丢弃 */
  function appendDiag(id, session, chunk) {
    if (session.generation !== stateOf(id).generation) return;
    if (session.diagFrozen) return;
    session.diagBuffer.push(chunk);
  }

  return {
    adapter,
    store,
    procConfig,
    logger,
    now,
    states,
    sessions,
    stopping,
    listeners,
    stateOf,
    nextGeneration,
    patch,
    clearSession,
    appendDiag,
    /** 记下这次接管认领的全部 pid（必须在 patch(ADOPTED) **之前**调用，监听器要靠它起轮询） */
    setAdoptPids(id, pids) {
      const unique = [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))];
      if (unique.length > 0) adoptPids.set(id, unique);
      else adoptPids.delete(id);
    },
    adoptPidsOf: (id) => adoptPids.get(id) ?? [],
    clearAdoptPids: (id) => adoptPids.delete(id),
  };
}

/** 列表合并用快照：覆盖 store 里每个服务（未运行过的为 stopped），再补上纯运行时的条目 */
export function buildSnapshot(runtime) {
  const result = {};
  for (const service of runtime.store.list()) {
    result[service.id] = { ...blankState(), ...(runtime.states.get(service.id) ?? {}) };
  }
  for (const [id, value] of runtime.states) {
    if (!(id in result)) result[id] = { ...value };
  }
  return result;
}
