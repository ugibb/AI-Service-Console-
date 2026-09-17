/**
 * Fake 进程适配器：让平台无关的状态机（procManager）可以在 macOS 上完整测试。
 *
 * 与真实适配器遵循同一契约（见 src/proc/adapter.js）：
 *   spawn({scriptPath,workDir,onStdout,onStderr,onExit}) → Promise<{pid}>
 *   killTree(pid,{force}) → Promise<{ok,notFound?}>
 *   isAlive(pid) → boolean
 *
 * 测试通过 emitStdout / exit / vanish / setBehavior 精确控制「进程」行为。
 */
export function createFakeAdapter({ firstPid = 4000 } = {}) {
  const live = new Set();
  const handlers = new Map();
  const calls = { spawn: [], killTree: [] };
  let nextPid = firstPid;
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
      if (!live.has(pid)) return { ok: true, notFound: true };
      finish(pid, 1);
      return { ok: true, notFound: false };
    },

    isAlive: (pid) => live.has(pid),

    // —— 测试驱动接口 ——
    /** 进程自行退出（可能带退出码） */
    exit: (pid, code = 0) => finish(pid, code),
    /** PID 静默消失（没有 exit 事件），用于验证 PID 存活校验的防御逻辑 */
    vanish(pid) {
      live.delete(pid);
      handlers.delete(pid);
    },
    stdout(pid, text) {
      handlers.get(pid)?.onStdout(Buffer.from(text, 'utf8'));
    },
    stderr(pid, text) {
      handlers.get(pid)?.onStderr(Buffer.from(text, 'utf8'));
    },
    liveCount: () => live.size,
    isLive: (pid) => live.has(pid),
  };

  return adapter;
}
