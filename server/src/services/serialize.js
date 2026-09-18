/**
 * 服务对象序列化：把「持久化配置」与「运行时状态」合并成 API 输出。
 *
 * 分层原则（PRD §6）：status/pid/exitCode 是运行时字段，绝不写回 services.json。
 */
import { PROC_STATES } from './procManager.js';

/** 只有这些状态下 PID 才对外展示（避免展示已失效的旧 PID）。adopted 的 pid 是接管验明过的活进程 */
const PID_VISIBLE_STATES = [PROC_STATES.STARTING, PROC_STATES.RUNNING, PROC_STATES.STOPPING, PROC_STATES.ADOPTED];

/**
 * @param {object} service 持久化配置
 * @param {object} state procManager 运行时状态
 * @param {{ includeDiagnostics?: boolean }} [options]
 */
export function serializeService(service, state, { includeDiagnostics = false } = {}) {
  const status = state?.status ?? PROC_STATES.STOPPED;
  const payload = {
    id: service.id,
    name: service.name,
    workDir: service.workDir,
    startScript: service.startScript,
    logFile: service.logFile,
    port: service.port ?? null,
    /** 启动宽限期（毫秒）；null = 未单独配置，沿用全局默认（config.proc.startupGraceMs） */
    startupGraceMs: service.startupGraceMs ?? null,
    createdAt: service.createdAt,
    updatedAt: service.updatedAt,

    status,
    pid: PID_VISIBLE_STATES.includes(status) ? (state?.pid ?? null) : null,
    exitCode: state?.exitCode ?? null,
    startedAt: state?.startedAt ?? null,
    exitedAt: state?.exitedAt ?? null,
    statusMessage: state?.message ?? null,
    statusReason: state?.reason ?? null,
    forcedKill: Boolean(state?.forcedKill),
  };

  if (includeDiagnostics) {
    payload.startupDiagnostics = Array.isArray(state?.diag) ? [...state.diag] : [];
  }
  return payload;
}

/** 列表接口：不含启动诊断（避免 1.5s 轮询传输大体量数组） */
export function serializeServiceList(services, snapshot) {
  return services.map((service) => serializeService(service, snapshot[service.id]));
}
