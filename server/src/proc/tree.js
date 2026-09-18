/**
 * 进程树的纯计算：从一份 wmic 快照里切出「以某个 pid 为根的子树的全部成员」。
 *
 * 为什么需要它（2026-09-18 真机实测教训）：
 * 控制台 spawn 一个 `.bat` 时，拿到的是 **cmd.exe 的 pid**，而真正持有服务端口的往往是
 * 它的**孙进程**（实测 `cmd.exe(30992) → python(12936)` 才是 LISTEN 的那个）。
 * 更糟的是，这个 cmd.exe 壳**会先死**——真机上抓到过控制台还活着、壳已经退出、
 * 而 python 仍在跑的场面。于是把「壳的 pid」当作跨会话的身份锚点，
 * 会在壳死掉之后彻底失效（接管接不上、无端口服务的唯一性也失去兜底）。
 *
 * 对策：spawn 之后把**整棵子树**都记进档案。对账时只要树里**任何一个**成员
 * 仍存活且创建时间精确相等，就能证明这个服务是「本控制台起的、且还在跑」。
 *
 * 纯函数：不碰进程、不碰文件，只做图遍历——好测，也好在真机上拿真实快照复核。
 */

/** 深度上限：`.bat → cmd → python → python` 这类链很短，超过这个数必是数据异常或成环 */
const MAX_DEPTH = 16;
/** 成员数上限：防「根 pid 恰好是某个系统进程」时把整机进程都收进来 */
const MAX_MEMBERS = 64;

/**
 * 收集 rootPid 的整棵子树（含根本身），按「层序」返回，每项带 depth。
 *
 * @param {Map<number, {pid:number, ppid:number, name?:string, creationDate?:string}>} snapshot
 * @param {number} rootPid
 * @returns {Array<{pid:number, ppid:number, name:string, creationDate:string, depth:number}>}
 */
export function collectSubtree(snapshot, rootPid) {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return [];
  const root = snapshot?.get?.(rootPid);
  if (!root) return [];

  const members = [toMember(root, 0)];
  const seen = new Set([rootPid]);

  // 快照是 Map，遍历一遍按 ppid 建索引（O(n) 而不是对每个成员重扫快照）
  const childrenOf = new Map();
  for (const proc of snapshot.values()) {
    if (!Number.isInteger(proc?.ppid) || proc.ppid <= 0) continue;
    const list = childrenOf.get(proc.ppid);
    if (list) list.push(proc);
    else childrenOf.set(proc.ppid, [proc]);
  }

  // 层序扩展：depth 天然等于「离壳几层」，后代顺序稳定（按 pid 升序），落盘可比对
  const queue = [{ pid: rootPid, depth: 0 }];
  while (queue.length > 0) {
    const { pid, depth } = queue.shift();
    if (depth >= MAX_DEPTH) continue;
    const children = (childrenOf.get(pid) ?? []).slice().sort((a, b) => a.pid - b.pid);
    for (const child of children) {
      // seen 挡成环（真实进程表不会成环，但防御点便宜的异常数据）
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      members.push(toMember(child, depth + 1));
      if (members.length >= MAX_MEMBERS) return members;
      queue.push({ pid: child.pid, depth: depth + 1 });
    }
  }
  return members;
}

function toMember(proc, depth) {
  return {
    pid: proc.pid,
    ppid: Number.isInteger(proc.ppid) ? proc.ppid : 0,
    name: typeof proc.name === 'string' ? proc.name : '',
    creationDate: typeof proc.creationDate === 'string' ? proc.creationDate : '',
    depth,
  };
}

/**
 * 档案里的树 × 当前快照 → 验明正身的成员（存活 **且** 创建时间精确相等）。
 *
 * 创建时间是 wmic 的 100ns 粒度原始串：pid 被系统复用不可能连创建时刻都复用，
 * 所以「字符串相等」就是可靠的身份证明（与既有单 pid 校验同一原则，只是逐成员做）。
 *
 * @returns {Array<{pid:number, ppid:number, name:string, creationDate:string, depth:number}>}
 */
export function proveMembers(tree, snapshot) {
  const proven = [];
  const seen = new Set();
  for (const member of tree ?? []) {
    if (!Number.isInteger(member?.pid) || seen.has(member.pid)) continue;
    seen.add(member.pid);
    const proc = snapshot?.get?.(member.pid);
    if (!proc) continue; // 已退出
    if (proc.creationDate !== member.creationDate) continue; // pid 被复用 → 不是我们的
    proven.push({
      pid: proc.pid,
      ppid: Number.isInteger(proc.ppid) ? proc.ppid : 0,
      name: proc.name || member.name || '',
      creationDate: proc.creationDate,
      depth: Number.isInteger(member.depth) ? member.depth : 0,
    });
  }
  return proven;
}

/**
 * 从验明正身的成员里选「代表 pid」：**深度最大的那个**。
 *
 * 代表 pid 要显示在卡片上、也决定 /T 树杀的落点。取最深的理由：
 * 壳先死的情景下，活着的恰好是后代，取最深的就是真正在提供服务的那个——
 * 用户拿这个 pid 去任务管理器核对，看到的才是他认识的那个进程。
 */
export function representativePid(proven) {
  let best = null;
  for (const member of proven ?? []) {
    if (best === null || member.depth > best.depth) best = member;
  }
  return best ? best.pid : null;
}

/** 子树的形状是否与档案里记的一致（用于「还长不长」的判定，免得不必要地反复落盘） */
export function sameTree(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  return a.every((member, index) => member.pid === b[index].pid && member.creationDate === b[index].creationDate);
}
