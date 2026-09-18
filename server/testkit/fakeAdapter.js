/**
 * Fake 进程适配器：让平台无关的状态机（procManager）可以在 macOS 上完整测试。
 *
 * 与真实适配器遵循同一契约（见 src/proc/adapter.js）：
 *   spawn({scriptPath,workDir,onStdout,onStderr,onExit}) → Promise<{pid}>
 *   killTree(pid,{force}) → Promise<{ok,notFound?}>
 *   isAlive(pid) → boolean
 *   listProcesses() → Promise<Map<pid,{pid,ppid,name,creationDate}>>
 *   portOwners(port) → Promise<number[]>
 *
 * 测试通过 emitStdout / exit / vanish / setBehavior 精确控制「进程」行为；
 * 通过 seedProcess / seedPortOwner 模拟「控制台重启前留下的旧进程」「占用端口的无关进程」
 * ——这两类不是本次 spawn 出来的，因此必须有独立的注入入口。
 */
export function createFakeAdapter({ firstPid = 4000 } = {}) {
  const live = new Set();
  const handlers = new Map();
  /** 控制台本会话 spawn 出来的进程（pid → OS 信息，creationDate 单调递增保证互不相同） */
  const created = new Map();
  /** 外部进程（上个会话遗留 / 用户手工起的）：pid → OS 信息。与 created 分开存，
   *  是因为它们的 pid 由测试指定，且没有 onExit 回调——被杀时静默消失。 */
  const seeded = new Map();
  /** 端口 → 监听该端口的 pid 集合（模拟 netstat 的答案） */
  const portOwnerMap = new Map();
  const calls = { spawn: [], killTree: [], listProcesses: [], portOwners: [] };
  let nextPid = firstPid;
  let creationSeq = 0;
  let behavior = {
    spawnError: null,
    /** spawn 前等待的毫秒数：用于把服务稳定停在 starting 状态 */
    spawnDelayMs: 0,
    /** spawn 后立刻自行退出：{ code, delayMs } —— 模拟「启动即退出」型 .bat */
    exitAfterSpawn: null,
    /** 忽略优雅终止（taskkill /T 不带 /F 无效） */
    ignoreGracefulKill: false,
    /** 忽略强杀（进程杀不掉） */
    ignoreForceKill: false,
    /** taskkill 自身失败：{ appliesTo: 'graceful'|'force'|'both', message? } */
    killFailure: null,
  };

  /** 与 wmic 的 CreationDate 同构：字符串相等 = 同一个进程。每分配一次自增，绝不重复。 */
  function nextCreationDate() {
    const value = `20260101000000.${String(creationSeq).padStart(6, '0')}+480`;
    creationSeq += 1;
    return value;
  }

  function finish(pid, code, signal = null) {
    live.delete(pid);
    const handler = handlers.get(pid);
    handlers.delete(pid);
    handler?.onExit({ code, signal });
  }

  const adapter = {
    platform: 'fake',
    isSupported: () => true,
    calls,

    setBehavior(patch) {
      behavior = { ...behavior, ...patch };
    },

    async spawn({ scriptPath, workDir, onStdout, onStderr, onExit }) {
      // 回调一并留存，便于测试模拟「迟到的过期事件」
      calls.spawn.push({ scriptPath, workDir, onStdout, onStderr, onExit });
      if (behavior.spawnDelayMs > 0) {
        await new Promise((resolve) => {
          setTimeout(resolve, behavior.spawnDelayMs);
        });
      }
      if (behavior.spawnError) throw behavior.spawnError;

      const pid = nextPid;
      nextPid += 1;
      live.add(pid);
      handlers.set(pid, { onExit, onStdout, onStderr });
      created.set(pid, { pid, ppid: process.pid, name: 'cmd.exe', creationDate: nextCreationDate() });

      if (behavior.exitAfterSpawn) {
        const { code = 0, delayMs = 0 } = behavior.exitAfterSpawn;
        setTimeout(() => finish(pid, code), delayMs);
      }
      return { pid };
    },

    async killTree(pid, { force = false } = {}) {
      calls.killTree.push({ pid, force });
      const failure = behavior.killFailure;
      if (failure && (failure.appliesTo === 'both' || failure.appliesTo === (force ? 'force' : 'graceful'))) {
        return { ok: false, notFound: false, message: failure.message ?? 'taskkill 执行失败' };
      }
      if (force && behavior.ignoreForceKill) return { ok: true, notFound: false };
      if (!force && behavior.ignoreGracefulKill) return { ok: true, notFound: false };
      if (seeded.has(pid)) {
        // 外部进程：没有 exit 回调，直接消失（真实世界里 taskkill /T 也不给我们回调）
        live.delete(pid);
        seeded.delete(pid);
        created.delete(pid);
        return { ok: true, notFound: false };
      }
      if (!live.has(pid)) return { ok: true, notFound: true };
      finish(pid, 1);
      return { ok: true, notFound: false };
    },

    isAlive: (pid) => live.has(pid),

    async listProcesses() {
      calls.listProcesses.push({});
      const snapshot = new Map();
      for (const info of created.values()) if (live.has(info.pid)) snapshot.set(info.pid, { ...info });
      for (const info of seeded.values()) if (live.has(info.pid)) snapshot.set(info.pid, { ...info });
      return snapshot;
    },

    async portOwners(port) {
      calls.portOwners.push({ port });
      const owners = portOwnerMap.get(port) ?? new Set();
      return [...owners].filter((pid) => live.has(pid));
    },

    // —— 测试驱动接口 ——
    /** 进程自行退出（可能带退出码） */
    exit: (pid, code = 0) => finish(pid, code),
    /** PID 静默消失（没有 exit 事件），用于验证 PID 存活校验的防御逻辑 */
    vanish(pid) {
      live.delete(pid);
      handlers.delete(pid);
      seeded.delete(pid);
      created.delete(pid);
    },
    stdout(pid, text) {
      handlers.get(pid)?.onStdout(Buffer.from(text, 'utf8'));
    },
    stderr(pid, text) {
      handlers.get(pid)?.onStderr(Buffer.from(text, 'utf8'));
    },
    liveCount: () => live.size,
    isLive: (pid) => live.has(pid),

    /**
     * 注入一个「本会话没 spawn 过」的活进程（上个控制台会话留下的、或用户手工起的）。
     * @returns {{ pid, ppid, name, creationDate }} 注入的进程信息（creationDate 可用于伪造 pid 复用）
     */
    seedProcess(pid, { ppid = 0, name = 'seeded.exe', creationDate = null } = {}) {
      const info = { pid, ppid, name, creationDate: creationDate ?? nextCreationDate() };
      live.add(pid);
      seeded.set(pid, info);
      return info;
    },
    /**
     * 给某个进程挂一个子进程——模拟 `.bat` 壳拉起的后代（真机上真正的服务进程）。
     *
     * 后代走 seeded 那条路（没有 onExit 回调、被 taskkill 时静默消失），因为真机上
     * `taskkill /T` 杀掉壳时也不会替我们给孙进程发退出事件；而**壳死了后代还活着**
     * 恰恰是要复现的那个场景（见 proc/tree.js）。
     *
     * @returns {{ pid, ppid, name, creationDate }} 子进程的 OS 信息
     */
    seedChild(parentPid, { pid = null, name = 'python.exe' } = {}) {
      const childPid = pid ?? nextPid;
      if (pid === null) nextPid += 1;
      const info = { pid: childPid, ppid: parentPid, name, creationDate: nextCreationDate() };
      live.add(childPid);
      seeded.set(childPid, info);
      return info;
    },
    /** 声明「pid 正在监听 port」（配合 seedProcess 使用） */
    seedPortOwner(port, pid) {
      if (!portOwnerMap.has(port)) portOwnerMap.set(port, new Set());
      portOwnerMap.get(port).add(pid);
    },
  };

  return adapter;
}
