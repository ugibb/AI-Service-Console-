/**
 * 进程生命周期编排（T1.4，[Mac 可验（逻辑）]）。
 *
 * 本模块不碰任何平台 API，只依赖 proc/adapter.js 定义的接口，
 * 因此在 macOS 上可以用 fake adapter 跑完整状态机。
 *
 * 状态机（PRD §7.1，含启动宽限期）：
 *   stopped ──启动──▶ starting ──宽限期内一直存活──▶ running
 *                       │                             │
 *                       │spawn 失败 / 宽限期内退出      ├─退出码=0──▶ stopped
 *                       ▼                             └─退出码≠0──▶ error
 *                  start_failed
 *   running ──停止──▶ stopping ──优雅终止/超时强杀──▶ stopped
 *
 * 对 PRD §7.3「.bat 阻塞式」这一**未确认假设**的防御（本模块的关键设计，见 start.js）：
 * 启动宽限期内保持 starting；延迟复查 PID 存活；窗口内退出（含退出码 0）一律判启动失败。
 *
 * 拆分（Task D）：状态容器与各阶段逻辑按职责放到 ./lifecycle/ 下，本文件只做组装与对外 API：
 *   constants —— 状态/原因码/文案 + 纯函数（blankState / resolveProcTiming）
 *   runtime   —— 状态表与唯一写入入口 patch / clearSession / appendDiag
 *   exit      —— 子进程退出、启动失败落状态
 *   start     —— 启动、宽限期计时、存活校验
 *   stop      —— 停止、两段式树杀
 */
import { serviceNotFound } from '../lib/errors.js';
import { PROC_STATES, FAILURE_REASONS, NONBLOCKING_HINT, BUSY_STATES, RUNNING_STATES, resolveProcTiming } from './lifecycle/constants.js';
import { createRuntime, buildSnapshot } from './lifecycle/runtime.js';
import { createExitHandling } from './lifecycle/exit.js';
import { createStartOps } from './lifecycle/start.js';
import { createStopOps } from './lifecycle/stop.js';

export { PROC_STATES, FAILURE_REASONS, NONBLOCKING_HINT, resolveProcTiming };

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
  const runtime = createRuntime({ adapter, store, procConfig: config.proc, logger, now });
  const exits = createExitHandling(runtime);
  const { start } = createStartOps(runtime, exits);
  const { stop } = createStopOps(runtime);

  async function restart(id) {
    const service = store.get(id);
    if (!service) throw serviceNotFound(id);
    const current = runtime.stateOf(id);
    if (RUNNING_STATES.includes(current.status) || current.status === PROC_STATES.STOPPING) {
      await stop(id);
    }
    return start(id);
  }

  function dispose() {
    for (const [id, session] of runtime.sessions) runtime.clearSession(id, session);
    runtime.states.clear();
    runtime.stopping.clear();
  }

  return {
    platform: adapter.platform,
    /** 当前主机的适配器是否真的能启停进程（非 Windows 上为 false） */
    isSupported: () => adapter.isSupported?.() !== false,
    getState: (id) => ({ ...runtime.stateOf(id) }),
    /** 供列表接口合并运行时状态：覆盖 store 里的每个服务，未运行过的一律 stopped */
    snapshot: () => buildSnapshot(runtime),
    isBusy: (id) => BUSY_STATES.includes(runtime.stateOf(id).status),
    onStateChange(listener) {
      runtime.listeners.add(listener);
      return () => runtime.listeners.delete(listener);
    },
    start,
    stop,
    restart,
    /** 进程退出/控制台关闭时清理定时器 */
    dispose,
  };
}
