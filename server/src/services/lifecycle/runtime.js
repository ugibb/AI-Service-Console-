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
    patch,
    clearSession,
    appendDiag,
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
