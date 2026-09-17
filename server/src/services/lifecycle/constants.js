/**
 * 进程生命周期状态机的常量与纯函数。
 *
 * 从 procManager.js 拆出（Task D）：这些是「无状态」的部分——枚举、可读文案、
 * 状态默认值与时间参数解析。放在这里让编排逻辑（start/stop/exit）保持专注。
 */

export const PROC_STATES = Object.freeze({
  STOPPED: 'stopped',
  STARTING: 'starting',
  RUNNING: 'running',
  STOPPING: 'stopping',
  ERROR: 'error',
  START_FAILED: 'start_failed',
});

/** 启动失败原因码（对前端/报告可见，便于诊断） */
export const FAILURE_REASONS = Object.freeze({
  PREFLIGHT_WORKDIR_MISSING: 'preflight_workdir_missing',
  PREFLIGHT_SCRIPT_MISSING: 'preflight_script_missing',
  PREFLIGHT_SCRIPT_NOT_FILE: 'preflight_script_not_file',
  SPAWN_ERROR: 'spawn_error',
  EXITED_EARLY_ZERO: 'exited_early_zero',
  EXITED_EARLY_NONZERO: 'exited_early_nonzero',
  PID_VANISHED: 'pid_vanished',
  KILL_FAILED: 'kill_failed',
});

/** 停止/启动过程中可以被再次点击的状态 */
export const BUSY_STATES = [PROC_STATES.STARTING, PROC_STATES.RUNNING, PROC_STATES.STOPPING];
export const RUNNING_STATES = [PROC_STATES.RUNNING, PROC_STATES.STARTING];

export const NONBLOCKING_HINT =
  '这通常是「启动即退出」型 .bat（脚本内部用 start 拉起后台进程后自身退出），' +
  '控制台拿不到真正的服务进程 PID，既无法判断状态也无法树杀。' +
  '请把脚本改成阻塞式，例如：start /wait "" "C:\\服务目录\\app.exe"，或去掉 start 直接前台运行服务进程。';

export function blankState() {
  return {
    status: PROC_STATES.STOPPED,
    pid: null,
    exitCode: null,
    startedAt: null,
    exitedAt: null,
    message: null,
    reason: null,
    forcedKill: false,
    diag: [],
    generation: 0,
  };
}

export function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 宽限期的可读写法：5000 → 5s，150 → 150ms */
export function formatGrace(ms) {
  return ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`;
}

/**
 * 解析单个服务的启动时序参数（PRD §7.1 与「AI 服务加载慢」的适配）。
 *
 * - graceMs：进程存活多久之前仍显示 `starting`。服务级配置优先，否则用全局默认。
 * - failureWindowMs：多久之内退出算「启动失败」而不是「异常退出」。
 *   启用宽限期时**就等于宽限期**——否则会出现「宽限期内退出却判成 error」的矛盾；
 *   宽限期为 0（显式关闭）时退回旧的固定窗口，保持既有行为不变。
 *
 * @param {object} service 持久化配置
 * @param {object} procConfig config.proc
 */
export function resolveProcTiming(service, procConfig) {
  const serviceGrace = Number.isInteger(service?.startupGraceMs) ? service.startupGraceMs : null;
  const graceMs = serviceGrace ?? procConfig.startupGraceMs ?? 0;
  return {
    graceMs,
    failureWindowMs: graceMs > 0 ? graceMs : procConfig.startFailureWindowMs,
  };
}
