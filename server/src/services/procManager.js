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
 *   adopted = 不再是「当前 spawn 出来的那个壳」、但服务本体仍在跑的进程。两个来源：
 *   ① 控制台重启后接管上个会话启动的进程；② 运行期间壳先退出、后代还在跑（见 exit.js）。
 *   stop/start/restart 与 running 同权；因为都不是当前进程的子进程，没有 exit 事件，
 *   靠 adopt.js 的存活轮询感知退出。
 *
 * 「启动」的语义是「确保只有一个实例在跑」：running/adopted 下点启动 = 先停再起，
 * 且 spawn 前会清掉档案残留的**整棵子树**与端口占用者（见 start.js / cleanup.js）。
 * 「停止」同样按档案里验明正身的**全部**成员来杀，不是只杀一个 pid（见 stop.js）——
 * 这两个字面上很轻的改动，是 2026-09-18 现场教训的核心：壳会先死，后代才是真正的服务。
 *
 * 对 PRD §7.3「.bat 阻塞式」这一**未确认假设**的防御（本模块的关键设计，见 start.js）：
 * 启动宽限期内保持 starting；延迟复查 PID 存活；窗口内退出（含退出码 0）一律判启动失败
 * ——除非档案能证明后代还活着，那时转 adopted 而不是判失败（见 exit.js）。
 *
 * 拆分（Task D）：状态容器与各阶段逻辑按职责放到 ./lifecycle/ 下，本文件只做组装与对外 API：
 *   constants —— 状态/原因码/文案 + 纯函数（blankState / resolveProcTiming）
 *   runtime   —— 状态表与唯一写入入口 patch / clearSession / appendDiag
 *   ../proc/tree —— 进程树纯计算（收集 / 验明正身 / 选代表）
 *   exit      —— 子进程退出、启动失败落状态、壳死后代仍在的接管
 *   start     —— 启动、宽限期计时、存活校验、子树补记
 *   stop      —— 停止、两段式树杀（对准全部验明正身的成员）
 *   adopt     —— 重启后接管（档案对账 + 接管进程存活轮询）
 *   cleanup   —— 启动前清理（档案残留的整棵树 + 端口占用者）
 */
import { serviceNotFound } from '../lib/errors.js';
import { collectSubtree, proveMembers, sameTree } from '../proc/tree.js';
import { PROC_STATES, FAILURE_REASONS, NONBLOCKING_HINT, BUSY_STATES, RUNNING_STATES, resolveProcTiming } from './lifecycle/constants.js';
import { createRuntime, buildSnapshot } from './lifecycle/runtime.js';
import { createExitHandling } from './lifecycle/exit.js';
import { createStartOps } from './lifecycle/start.js';
import { createStopOps } from './lifecycle/stop.js';
import { createAdoptOps } from './lifecycle/adopt.js';
import { createCleanupOps } from './lifecycle/cleanup.js';

export { PROC_STATES, FAILURE_REASONS, NONBLOCKING_HINT, resolveProcTiming };

/** 这些状态下档案必须保留（pid 还活着）；除此之外的任何状态变化都意味着进程没了 */
const PERSISTED_ALIVE_STATES = [PROC_STATES.STARTING, PROC_STATES.RUNNING, PROC_STATES.STOPPING, PROC_STATES.ADOPTED];

/**
 * @param {{
 *   adapter: { spawn: Function, killTree: Function, isAlive: Function, platform?: string },
 *   store: { get: Function, list: Function },
 *   config: { proc: object },
 *   runtimeStore?: { get: Function, set: Function, remove: Function, list: Function } | null,
 *   logger?: object,
 *   now?: () => number,
 * }} options
 */
export function createProcManager({ adapter, store, config, runtimeStore = null, logger = console, now = Date.now }) {
  const runtime = createRuntime({ adapter, store, procConfig: config.proc, logger, now });
  const exits = createExitHandling(runtime);
  const adoptOps = createAdoptOps(
    runtime,
    runtimeStore ?? { list: () => [], get: () => null, set: async () => {}, remove: async () => {} },
  );
  const { clearForeign } = createCleanupOps(runtime, runtimeStore ?? { get: () => null, remove: async () => {} });
  const { stop } = createStopOps(runtime);
  // 「running/adopted 下点启动 = 先停再起」不依赖档案（runtimeStore 为空时也要成立）；
  // 依赖档案的只有启动前清理（runtime.cleanup，见下）
  const { start } = createStartOps(runtime, exits, { stop });

  if (runtimeStore) {
    /**
     * 写接管档案：壳 + 整棵子树，每个成员都带 OS 创建时间。
     *
     * 「整棵子树」是 2026-09-18 现场教训的直接产物：真正持有服务端口的是壳的孙进程，
     * 而壳本身会先死（现场抓到过控制台活着、cmd.exe 已退出、python 仍在监听 8083）。
     * 只记壳的档案在那时就等于废纸。见 proc/tree.js 与 db/runtimeStore.js 的注释。
     *
     * @returns {Promise<Array|null>} 落盘的树（失败或不该写时返回 null）
     */
    runtime.persistPid = async (id, pid) => {
      try {
        const snapshot = await runtime.adapter.listProcesses();
        const tree = collectSubtree(snapshot, pid);
        if (tree.length === 0) {
          runtime.logger.warn?.(`未取得 pid=${pid} 的进程信息，本次不写接管档案`);
          return null;
        }
        const state = runtime.stateOf(id);
        // 只在「状态里已经落了一个不同的 pid」时放弃：那是更新的 spawn 已接管，别拿旧值覆盖。
        // 状态为空（pid=null，比如控制台 dispose 清了状态表）恰恰要写——进程还活着，
        // 这条档案就是控制台死后唯一能接管它的凭据。
        if (Number.isInteger(state.pid) && state.pid !== pid) return null;
        if (!runtime.adapter.isAlive(pid)) return null; // 已退出，终态监听器会清档案
        // startedAt 在内存里是 epoch 毫秒（runtime.now()），档案里存 ISO 串（与 savedAt 一致）：
        // 落盘格式给人看，内存约定不动——中间的换算只在这一处和 adopt.js 那一处
        await runtimeStore.set(id, {
          pid,
          creationDate: tree[0].creationDate,
          name: tree[0].name,
          tree,
          startedAt: Number.isFinite(state.startedAt) ? new Date(state.startedAt).toISOString() : null,
        });
        return tree;
      } catch (err) {
        // 档案写失败不影响本次启动，只损失「重启后接管」这一增强能力
        runtime.logger.warn?.(`写接管档案失败：${err.message}`);
        return null;
      }
    };

    /**
     * 补记子树：spawn 那一刻后代往往还没出生（`.bat` 要先跑 powershell、ping 延迟、再拉 python），
     * 所以启动窗口内要反复来看一眼，把新长出来的成员补进档案。
     *
     * 只在「树确实长大了」时落盘，避免每秒重写文件；返回最新的树（未变则返回原树）。
     */
    runtime.refreshTree = async (id, pid) => {
      try {
        const entry = runtimeStore.get(id);
        if (!entry) return null; // 档案已被终态监听器清掉 → 服务已结束，不必再补
        const snapshot = await runtime.adapter.listProcesses();
        const tree = collectSubtree(snapshot, pid);
        if (tree.length === 0) return entry.tree;
        if (sameTree(tree, entry.tree)) return entry.tree;
        const state = runtime.stateOf(id);
        if (Number.isInteger(state.pid) && state.pid !== pid) return entry.tree; // 已被更新的一代接管
        await runtimeStore.set(id, { ...entry, tree, pid: entry.pid, creationDate: entry.creationDate, name: entry.name });
        runtime.logger.info?.(`[${id}] 接管档案补记子树：${tree.length} 个成员`);
        return tree;
      } catch (err) {
        runtime.logger.warn?.(`补记接管档案失败：${err.message}`);
        return null;
      }
    };
    /**
     * 同步版的「档案里还有谁活着」：只用 isAlive 探（process.kill(pid,0)，0ms），**不扫 wmic**。
     *
     * 存在的理由是时序：退出事件到达时终态必须已经定下（同步），
     * 而完整核验要扫一次进程快照（异步）。所以先用它做一次廉价的「值不值得细查」，
     * 真有活口再走异步核验（见 lifecycle/exit.js 的 confirmAdoption）。
     *
     * @param {string} id
     * @param {number} [excludePid] 排除的 pid——刚拿到它的退出事件，它必定已经不在了
     */
    runtime.aliveArchivePids = (id, excludePid = null) => {
      const entry = runtimeStore.get(id);
      if (!entry) return [];
      return entry.tree.filter((member) => member.pid !== excludePid && runtime.adapter.isAlive(member.pid)).map((member) => member.pid);
    };

    /**
     * 档案里那棵树**此刻仍验明正身**的成员（存活 + 创建时间精确相等，异步核验）。
     *
     * 「只认壳」是整个接管思路最初的漏洞：真机实测壳会先死、后代还在跑，
     * 于是停止时只杀壳等于没杀（端口照样被占）、存活轮询只盯壳等于谎报已停止、
     * 启动前清理更是完全失守。这三处都从这里取名单。
     */
    runtime.provenMembers = async (id) => {
      const entry = runtimeStore.get(id);
      if (!entry) return [];
      const snapshot = (await runtime.adapter.listProcesses?.()) ?? new Map();
      return proveMembers(entry.tree, snapshot);
    };
    runtime.provenPids = async (id) => (await runtime.provenMembers(id)).map((member) => member.pid);

    runtime.cleanup = { clearForeign };

    // 终态即清档案：进程没了（stopped/error/start_failed），记录必须跟着消失，
    // 否则下次重启会拿着已死/已复用的 pid 去认领。
    // 注意只看状态不看 pid：start() 的首个 patch 是 STARTING + pid=null（清展示用的旧 pid），
    // 若把「pid 非整数」也当终态，这条 patch 会在启动前清理读到档案之前就把它删掉。
    runtime.listeners.add((id, state) => {
      adoptOps.onStateChange(id, state);
      if (PERSISTED_ALIVE_STATES.includes(state.status)) return;
      runtimeStore.remove(id).catch((err) => runtime.logger.warn?.(`清理接管档案失败：${err.message}`));
    });
  }

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
    adoptOps.dispose();
    for (const [id, session] of runtime.sessions) runtime.clearSession(id, session);
    // 认领清单属于「这个控制台会话」的运行时状态，与状态表同寿命——先取键再清表
    for (const id of runtime.states.keys()) runtime.clearAdoptPids(id);
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
    /** 启动时对账：接管上个控制台会话启动且仍在跑的进程（见 lifecycle/adopt.js） */
    reconcileAdopted: () => adoptOps.reconcile(),
    /** 进程退出/控制台关闭时清理定时器 */
    dispose,
  };
}
