/**
 * 启动流程与「存活校验」（从 procManager.js 拆出，Task D）。
 *
 * 对 PRD §7.3「.bat 阻塞式」这一**未确认假设**的防御集中在这里：
 * 1. spawn 成功后在宽限期内保持 `starting`，期满仍存活才置 `running`（AI 服务加载慢的适配）；
 * 2. 延迟 startVerifyDelayMs 复查 PID 是否仍存活 → 不存活则 start_failed(pid_vanished)；
 * 3. 启动窗口内退出即视为启动失败（见 exit.js，**包括退出码 0**）。
 */
import { serviceBusy, serviceNotFound } from '../../lib/errors.js';
import { createDiagBuffer } from '../../proc/diagBuffer.js';
import { preflight, resolveServicePaths } from '../paths.js';
import { PROC_STATES, FAILURE_REASONS, BUSY_STATES, NONBLOCKING_HINT, resolveProcTiming, formatGrace } from './constants.js';

/** 会话是否已被新的一代取代（上一代 spawn 的迟到结果不该写状态） */
const isStale = (runtime, id, session) => session.generation !== runtime.stateOf(id).generation;

function createStartSession(runtime, service, generation) {
  return {
    generation,
    timers: new Set(),
    diagBuffer: createDiagBuffer({ maxLines: runtime.procConfig.diagBufferLines }),
    spawnPromise: null,
    startFlow: null,
    exited: false,
    exitHandled: false,
    diagFrozen: false,
    ...resolveProcTiming(service, runtime.procConfig),
  };
}

/** 启动窗口结束后停止收集诊断输出（PRD §8.5：只在启动失败时有价值），并把已捕获的输出固化 */
function scheduleDiagFreeze(runtime, id, session) {
  const timer = setTimeout(() => {
    session.diagFrozen = true;
    session.timers.delete(timer);
    const status = runtime.stateOf(id).status;
    if (status === PROC_STATES.RUNNING || status === PROC_STATES.STARTING) {
      runtime.patch(id, { diag: session.diagBuffer.lines() });
    }
  }, session.failureWindowMs);
  session.timers.add(timer);
}

/** 宽限期结束仍存活 → running（AI 服务加载模型期间的「启动中」到此结束） */
function scheduleRunning(runtime, id, session) {
  const timer = setTimeout(() => {
    session.timers.delete(timer);
    if (isStale(runtime, id, session)) return;
    if (session.exited) return;
    if (runtime.stateOf(id).status !== PROC_STATES.STARTING) return;
    runtime.patch(id, { status: PROC_STATES.RUNNING, message: null });
  }, session.graceMs);
  session.timers.add(timer);
}

/** spawn 成功后延迟校验 PID 存活（防御「启动即退出」型 .bat 的静默消失） */
function scheduleVerify(runtime, id, session, exits) {
  const timer = setTimeout(() => {
    session.timers.delete(timer);
    const current = runtime.stateOf(id);
    if (session.generation !== current.generation) return;
    // 宽限期内是 starting、之后是 running，两种状态都要盯 PID 存活
    if (current.status !== PROC_STATES.RUNNING && current.status !== PROC_STATES.STARTING) return;
    if (session.exited) return;
    if (runtime.adapter.isAlive(current.pid)) return;
    exits.finishFailure(id, session, {
      reason: FAILURE_REASONS.PID_VANISHED,
      message:
        `spawn 成功，但 ${runtime.procConfig.startVerifyDelayMs}ms 后 PID ${current.pid} 已不存在。` +
        `服务很可能没有真正跑起来，或脚本启动后立即退出。${NONBLOCKING_HINT}`,
    });
  }, runtime.procConfig.startVerifyDelayMs);
  session.timers.add(timer);
}

/** spawn 落地后落状态：宽限期 > 0 保持 starting（计时），否则直接 running */
function settleSpawn(runtime, id, session, pid) {
  const startedAt = runtime.now();
  if (session.graceMs > 0) {
    // 宽限期内保持「启动中」：AI 服务此时模型还没加载完，不能显示成「运行中」骗用户。
    // 状态没变（start 时已是 starting），因此 patch 不会触发状态回调，只更新 pid / startedAt。
    runtime.patch(id, {
      pid,
      startedAt,
      message: `启动中：进程已拉起（pid=${pid}），等待服务就绪（宽限期 ${formatGrace(session.graceMs)}）`,
    });
    scheduleRunning(runtime, id, session);
  } else {
    runtime.patch(id, { status: PROC_STATES.RUNNING, pid, startedAt, message: null });
  }
}

async function runSpawn(runtime, exits, id, session, paths) {
  const check = await preflight(paths);
  if (isStale(runtime, id, session)) return runtime.stateOf(id);
  if (!check.ok) return exits.finishFailure(id, session, { reason: check.reason, message: check.message });

  const spawnPromise = runtime.adapter.spawn({
    scriptPath: paths.scriptPath,
    workDir: paths.workDir,
    onStdout: (chunk) => runtime.appendDiag(id, session, chunk),
    onStderr: (chunk) => runtime.appendDiag(id, session, chunk),
    onExit: (info) => exits.handleExit(id, session, info),
  });
  session.spawnPromise = spawnPromise;

  let spawnResult;
  try {
    spawnResult = await spawnPromise;
  } catch (err) {
    return exits.finishFailure(id, session, {
      reason: FAILURE_REASONS.SPAWN_ERROR,
      message: `启动失败：${err.message}（脚本 ${paths.scriptPath}）`,
    });
  }

  if (isStale(runtime, id, session)) return runtime.stateOf(id);
  if (session.exited) {
    // spawn 与 exit 极快连续发生：交给 handleExit 已写入的状态，不再覆盖
    return runtime.stateOf(id);
  }

  settleSpawn(runtime, id, session, spawnResult.pid);
  scheduleVerify(runtime, id, session, exits);
  return runtime.stateOf(id);
}

export function createStartOps(runtime, exits) {
  /** 启动：契约上始终返回 Promise（失败一律 reject，不在调用点同步抛错） */
  async function start(id) {
    const service = runtime.store.get(id);
    if (!service) throw serviceNotFound(id);
    const current = runtime.stateOf(id);
    if (BUSY_STATES.includes(current.status)) throw serviceBusy(id, current.status);

    const paths = resolveServicePaths(service);
    const generation = current.generation + 1;
    const session = createStartSession(runtime, service, generation);

    runtime.patch(id, {
      status: PROC_STATES.STARTING,
      pid: null,
      exitCode: null,
      startedAt: null,
      exitedAt: null,
      forcedKill: false,
      reason: null,
      message: `正在启动：${paths.scriptPath}`,
      diag: [],
      generation,
    });
    runtime.sessions.set(id, session);
    scheduleDiagFreeze(runtime, id, session);

    // startFlow 在整个「spawn 落地 + 状态落到 running」之后才 resolve，
    // 这样「启动中点停止」能确定性地等到 pid 就绪（避免拿着 null pid 去停止）。
    const flow = runSpawn(runtime, exits, id, session, paths);
    session.startFlow = flow;
    return flow;
  }

  return { start };
}
