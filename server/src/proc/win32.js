/**
 * Windows 进程适配器（T1.3，[需 Windows 验证]）。
 *
 * 本文件里「命令怎么拼」的部分是纯函数，已在 macOS 上用单元测试覆盖；
 * 「真的 spawn / taskkill 一个 .bat」的部分只能在 Windows 上验证（见 README「Windows 验证清单」）。
 *
 * ⚠️ 关于 PRD §7.4 的 `shell: 'cmd.exe /c'`：
 * Node 的 shell 选项传字符串时，该字符串被当作 **shell 可执行文件本身**（不是「命令 + 参数」）。
 * 即 `shell: 'cmd.exe /c'` 会让 Node 去找一个名叫 "cmd.exe /c" 的可执行文件 → ENOENT。
 * 正确做法是 `shell: true`：Windows 下 Node 自动用 %comspec%（cmd.exe）/d /s /c "<command>" 执行。
 * 故此处用 shell: true，语义与 PRD 意图一致。
 *
 * ⚠️ 但 `shell: true` **不负责给路径加引号**（曾据此写下的注释已被现场实测证伪，见 D1）。
 * 命令串必须自己加引号，见 buildSpawnCommand()。
 */
import { spawn as nodeSpawn } from 'node:child_process';
import iconv from 'iconv-lite';

/** taskkill：进程不存在时的退出码（Windows 本地化文案不可靠，优先看退出码） */
export const TASKKILL_NOT_FOUND_EXIT_CODE = 128;

/**
 * 构造交给 shell 执行的命令串（D1 修复，2026-09-18 真机实测）。
 *
 * **为什么必须自己补引号**：Node 在 `shell: true` 时拼出的是
 * `cmd.exe /d /s /c "<command>"`，而 cmd 的 `/s` 会把最外层这一对引号**剥掉**。
 * 于是没带引号的 `C:\Program Files\x\run.bat` 被剥成
 * 「命令 `C:\Program Files\x\run.bat`」→ 按空格切分 → 实际执行 `C:\Program`，
 * 报错 `'C:\Program' 不是内部或外部命令`。**路径里第一个空格就把命令截断了。**
 *
 * 自己补一层引号后，最终命令行是
 * `cmd.exe /d /s /c ""C:\Program Files\x\run.bat""`，
 * `/s` 剥掉外层，剩下的 `"C:\Program Files\x\run.bat"` 正好是 cmd 能正确解析的带引号命令。
 *
 * 这条同时解释了一个反直觉的现象：**纯单元测试全绿也说明不了问题**——
 * 单测验的是「命令怎么拼」的纯函数，而「加引号」这件事被默认为 Node 会做。
 * 故本函数是纯函数，但真正的证据在 `server/test/win32.test.js` 里那条**真起进程**的用例。
 *
 * @param {string} scriptPath `.bat` 绝对路径
 * @returns {string} 可直接交给 `spawn(command, [], { shell: true })` 的命令串
 */
export function buildSpawnCommand(scriptPath) {
  const value = String(scriptPath).trim();
  // 已经带引号的不要重复加：`""x""` 会被 /s 剥成 `"x"`，反而多一层
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) return value;
  return `"${value}"`;
}

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
 * 跑一条只读探测命令并收全输出（wmic / netstat）。与 killTree 不同，这里要 stdout。
 * 失败不抛：探测是「尽力而为」的上游——拿不到快照时，调用方按「没有旧进程可清理」降级。
 */
function runCapture(spawnImpl, file, args, { encoding = 'utf8' } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ ok: false, code: null, stdout: '', stderr: err.message });
      return;
    }
    const chunks = [];
    let stderr = '';
    child.stdout?.on('data', (chunk) => chunks.push(chunk));
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', (err) => resolve({ ok: false, code: null, stdout: '', stderr: err.message }));
    child.once('exit', (code) => resolve({ ok: true, code, stdout: iconv.decode(Buffer.concat(chunks), encoding), stderr }));
  });
}

/**
 * 解析 `wmic process get ... /format:csv` 的输出为 pid → 进程信息表。
 *
 * wmic 的 CSV 表头固定以 Node, 开头且列名按字母序（实测 2026-09-18）：
 *   Node,CreationDate,Name,ParentProcessId,ProcessId
 * 之所以动态找表头而不是假定第一行就是：查询无结果时 wmic 会先吐一行本地化错误
 * （且退出码为 0），按第一行解析会把那行错误当表头。
 *
 * CreationDate 是 wmic 的原始串（20260918104326.105632+480，100ns 粒度）。
 * 接管身份校验依赖它的**精确字符串相等**——pid 复用不可能连 100ns 的创建时刻都复用。
 */
export function parseWmicCsv(text) {
  const map = new Map();
  const lines = String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const headerIndex = lines.findIndex((line) => line.startsWith('Node,'));
  if (headerIndex === -1) return map;
  const header = lines[headerIndex].split(',').map((cell) => cell.trim());
  const column = (name) => header.indexOf(name);
  const [iCreated, iName, iPpid, iPid] = ['CreationDate', 'Name', 'ParentProcessId', 'ProcessId'].map(column);
  if (iPid === -1 || iCreated === -1 || iPpid === -1) return map;
  for (const line of lines.slice(headerIndex + 1)) {
    const cells = line.split(',');
    const pid = Number(cells[iPid]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    map.set(pid, {
      pid,
      ppid: Number(cells[iPpid]) || 0,
      name: (iName !== -1 ? cells[iName] : '') || '',
      creationDate: cells[iCreated] || '',
    });
  }
  return map;
}

/**
 * 从 `netstat -ano` 输出里找**监听**指定端口的 pid 集合。
 * 行样例：`  TCP    0.0.0.0:8083    0.0.0.0:0    LISTENING    25452`（IPv6 本地地址是 `[::]:8083`）。
 * 同一端口通常有 IPv4+IPv6 两行、同一 pid，去重后返回。
 */
export function parseNetstatListeners(text, port) {
  const pids = new Set();
  for (const rawLine of String(text).split(/\r?\n/)) {
    const cells = rawLine.trim().split(/\s+/);
    if (cells.length < 5 || cells[0] !== 'TCP') continue;
    const state = cells[cells.length - 2];
    const pid = Number(cells[cells.length - 1]);
    if (state !== 'LISTENING' || !Number.isInteger(pid)) continue;
    const local = cells[1];
    const colon = local.lastIndexOf(':');
    if (colon === -1 || Number(local.slice(colon + 1)) !== port) continue;
    pids.add(pid);
  }
  return [...pids];
}

/**
 * @param {{ logger?: object, spawnImpl?: typeof nodeSpawn, killImpl?: Function }} [options]
 */
export function createWin32Adapter({ logger = console, spawnImpl = nodeSpawn, killImpl = process.kill } = {}) {
  return {
    platform: 'win32',
    isSupported: () => true,

    /**
     * 一次 wmic 调用枚举全部进程（实测 353 进程 ≈150ms），比逐 pid 查询快一个数量级。
     * 接管校验（pid → 创建时间）与启动前清理（占用者叫什么名字、是不是控制台自己的祖先）
     * 共用这一份快照。
     *
     * ⚠️ wmic 在新版 Windows（11 24H2+）逐步移除：拿不到时这里返回空表，
     * 接管降级为「显示已停止」（下次启动靠端口清理兜底），不阻断任何功能。
     * @returns {Promise<Map<number, {pid:number, ppid:number, name:string, creationDate:string}>>}
     */
    async listProcesses() {
      // CSV 值按 OEM 代码页输出（zh-CN 为 GBK）；ASCII 部分两种解码一致，
      // 非 ASCII 进程名只有按 GBK 解才不是乱码（与 logs/decode.js 同一原则）
      const result = await runCapture(spawnImpl, 'wmic', ['process', 'get', 'ProcessId,ParentProcessId,CreationDate,Name', '/format:csv'], {
        encoding: 'gbk',
      });
      if (!result.ok || result.code !== 0) {
        logger.warn?.(`枚举进程失败（wmic 退出码 ${result.code ?? '无'}）：${result.stderr.trim() || '无输出'}`);
        return new Map();
      }
      return parseWmicCsv(result.stdout);
    },

    /**
     * 找出监听指定端口的 pid（netstat -ano，实测 ≈50ms）。
     * @returns {Promise<number[]>}
     */
    async portOwners(port) {
      const result = await runCapture(spawnImpl, 'netstat', ['-ano']);
      if (!result.ok || result.code !== 0) {
        logger.warn?.(`查询端口占用失败（netstat 退出码 ${result.code ?? '无'}）：${result.stderr.trim() || '无输出'}`);
        return [];
      }
      return parseNetstatListeners(result.stdout, port);
    },

    /**
     * 执行 .bat。返回的 pid 是 cmd.exe 的 PID（.bat 阻塞式运行时的进程树根）。
     * @returns {Promise<{ pid: number }>}
     */
    spawn({ scriptPath, workDir, onStdout, onStderr, onExit }) {
      return new Promise((resolve, reject) => {
        let child;
        try {
          // 命令串必须自己带引号（D1）：含空格的路径否则会被 cmd 从第一个空格处截断
          child = spawnImpl(buildSpawnCommand(scriptPath), [], buildSpawnOptions({ workDir }));
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
