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
  /** 控制台重启后接管了「重启前由本控制台启动、且仍在运行」的进程（见 adopt.js） */
  ADOPTED: 'adopted',
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
  /** 启动前清理失败：旧进程/端口占用者杀不掉，宁可不起也不能起出第二个实例 */
  PRESTART_CLEANUP_FAILED: 'prestart_cleanup_failed',
});

/**
 * 占用着资源（活着的 pid）的状态：编辑/删除必须先停（routes/services.js 的 409 守卫）。
 * adopted 与 running 同义——区别只在「进程是上个控制台会话启动的」，一样占着端口、
 * 一样必须能被停止，编辑/删除的防线不能少。
 */
export const BUSY_STATES = [PROC_STATES.STARTING, PROC_STATES.RUNNING, PROC_STATES.STOPPING, PROC_STATES.ADOPTED];
/**
 * 可以执行停止流程的状态（stop.js 的守卫）。adopted 的进程不是当前进程的子进程、
 * 没有 exit 事件，但 killTree(taskkill /T) 与 isAlive 都不要求父子关系，照杀照探。
 */
export const RUNNING_STATES = [PROC_STATES.RUNNING, PROC_STATES.STARTING, PROC_STATES.ADOPTED];
/**
 * 启动不可打断的过渡态：点「启动」时正在 starting/stopping，只能等它走完
 * （running/adopted 则不同——「启动」的语义就是先停再起，见 start.js）。
 */
export const TRANSIENT_STATES = [PROC_STATES.STARTING, PROC_STATES.STOPPING];

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
