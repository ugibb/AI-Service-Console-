/**
 * 控制台重启后的「接管」：验明正身，把上个会话启动、且仍在跑的服务重新纳入管理。
 *
 * 正身的证明链（缺一环就放弃接管，宁可显示已停止也不认领别人的进程）：
 *   1. 档案里有记录（整棵子树，每个成员带 OS 创建时间）——说明这些进程是
 *      **本控制台**（同端口档）启动的；
 *   2. 树里**至少一个**成员仍存活（isAlive）；
 *   3. 该成员的 OS 创建时间与档案**精确相等**——pid 在停机间隙被系统复用过的，一定对不上。
 *
 * ⚠️ 「至少一个成员」而不是「根 pid」是本模块在 2026-09-18 真机实测后改的核心一处：
 * 控制台 spawn 到的壳（cmd.exe）**会先死**，真正持有服务端口的是它的后代。壳死了就
 * 整条记录作废，等于把「控制台重启后接管」这件事在最需要它的场景下关掉。
 *
 * 接管后的进程不是当前进程的子进程，没有 exit 事件——进程死了不会有人告诉我们。
 * 所以对 adopted 状态做低频存活轮询，且**盯全部验明正身的 pid**：任何一个还活着
 * 就仍算在跑，全死了才落回 stopped（不能反向撒谎说它还在跑）。
 */
import { proveMembers, representativePid } from '../../proc/tree.js';
import { PROC_STATES } from './constants.js';

export function createAdoptOps(runtime, runtimeStore) {
  /** @type {Map<string, NodeJS.Timeout>} 接管进程的存活轮询定时器 */
  const watchers = new Map();

  function stopWatcher(id) {
    const timer = watchers.get(id);
    if (timer === undefined) return;
    clearInterval(timer);
    watchers.delete(id);
  }

  /**
   * 守望一组 pid：**全部**消失才算服务退出。
   *
   * 只盯代表 pid 是不够的：壳先死、后代还活着的时候，代表 pid 恰好还活着（它是后代），
   * 但反过来——后代被单独杀掉而壳还在——也不该立刻宣布「服务已退出」。
   * 判定标准定成「验明正身的成员一个不剩」，两个方向都不撒谎。
   */
  function watchAdopted(id, pids) {
    stopWatcher(id);
    if (pids.length === 0) return;
    const timer = setInterval(async () => {
      // 状态已经不是 adopted（被停止/重启/新一轮启动取代）→ 轮询使命结束
      const current = runtime.stateOf(id);
      if (current.status !== PROC_STATES.ADOPTED) {
        stopWatcher(id);
        return;
      }
      // 用 isAlive 而不是 wmic 快照：轮询每 5s 一次，不值得为每次判定付一次全量进程扫描。
      // pid 复用在这里构不成风险——认领那一刻已经验过创建时间，而同一个控制台会话内
      // 我们自己不会把服务的 pid 让出去（真丢了进程，isAlive 会是 false）。
      if (pids.some((pid) => runtime.adapter.isAlive(pid))) return;
      stopWatcher(id);
      runtime.clearAdoptPids?.(id);
      runtime.patch(id, {
        status: PROC_STATES.STOPPED,
        pid: null,
        exitedAt: runtime.now(),
        message: `接管的进程已退出（pid=${pids.join('、')}）`,
      });
      await runtimeStore.remove(id).catch((err) => runtime.logger.warn?.(`清理接管档案失败：${err.message}`));
    }, runtime.procConfig.adoptedPollIntervalMs);
    // 只读探测的定时器不应阻止进程退出
    timer.unref?.();
    watchers.set(id, timer);
  }

  return {
    /**
     * 启动时对账：遍历运行时档案，逐条决定「接管 / 丢弃」。
     * 必须在开始对外服务前调用（bootstrap），保证首个列表接口给出的就是真实状态。
     */
    async reconcile() {
      for (const [id, entry] of runtimeStore.list()) {
        const service = runtime.store.get(id);
        if (!service) {
          // 台账里已删掉的服务，档案记录没有存在意义（进程也早在删除守卫下停过了）
          await runtimeStore.remove(id);
          continue;
        }

        const snapshot = (await runtime.adapter.listProcesses?.()) ?? new Map();
        const proven = proveMembers(entry.tree, snapshot);
        const pid = representativePid(proven);

        if (pid === null) {
          // 没有一个成员活着（或创建时间全对不上）。这里只区分「壳的 pid 被别人占了」
          // 这一种要留话的情况——其余一律安静清掉，不打扰用户。
          const rootAlive = runtime.adapter.isAlive(entry.pid);
          const rootProc = snapshot.get(entry.pid);
          await runtimeStore.remove(id);
          if (rootAlive && rootProc && rootProc.creationDate !== entry.creationDate) {
            // pid 活着但创建时间对不上 = pid 已被系统复用，现在占着这个 pid 的是无关进程。
            // 绝不能认领；丢弃档案并在卡片上留一句话（statusMessage 通道）。
            runtime.logger.warn?.(`[${service.name}] 档案进程 ${entry.pid} 的创建时间对不上（pid 已被复用），丢弃接管记录`);
            runtime.patch(id, {
              status: PROC_STATES.STOPPED,
              pid: null,
              message: `上次记录的 PID ${entry.pid} 已被其他进程复用，接管记录已丢弃。若该服务确在运行，点「启动」会清理后重启。`,
            });
          } else {
            // 控制台停机期间进程自己退了：正常情况，安静地清掉记录即可
            runtime.logger.info?.(`[${service.name}] 档案里的进程已全部不存在（记录了 ${entry.tree.length} 个），不接管`);
          }
          continue;
        }

        const anchor = proven.find((member) => member.pid === pid);
        const shellGone = !proven.some((member) => member.pid === entry.pid);
        runtime.logger.info?.(
          `[${service.name}] 已接管重启前的进程：代表 pid=${pid}（${anchor?.name || '未知'}，` +
            `验明正身 ${proven.length}/${entry.tree.length} 个成员${shellGone ? '，启动壳已退出' : ''}）`,
        );
        // 认领清单必须**先**落进 runtime，再 patch(ADOPTED)：patch 会触发状态监听器，
        // 监听器靠这份清单起存活轮询（见下方 onStateChange）
        runtime.setAdoptPids(
          id,
          proven.map((member) => member.pid),
        );
        runtime.patch(id, {
          status: PROC_STATES.ADOPTED,
          pid,
          exitCode: null,
          // 档案里是 ISO 串，内存里的约定是 epoch 毫秒（见 procManager.persistPid）
          startedAt: entry.startedAt ? Date.parse(entry.startedAt) : null,
          exitedAt: null,
          forcedKill: false,
          reason: null,
          message:
            `控制台重启前已启动，已接管（pid=${pid}${anchor?.name ? `，${anchor.name}` : ''}）` +
            (shellGone ? `。原启动壳（pid=${entry.pid}）已退出，服务本体仍在运行。` : ''),
        });
      }
    },

    /**
     * 状态变化时管好存活轮询（由 procManager 在状态变化时调用）。
     *
     * 进入 adopted 也要在这里起轮询——本控制台运行期间也会进入 adopted：
     * 壳退出而后代仍存活时，exit.js 会把状态判成「已接管」而不是「启动失败」。
     * 两个入口（启动时对账 / 运行中壳退出）都落到这一个开关上。
     */
    onStateChange(id, state) {
      if (state.status !== PROC_STATES.ADOPTED) {
        stopWatcher(id);
        return;
      }
      const pids = runtime.adoptPidsOf(id);
      watchAdopted(id, pids.length > 0 ? pids : Number.isInteger(state.pid) ? [state.pid] : []);
    },

    dispose() {
      for (const timer of watchers.values()) clearInterval(timer);
      watchers.clear();
    },
  };
}
