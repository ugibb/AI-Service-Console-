/**
 * 服务配置持久化（data/services.json）。
 *
 * 设计要点：
 * - 原子写：先写同目录临时文件再 rename，避免进程被杀时留下半截 JSON。
 * - 串行写：多次并发修改排队执行，避免相互覆盖。
 * - 损坏降级：启动加载解析失败 → 备份损坏文件到 data/corrupt/ 并以空列表继续，同时返回 warning
 *   （PRD §12「配置 JSON 损坏 → 启动时告警，降级为空列表并备份损坏文件」）。
 * - 加载时归一化而非丢弃：字段缺失的条目补齐默认值并告警，保留用户数据供其在 UI 上修正。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertValidServiceInput, SERVICE_LIMITS } from '../lib/validate.js';

export const STORE_VERSION = 1;
export const DEFAULT_SERVICES_FILE = 'services.json';

function clone(service) {
  return service ? { ...service } : null;
}

function toIso(value, fallback) {
  if (typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value))) return value;
  return fallback;
}

function normalizeStoredService(raw, { idFactory, now, usedIds }) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const str = (v) => (typeof v === 'string' ? v.trim() : v === undefined || v === null ? '' : String(v).trim());
  let id = str(raw.id);
  if (id === '' || usedIds.has(id)) id = idFactory();
  usedIds.add(id);
  const portRaw = raw.port;
  const port = Number.isInteger(portRaw) && portRaw >= SERVICE_LIMITS.portMin && portRaw <= SERVICE_LIMITS.portMax ? portRaw : null;
  return {
    id,
    name: str(raw.name),
    workDir: str(raw.workDir),
    startScript: str(raw.startScript),
    logFile: str(raw.logFile),
    port,
    createdAt: toIso(raw.createdAt, now()),
    updatedAt: toIso(raw.updatedAt, now()),
  };
}

/**
 * @param {{
 *   filePath: string,
 *   corruptBackupDir?: string,
 *   fsImpl?: typeof fs,
 *   now?: () => string,
 *   idFactory?: () => string,
 *   logger?: { info: Function, warn: Function, error: Function },
 * }} options
 */
export function createConfigStore({
  filePath,
  corruptBackupDir = path.join(path.dirname(filePath), 'corrupt'),
  fsImpl = fs,
  now = () => new Date().toISOString(),
  idFactory = randomUUID,
  logger = console,
} = {}) {
  if (!filePath) throw new Error('createConfigStore 需要 filePath');

  /** @type {object[]} */
  let services = [];
  let warnings = [];
  let loaded = false;
  let writeChain = Promise.resolve();

  function toPayload() {
    return { version: STORE_VERSION, services };
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

  async function backupCorruptFile(reason) {
    const stamp = now().replace(/[:.]/g, '-');
    const target = path.join(corruptBackupDir, `${path.basename(filePath)}.corrupt-${stamp}`);
    try {
      await fsImpl.mkdir(corruptBackupDir, { recursive: true });
      await fsImpl.rename(filePath, target);
      return target;
    } catch (err) {
      warnings.push(`损坏的配置文件备份失败（${reason}）：${err.message}`);
      return null;
    }
  }

  function parsePayload(raw) {
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : parsed?.services;
    if (!Array.isArray(list)) throw new Error('services 字段不是数组');
    return list;
  }

  return {
    /** 启动加载：损坏 → 备份 + 空列表 + warning；文件不存在 → 空列表 */
    async init() {
      warnings = [];
      services = [];
      let raw;
      try {
        raw = await fsImpl.readFile(filePath, 'utf8');
      } catch (err) {
        if (err.code === 'ENOENT') {
          loaded = true;
          logger.info?.(`配置文件不存在，将以空列表启动：${filePath}`);
          return { services: [], warnings };
        }
        warnings.push(`读取配置文件失败：${err.message}`);
        loaded = true;
        return { services: [], warnings };
      }

      let list;
      try {
        list = parsePayload(raw);
      } catch (err) {
        const backupPath = await backupCorruptFile(err.message);
        warnings.push(
          `配置文件损坏（${err.message}），已降级为空列表${backupPath ? `，原文件备份至 ${backupPath}` : ''}`,
        );
        logger.warn?.(warnings[warnings.length - 1]);
        loaded = true;
        return { services: [], warnings };
      }

      const usedIds = new Set();
      const normalized = [];
      let repaired = 0;
      for (const item of list) {
        const entry = normalizeStoredService(item, { idFactory, now, usedIds });
        if (entry === null) {
          repaired += 1;
          continue;
        }
        normalized.push(entry);
      }
      if (repaired > 0) {
        warnings.push(`配置中有 ${repaired} 条无效记录已被忽略，请在界面上确认服务列表`);
      }
      services = normalized;
      loaded = true;
      return { services: services.map(clone), warnings: [...warnings] };
    },

    isLoaded: () => loaded,
    warnings: () => [...warnings],
    list: () => services.map(clone),
    get: (id) => clone(services.find((s) => s.id === id)),
    has: (id) => services.some((s) => s.id === id),
    count: () => services.length,

    async create(input) {
      const value = assertValidServiceInput(input);
      const timestamp = now();
      const service = { id: idFactory(), ...value, createdAt: timestamp, updatedAt: timestamp };
      services = [...services, service];
      await persist();
      return clone(service);
    },

    async update(id, input) {
      const index = services.findIndex((s) => s.id === id);
      if (index === -1) return null;
      const value = assertValidServiceInput(input);
      const updated = { ...services[index], ...value, updatedAt: now() };
      services = services.map((s, i) => (i === index ? updated : s));
      await persist();
      return clone(updated);
    },

    async remove(id) {
      const index = services.findIndex((s) => s.id === id);
      if (index === -1) return false;
      services = services.filter((_, i) => i !== index);
      await persist();
      return true;
    },
  };
}
