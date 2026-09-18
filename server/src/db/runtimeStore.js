/**
 * 运行时进程档案（data/runtime-<port>.json）：跨控制台重启的 PID 接管记录。
 *
 * 记什么：每个服务「由本控制台启动且此刻仍活着」的**整棵进程树**——spawn 拿到的壳（cmd.exe）
 * 加上它的全部后代，每个成员都带 OS 进程创建时间。
 * 有了它，控制台重启后不再把仍在跑的服务谎报为「已停止」，而是先验明正身再接管（见 lifecycle/adopt.js）。
 *
 * **为什么记整棵树而不是只记壳**（2026-09-18 真机实测）：真正持有服务端口的是壳的**孙进程**，
 * 而壳本身**会先死**——现场抓到过控制台还在跑、壳已退出、python 仍在监听 8083 的场面。
 * 那种情况下只记壳的档案就是一张废纸：接管接不上，无端口服务的唯一性也失去兜底。
 *
 * 三条边界，都是与 services.json 刻意划开的：
 * - **不进 services.json**：台账是用户配置，启停是高频运行时数据。configStore 只在 init 读
 *   一次、每次变更整文件重写，把运行时字段混进去等于把 last-writer-wins 的风险从
 *   「偶发的配置变更」扩大到「每次启停」。
 * - **按端口分文件**：dev 与 production 共用 data/（见 profiles.js）。若两个档共用一份运行时
 *   档案，开发档控制台会认领并「停止」生产档启动的服务——一键误杀。两档端口不同
 *   （3010/3011），文件名带上端口即天然隔离；同端口的两个控制台本来就起不来（EADDRINUSE）。
 * - **身份锚点是 OS 创建时间而非 pid**：pid 会被系统复用，重启间隙里旧 pid 可能已经属于
 *   无关进程，直接认领会杀错东西。创建时间是 100ns 粒度的 wmic 原始串，精确相等才认领。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export const RUNTIME_STORE_VERSION = 2;

/** 树成员条数上限：与 proc/tree.js 的 MAX_MEMBERS 同量级，防止损坏文件撑爆内存 */
const MAX_TREE_MEMBERS = 64;

/** 校验并规范化一个树成员；不合法返回 null（成员级丢弃，不连累整条记录） */
function normalizeMember(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!Number.isInteger(raw.pid) || raw.pid <= 0) return null;
  if (typeof raw.creationDate !== 'string' || raw.creationDate.length === 0) return null;
  return {
    pid: raw.pid,
    ppid: Number.isInteger(raw.ppid) ? raw.ppid : 0,
    name: typeof raw.name === 'string' ? raw.name : '',
    creationDate: raw.creationDate,
    depth: Number.isInteger(raw.depth) && raw.depth >= 0 ? raw.depth : 0,
  };
}

/** 档案里一条有效的记录必须长这样；不满足的条目在加载时丢弃 */
function normalizeEntry(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!Number.isInteger(raw.pid) || raw.pid <= 0) return null;
  if (typeof raw.creationDate !== 'string' || raw.creationDate.length === 0) return null;

  // v1 档案只有单个 pid（没有 tree）——读进来时退化成「只记了壳」的树，接管逻辑照跑，
  // 只是壳一旦死了就接不上。**不主动改写旧文件**：下次 spawn 自然会升级成 v2。
  const tree = [];
  if (Array.isArray(raw.tree)) {
    for (const item of raw.tree) {
      const member = normalizeMember(item);
      if (member) tree.push(member);
      if (tree.length >= MAX_TREE_MEMBERS) break;
    }
  }
  if (tree.length === 0) {
    tree.push({ pid: raw.pid, ppid: 0, name: typeof raw.name === 'string' ? raw.name : '', creationDate: raw.creationDate, depth: 0 });
  }

  return {
    pid: raw.pid,
    creationDate: raw.creationDate,
    name: typeof raw.name === 'string' ? raw.name : '',
    startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : null,
    savedAt: typeof raw.savedAt === 'string' ? raw.savedAt : null,
    tree,
  };
}

/**
 * @param {{
 *   filePath: string,
 *   corruptBackupDir?: string,
 *   fsImpl?: typeof fs,
 *   now?: () => string,
 *   logger?: { info: Function, warn: Function, error: Function },
 * }} options
 */
export function createRuntimeStore({
  filePath,
  corruptBackupDir = path.join(path.dirname(filePath), 'corrupt'),
  fsImpl = fs,
  now = () => new Date().toISOString(),
  logger = console,
} = {}) {
  if (!filePath) throw new Error('createRuntimeStore 需要 filePath');

  /** @type {Map<string, object>} serviceId → 记录 */
  let entries = new Map();
  let writeChain = Promise.resolve();

  function toPayload() {
    const services = {};
    for (const [id, entry] of entries) services[id] = entry;
    return { version: RUNTIME_STORE_VERSION, services };
  }

  async function persist() {
    const body = `${JSON.stringify(toPayload(), null, 2)}\n`;
    const run = async () => {
      await fsImpl.mkdir(path.dirname(filePath), { recursive: true });
      const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
      try {
        await fsImpl.writeFile(tmpPath, body, 'utf8');
        await fsImpl.rename(tmpPath, filePath);
      } catch (err) {
        await fsImpl.rm(tmpPath, { force: true }).catch(() => {});
        throw err;
      }
    };
    writeChain = writeChain.then(run, run);
    return writeChain;
  }

  return {
    /** 启动加载：文件不存在 → 空档案；损坏 → 备份后清空（接管是增强能力，坏了不挡启动） */
    async init() {
      let raw;
      try {
        raw = await fsImpl.readFile(filePath, 'utf8');
      } catch (err) {
        if (err.code === 'ENOENT') return; // 首次运行，正常
        logger.warn?.(`读取运行时档案失败（${err.message}），按无接管记录处理`);
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        const services = parsed?.services;
        if (services === null || typeof services !== 'object' || Array.isArray(services)) throw new Error('services 字段不是对象');
        const normalized = new Map();
        for (const [id, value] of Object.entries(services)) {
          const entry = normalizeEntry(value);
          if (entry) normalized.set(id, entry);
        }
        entries = normalized;
      } catch (err) {
        try {
          const stamp = now().replace(/[:.]/g, '-');
          await fsImpl.mkdir(corruptBackupDir, { recursive: true });
          await fsImpl.rename(filePath, path.join(corruptBackupDir, `${path.basename(filePath)}.corrupt-${stamp}`));
          logger.warn?.(`运行时档案损坏（${err.message}），已备份并清空：接管能力本次不可用`);
        } catch (backupErr) {
          logger.warn?.(`运行时档案损坏（${err.message}）且备份失败（${backupErr.message}）：按无接管记录处理`);
        }
        entries = new Map();
      }
    },

    list: () => [...entries.entries()],
    get: (id) => (entries.has(id) ? { ...entries.get(id) } : null),

    async set(id, entry) {
      const normalized = normalizeEntry(entry);
      if (!normalized) throw new Error(`运行时档案记录不合法（serviceId=${id}）`);
      normalized.savedAt = now();
      entries.set(id, normalized);
      await persist();
      return { ...normalized };
    },

    async remove(id) {
      if (!entries.has(id)) return false;
      entries.delete(id);
      await persist();
      return true;
    },
  };
}
