/**
 * Windows 进程适配器（T1.3，[需 Windows 验证]）。
 *
 * 本文件里「命令怎么拼」的部分是纯函数，已在 macOS 上用单元测试覆盖；
 * 「真的 spawn / taskkill 一个 .bat」的部分只能在 Windows 上验证（见 README「Windows 验证清单」）。
 *
 * ⚠️ 关于 PRD §7.4 的 `shell: 'cmd.exe /c'`：
 * Node 的 shell 选项传字符串时，该字符串被当作 **shell 可执行文件本身**（不是「命令 + 参数」）。
 * 即 `shell: 'cmd.exe /c'` 会让 Node 去找一个名叫 "cmd.exe /c" 的可执行文件 → ENOENT。
 * 正确做法是 `shell: true`：Windows 下 Node 自动用 %comspec%（cmd.exe）/d /s /c "<command>" 执行，
 * 并负责路径加引号（带空格的 .bat 路径可用）。故此处用 shell: true，语义与 PRD 意图一致。
 */
import { spawn as nodeSpawn } from 'node:child_process';

/** taskkill：进程不存在时的退出码（Windows 本地化文案不可靠，优先看退出码） */
export const TASKKILL_NOT_FOUND_EXIT_CODE = 128;

export function buildSpawnOptions({ workDir }) {
  return {
    cwd: workDir,
    // shell: true → Windows 下等价于 `%comspec% /d /s /c "<scriptPath>"`
    shell: true,
    windowsHide: true,
    // PRD §7.4：Windows 分支不设 detached，靠 taskkill /T 树杀
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  };
}

export function buildTaskkillArgs(pid, { force = false } = {}) {
  return ['/pid', String(pid), '/T', ...(force ? ['/F'] : [])];
}

const NOT_FOUND_TEXT = /not found|no running instance|没有找到|找不到/i;

/**
 * 解释 taskkill 结果。
 * - 0 → 成功
 * - 128 / 文案含 not found → 进程已不存在（幂等场景不算失败）
 * - 其他 → 失败，带上 taskkill 的 stderr 供排查
 */
export function classifyTaskkillResult({ code, stderr = '' }) {
  const text = String(stderr).trim();
  if (code === 0) return { ok: true, notFound: false };
  if (code === TASKKILL_NOT_FOUND_EXIT_CODE || NOT_FOUND_TEXT.test(text)) {
    return { ok: true, notFound: true, message: '进程已不存在（可能已自行退出）' };
  }
  return { ok: false, notFound: false, message: text || `taskkill 退出码 ${code}` };
}

/**
 * 进程存活判定（PID 存在性检查，非端口探测 —— PRD §9 明确排除健康检查）。
 * Windows 下 process.kill(pid, 0) 走 OpenProcess；ESRCH = 不存在，EPERM = 存在但无权限。
 *
 * 已知边界：Windows 会复用 PID，极端情况下可能把复用后的 PID 判为「存活」。
 */
export function isProcessAlive(pid, { killImpl = process.kill } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    killImpl(pid, 0);
    return true;
  } catch (err) {
    if (err?.code === 'ESRCH') return false;
    if (err?.code === 'EPERM') return true;
    return false;
  }
}

/**
 * @param {{ logger?: object, spawnImpl?: typeof nodeSpawn, killImpl?: Function }} [options]
 */
export function createWin32Adapter({ logger = console, spawnImpl = nodeSpawn, killImpl = process.kill } = {}) {
  return {
    platform: 'win32',
    isSupported: () => true,

    /**
     * 执行 .bat。返回的 pid 是 cmd.exe 的 PID（.bat 阻塞式运行时的进程树根）。
     * @returns {Promise<{ pid: number }>}
     */
    spawn({ scriptPath, workDir, onStdout, onStderr, onExit }) {
      return new Promise((resolve, reject) => {
        let child;
        try {
          child = spawnImpl(scriptPath, [], buildSpawnOptions({ workDir }));
        } catch (err) {
          reject(err);
          return;
        }

        let spawned = false;
        child.once('spawn', () => {
          spawned = true;
          logger.info?.(`已启动：${scriptPath}（pid=${child.pid}, cwd=${workDir}）`);
          resolve({ pid: child.pid });
        });

        child.once('error', (err) => {
          if (!spawned) {
            reject(err);
            return;
          }
          logger.error?.(`子进程错误：${err.message}`);
          onExit?.({ code: null, signal: null, error: err });
        });

        child.once('exit', (code, signal) => {
          logger.info?.(`进程退出：pid=${child.pid} code=${code} signal=${signal}`);
          onExit?.({ code, signal });
        });

        child.stdout?.on('data', (chunk) => onStdout?.(chunk));
        child.stderr?.on('data', (chunk) => onStderr?.(chunk));
      });
    },

    /**
     * 杀整棵进程树：先 /T（不带 /F），未退出则由调用方决定是否 /T /F。
     * @returns {Promise<{ ok: boolean, notFound?: boolean, message?: string }>}
     */
    killTree(pid, { force = false } = {}) {
      return new Promise((resolve) => {
        const args = buildTaskkillArgs(pid, { force });
        let child;
        try {
          child = spawnImpl('taskkill', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (err) {
          resolve({ ok: false, notFound: false, message: `无法执行 taskkill：${err.message}` });
          return;
        }

        let stderr = '';
        child.stderr?.on('data', (chunk) => {
          stderr += chunk.toString('utf8');
        });
        child.once('error', (err) => {
          resolve({ ok: false, notFound: false, message: `无法执行 taskkill：${err.message}` });
        });
        child.once('exit', (code) => {
          const result = classifyTaskkillResult({ code, stderr });
          logger.info?.(`taskkill ${args.join(' ')} → code=${code}${result.notFound ? '（进程已不存在）' : ''}`);
          resolve(result);
        });
      });
    },

    isAlive(pid) {
      return isProcessAlive(pid, { killImpl });
    },
  };
}
