/**
 * 启动前清理：保证「点下启动后，系统里只有一个实例在跑」。
 *
 * 「启动」按钮的语义不是「再起一个」，而是「确保有一个」——因此 spawn 之前先把
 * 两类占用者清掉：
 *   1. **档案里的旧 pid**：控制台异常退出（被杀/断电）时，终态清理没来得及跑，
 *      档案里残留着上个会话的 pid。状态机显示已停止，进程却还活着。
 *   2. **占用服务声明端口的进程**：用户的明确选择——端口写在服务配置里，就是声明
 *      「这个端口属于这个服务」，占用者一律清掉（不管是控制台起的还是手工起的）。
 *
 * 两类占用者都要过身份这道门（pid 复用防护），但门的高度不同：
 * - 档案 pid：创建时间**精确相等**才杀（它是我们记的，标准可以最严）；
 * - 端口占用者：不问出身（用户已选）。但有绝对红线——**绝不杀控制台自己及其祖先链**
 *   （服务端口配成控制台端口这类错误配置，后果不能是控制台自杀）。
 */
import { proveMembers } from '../../proc/tree.js';
import { sleep } from './constants.js';

/** 控制台自己 + 沿 ppid 向上的整条祖先链（杀任何一个都会连带杀死控制台） */
function protectedChain(snapshot, selfPid) {
  const chain = new Set([selfPid]);
  let cursor = selfPid;
  // 快照缺失时只保底自己；快照越全，保护的链越长。设个上限防环形引用。
  for (let hops = 0; hops < 32; hops += 1) {
    const info = snapshot.get(cursor);
    if (!info || !Number.isInteger(info.ppid) || info.ppid <= 0) break;
    chain.add(info.ppid);
    cursor = info.ppid;
  }
  return chain;
}

/** 轮询等 pid 消失（清理场景没有 exit 事件，只能问操作系统） */
async function waitForPidGone(runtime, pid, timeoutMs) {
  const deadline = runtime.now() + timeoutMs;
  while (runtime.now() < deadline) {
    if (!runtime.adapter.isAlive(pid)) return true;
    await sleep(runtime.procConfig.exitPollIntervalMs);
  }
  return !runtime.adapter.isAlive(pid);
}

/**
 * 与 stop.js 同一套两段式：优雅 → 超时强杀。区别是不动状态机，只对「外部 pid」动手。
 *
 * ⚠️ 优雅失败**不是**终点（与 stop.js 同一条政策，2026-09-18 真机实测）：
 * `taskkill /PID N /T` 对 python 这类没有窗口消息循环的进程直接退出码 255、
 * 文案「只能强制终止此进程(带 /F 选项)」——**正因为它杀不掉，才更要走到 /F**。
 * 这里若直接放弃，用户选的「占着端口就杀」就落空了：启动被否，占用者原样活着还在占端口，
 * 而卡片只丢给用户一句「请手动处理该进程后重试」。强杀再失败才是真的杀不掉（红线 2）。
 */
async function terminatePid(runtime, pid) {
  const graceful = await runtime.adapter.killTree(pid, { force: false });
  // notFound 也走这条：进程已不在，waitForPidGone 立刻为真
  if (graceful.ok && (await waitForPidGone(runtime, pid, runtime.procConfig.stopGraceTimeoutMs))) return true;
  runtime.logger.warn?.(
    graceful.ok
      ? `启动前清理：pid=${pid} 优雅终止超时，改用 taskkill /T /F 强杀`
      : `启动前清理：pid=${pid} 优雅终止失败（${graceful.message ?? 'taskkill 执行异常'}），改用 taskkill /T /F 强杀`,
  );
  const forced = await runtime.adapter.killTree(pid, { force: true });
  if (!forced.ok) return false;
  return waitForPidGone(runtime, pid, runtime.procConfig.stopGraceTimeoutMs);
}

export function createCleanupOps(runtime, runtimeStore) {
  /**
   * 清掉「不属于当前会话」的占用者。当前会话的活进程由调用方先走完整的 stop 流程
   * （两段式树杀 + 状态消息 + 档案清理都在那边），这里只收尾漏网的。
   *
   * @returns {Promise<{ ok: boolean, killed: Array<{pid:number,name:string,source:string}>, message?: string }>}
   */
  async function clearForeign(service, current) {
    // 探测方法缺失（自定义/旧版适配器）时按「拿不到快照」处理：清理降级，启动不因此失败
    const snapshot = (await runtime.adapter.listProcesses?.()) ?? new Map();
    const chain = protectedChain(snapshot, process.pid);
    /** @type {Map<number, {name:string, source:string}>} */
    const targets = new Map();
    let recycledNote = null;

    // 1) 档案残留：上个会话留下的进程（身份校验从严——创建时间对不上的一律不杀并留话）
    //
    // 清的是**整棵树里验明正身的每一个成员**，不是只有壳：真机实测壳会先死、后代还在跑
    // （见 proc/tree.js）。只杀壳的话，这次「确保只有一个实例」就是一句空话——
    // 老进程的后代还占着端口，spawn 出来的新实例根本起不来。
    const entry = runtimeStore.get(service.id);
    if (entry) {
      const proven = proveMembers(entry.tree, snapshot).filter((member) => member.pid !== current.pid);
      for (const member of proven) {
        targets.set(member.pid, { name: member.name || `pid ${member.pid}`, source: '上次会话' });
      }
      // 一个都没验上，但壳的 pid 确实活着 → 那是被系统复用给了无关进程，留话但不杀
      if (proven.length === 0 && Number.isInteger(entry.pid) && entry.pid !== current.pid && runtime.adapter.isAlive(entry.pid)) {
        recycledNote = `档案中的 PID ${entry.pid} 已被其他进程复用，已跳过（不会杀无关进程）`;
        runtime.logger.warn?.(`[${service.name}] ${recycledNote}`);
      }
    }

    // 2) 端口占用者：不问出身，但绝不动控制台自己的进程链
    if (Number.isInteger(service.port)) {
      for (const pid of (await runtime.adapter.portOwners?.(service.port)) ?? []) {
        if (chain.has(pid)) {
          return {
            ok: false,
            killed: [],
            message:
              `端口 ${service.port} 被控制台自身的进程（pid=${pid}）占用——` + `这通常是把服务端口配成了控制台端口，请修改服务配置后重试。`,
          };
        }
        if (targets.has(pid) || !runtime.adapter.isAlive(pid)) continue;
        const info = snapshot.get(pid);
        targets.set(pid, { name: info?.name || `pid ${pid}`, source: '端口占用' });
      }
    }

    const killed = [];
    for (const [pid, meta] of targets) {
      const dead = await terminatePid(runtime, pid);
      if (!dead) {
        return {
          ok: false,
          killed,
          message:
            `启动前清理失败：无法结束${meta.source === '端口占用' ? `占用端口 ${service.port} 的` : '上一次启动的'}进程 ` +
            `${meta.name}（pid=${pid}）。已中止启动，请手动处理该进程后重试。`,
        };
      }
      killed.push({ pid, name: meta.name, source: meta.source });
      runtime.logger.info?.(`[${service.name}] 启动前清理：已结束 ${meta.name}（pid=${pid}，${meta.source}）`);
    }

    if (entry) await runtimeStore.remove(service.id).catch(() => {});
    if (recycledNote) runtime.patch(service.id, { message: recycledNote });
    return { ok: true, killed };
  }

  return { clearForeign };
}
