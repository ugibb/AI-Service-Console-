import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import {
  buildSpawnCommand,
  buildSpawnOptions,
  buildTaskkillArgs,
  classifyTaskkillResult,
  createWin32Adapter,
  isProcessAlive,
  parseNetstatListeners,
  parseWmicCsv,
  TASKKILL_NOT_FOUND_EXIT_CODE,
} from '../src/proc/win32.js';
import { decodeAuto } from '../src/logs/decode.js';
import { createSilentLogger } from '../testkit/harness.js';
import { cleanupTempDirs, makeTempDir } from '../testkit/tmp.js';

after(cleanupTempDirs);

// ——————————————————————————————————————————————
// 纯函数部分：命令怎么拼 —— 这部分在 macOS 上真的跑过
// ——————————————————————————————————————————————

test('buildSpawnOptions：shell 语义、隐藏窗口、不 detached（PRD §7.4）', () => {
  const options = buildSpawnOptions({ workDir: 'C:\\services\\order' });
  assert.equal(options.cwd, 'C:\\services\\order');
  assert.equal(options.shell, true, '必须用 shell:true；传 "cmd.exe /c" 会被当成文件名 → ENOENT');
  assert.equal(options.windowsHide, true);
  assert.equal(options.detached, false);
  assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
});

test('buildSpawnCommand：命令串必须自带引号，否则含空格路径被 cmd 截断（D1）', () => {
  // 核心用例：这条路径的修复前形态是 `'C:\lsc' 不是内部或外部命令`
  assert.equal(buildSpawnCommand('C:\\Program Files\\lsc\\run.bat'), '"C:\\Program Files\\lsc\\run.bat"');
  // 无空格路径同样要加引号——不加也不会错，但加了才是「永远正确」的那一种写法
  assert.equal(buildSpawnCommand('C:\\lsc\\run.bat'), '"C:\\lsc\\run.bat"');
  // 已经带引号的不能重复加：`""x""` 会被 cmd 的 /s 剥成 `"x"`，多出一层
  assert.equal(buildSpawnCommand('"C:\\lsc\\run.bat"'), '"C:\\lsc\\run.bat"');
  assert.equal(buildSpawnCommand('  C:\\lsc\\run.bat  '), '"C:\\lsc\\run.bat"');
});

test('buildTaskkillArgs：先树杀，强杀才加 /F', () => {
  assert.deepEqual(buildTaskkillArgs(1234), ['/pid', '1234', '/T']);
  assert.deepEqual(buildTaskkillArgs(1234, { force: true }), ['/pid', '1234', '/T', '/F']);
});

test('classifyTaskkillResult：成功 / 进程不存在 / 真失败 三态区分', () => {
  assert.deepEqual(classifyTaskkillResult({ code: 0 }), { ok: true, notFound: false });
  assert.deepEqual(classifyTaskkillResult({ code: TASKKILL_NOT_FOUND_EXIT_CODE, stderr: '' }), {
    ok: true,
    notFound: true,
    message: '进程已不存在（可能已自行退出）',
  });
  // Windows 本地化文案不可靠，英文与中文都要能识别
  assert.equal(classifyTaskkillResult({ code: 1, stderr: 'ERROR: The process "1" not found.' }).notFound, true);
  assert.equal(classifyTaskkillResult({ code: 1, stderr: '错误: 没有找到进程 "1"。' }).notFound, true);

  const denied = classifyTaskkillResult({ code: 1, stderr: 'ERROR: Access is denied.' });
  assert.equal(denied.ok, false);
  assert.equal(denied.notFound, false);
  assert.match(denied.message, /Access is denied/);
  assert.equal(classifyTaskkillResult({ code: 5, stderr: '' }).message, 'taskkill 退出码 5');
});

test('isProcessAlive：存活 / 不存在 / 无权限三种情况', () => {
  assert.equal(isProcessAlive(process.pid), true, '自己一定活着');
  assert.equal(isProcessAlive(0), false);
  assert.equal(isProcessAlive(NaN), false);

  const esrch = () => {
    const err = new Error('no such process');
    err.code = 'ESRCH';
    throw err;
  };
  const eperm = () => {
    const err = new Error('operation not permitted');
    err.code = 'EPERM';
    throw err;
  };
  assert.equal(isProcessAlive(999999, { killImpl: esrch }), false);
  assert.equal(isProcessAlive(999999, { killImpl: eperm }), true, 'EPERM 说明进程存在但没权限');
  assert.equal(
    isProcessAlive(999999, {
      killImpl: () => {
        throw new Error('boom');
      },
    }),
    false,
  );
});

test('isProcessAlive：真实进程退出后判定为不存在（Node 的 kill(pid,0) 语义）', async () => {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  const pid = child.pid;
  assert.equal(isProcessAlive(pid), true);
  await once(child, 'exit');
  // Windows 上此处走 OpenProcess；macOS 上走 kill(pid,0)。语义一致：已退出 → false。
  assert.equal(isProcessAlive(pid), false);
});

test('shell:true 才能执行脚本文件；把 shell 写成 "cmd.exe /c" 会 ENOENT（解释 PRD §7.4 的写法问题）', async () => {
  const dir = await makeTempDir();
  // shell:true 在 Windows 下是 cmd.exe，在 POSIX 下是 /bin/sh —— 脚本得用各自平台的写法，
  // 否则「正例」在 Windows 上会因为「cmd 不认 #!/bin/sh」而假失败。
  const isWin = process.platform === 'win32';
  const script = path.join(dir, isWin ? 'run.bat' : 'run.sh');
  await fs.writeFile(script, isWin ? '@echo hello-from-script\r\n' : '#!/bin/sh\necho hello-from-script\n');
  if (!isWin) await fs.chmod(script, 0o755);

  // 反例：字符串形式的 shell 会被 Node 当作「可执行文件名」，而不是「命令 + 参数」
  await assert.rejects(
    new Promise((resolve, reject) => {
      const bad = spawn(script, [], { shell: '/bin/sh -c' });
      bad.once('error', reject);
      bad.once('spawn', resolve);
    }),
    (err) => err.code === 'ENOENT',
  );

  // 正例：shell: true —— 与 win32 适配器内部用法完全一致（Windows 下由 Node 换成 cmd.exe /d /s /c）
  const adapter = createWin32Adapter({ logger: createSilentLogger() });
  const chunks = [];
  const exited = new Promise((resolve) => {
    adapter.spawn({
      scriptPath: script,
      workDir: dir,
      onStdout: (chunk) => chunks.push(chunk),
      onStderr: () => {},
      onExit: resolve,
    });
  });
  const { code } = await exited;
  assert.equal(code, 0);
  assert.match(Buffer.concat(chunks).toString('utf8'), /hello-from-script/);
});

test('D1 回归：工作目录与脚本路径含空格时仍能启动（修复前报 "C:\\lsc" 不是内部或外部命令）', async () => {
  // 这条用例的价值在于「真起进程」：D1 修复前，纯函数单测全绿而真机会挂。
  // 路径形状刻意贴近现场：C:\Program Files\... 、C:\Users\Foo Bar\...
  const base = await makeTempDir();
  const spacedDir = path.join(base, 'lsc verify', 'my services');
  await fs.mkdir(spacedDir, { recursive: true });

  const isWin = process.platform === 'win32';
  const script = path.join(spacedDir, isWin ? 'run.bat' : 'run.sh');
  await fs.writeFile(script, isWin ? '@echo SPACED-OK\r\n' : '#!/bin/sh\necho SPACED-OK\n');
  if (!isWin) await fs.chmod(script, 0o755);

  // 先钉死前提：这条路径确实含空格，否则本用例会退化成「又测了一遍无空格路径」
  assert.match(script, / /, '测试前提：脚本路径必须含空格');

  const adapter = createWin32Adapter({ logger: createSilentLogger() });
  const chunks = [];
  const exited = new Promise((resolve) => {
    adapter.spawn({
      scriptPath: script,
      workDir: spacedDir,
      onStdout: (chunk) => chunks.push(chunk),
      onStderr: () => {},
      onExit: resolve,
    });
  });

  const { code } = await exited;
  assert.equal(code, 0, `含空格路径的脚本应正常退出；实际退出码 ${code}`);
  assert.match(Buffer.concat(chunks).toString('utf8'), /SPACED-OK/);
});

test('createWin32Adapter：脚本不存在时 shell 仍能起来，失败由「退出码 + stderr」表达（不是 spawn reject）', async () => {
  const dir = await makeTempDir();
  const adapter = createWin32Adapter({ logger: createSilentLogger() });
  const stderrChunks = [];

  let resolveExit;
  const exited = new Promise((resolve) => {
    resolveExit = resolve;
  });
  let exitInfo = null;

  const { pid } = await adapter.spawn({
    scriptPath: path.join(dir, 'nope.bat'),
    workDir: dir,
    onStderr: (chunk) => stderrChunks.push(chunk),
    onExit: (info) => {
      exitInfo = info;
      resolveExit();
    },
  });
  assert.ok(Number.isInteger(pid));

  await exited;
  assert.notEqual(exitInfo.code, 0, '脚本不存在 → 非 0 退出码');
  // 必须解码而不是 toString('utf8')：cmd.exe 在中文 Windows 上按 OEM 码页（936/GBK）输出，
  // 直接 utf8 解码得到的是乱码，任何中文关键词都匹配不上 —— 这也正是本条要覆盖的真实场景。
  const stderr = Buffer.concat(stderrChunks);
  const stderrText = process.platform === 'win32' ? decodeAuto(stderr).text : stderr.toString('utf8');
  // 中文 cmd.exe 的实际文案是「不是内部或外部命令」，不是「找不到」（后者是另一类错误）。
  // 英文/其他语言 Windows 各自的措辞不同，故只断言「非空且提到了脚本」，把措辞留给环境。
  assert.ok(stderrText.trim().length > 0, '脚本不存在时 stderr 应有内容');
  assert.match(stderrText, /No such file|not found|找不到|不是内部或外部命令|不是内部命令/i);

  // 这条行为决定了 procManager 必须靠「启动窗口内退出码」判定 start_failed，
  // 而不是只等 adapter.spawn() reject（shell 会成功启动，根本不会 reject）。
});

test('createWin32Adapter.spawn：spawn 抛错时同步 reject（不挂起）', async () => {
  const adapter = createWin32Adapter({
    logger: createSilentLogger(),
    spawnImpl: () => {
      throw new Error('spawn 不可用');
    },
  });
  await assert.rejects(() => adapter.spawn({ scriptPath: 'x.bat', workDir: '.' }), /spawn 不可用/);
});

test('createWin32Adapter.killTree：真实执行 taskkill 时用假 spawnImpl 验证参数与结果映射', async () => {
  const { EventEmitter } = await import('node:events');
  const calls = [];
  const makeSpawn =
    (exitCode, stderr = '') =>
    (file, args, options) => {
      calls.push({ file, args, options });
      const child = new EventEmitter();
      child.stderr = new EventEmitter();
      setImmediate(() => {
        if (stderr) child.stderr.emit('data', Buffer.from(stderr));
        child.emit('exit', exitCode);
      });
      return child;
    };

  const okAdapter = createWin32Adapter({ logger: createSilentLogger(), spawnImpl: makeSpawn(0) });
  assert.deepEqual(await okAdapter.killTree(4321), { ok: true, notFound: false });
  assert.equal(calls[0].file, 'taskkill');
  assert.deepEqual(calls[0].args, ['/pid', '4321', '/T']);
  assert.equal(calls[0].options.windowsHide, true);

  const notFoundAdapter = createWin32Adapter({
    logger: createSilentLogger(),
    spawnImpl: makeSpawn(TASKKILL_NOT_FOUND_EXIT_CODE),
  });
  assert.equal((await notFoundAdapter.killTree(4321, { force: true })).notFound, true);
  assert.deepEqual(calls[1].args, ['/pid', '4321', '/T', '/F']);

  const failAdapter = createWin32Adapter({ logger: createSilentLogger(), spawnImpl: makeSpawn(1, 'ERROR: Access is denied.') });
  const failed = await failAdapter.killTree(4321);
  assert.equal(failed.ok, false);
  assert.match(failed.message, /Access is denied/);
});

test('createWin32Adapter.killTree：taskkill 本身无法执行 → ok:false 带原因', async () => {
  const { EventEmitter } = await import('node:events');
  const adapter = createWin32Adapter({
    logger: createSilentLogger(),
    spawnImpl: () => {
      const child = new EventEmitter();
      child.stderr = new EventEmitter();
      setImmediate(() => child.emit('error', new Error('taskkill 不存在')));
      return child;
    },
  });
  const result = await adapter.killTree(1);
  assert.equal(result.ok, false);
  assert.match(result.message, /无法执行 taskkill/);
});

test('createWin32Adapter：platform 与 isSupported 标识（真机必须在 Windows 上）', () => {
  const adapter = createWin32Adapter({ logger: createSilentLogger() });
  assert.equal(adapter.platform, 'win32');
  assert.equal(adapter.isSupported(), true);
  assert.equal(adapter.isAlive(process.pid), true);
});

// ——————————————————————————————————————————————
// 进程/端口探测的解析纯函数（2026-09-18 真机实测的输出形状，见 win32.js 注释）
// ——————————————————————————————————————————————

const WMIC_SAMPLE = [
  'Node,CreationDate,Name,ParentProcessId,ProcessId',
  'UGIBB510-PC,20260918104329.556343+480,python.exe,16116,25452',
  'UGIBB510-PC,20260918104326.105632+480,cmd.exe,22260,26448',
  'UGIBB510-PC,20260918104329.279730+480,python.exe,26448,16116',
].join('\r\n');

test('parseWmicCsv：表头动态定位，正确解出 pid/ppid/name/创建时间', () => {
  const map = parseWmicCsv(WMIC_SAMPLE);
  assert.equal(map.size, 3);
  const leaf = map.get(25452);
  assert.equal(leaf.ppid, 16116);
  assert.equal(leaf.name, 'python.exe');
  assert.equal(leaf.creationDate, '20260918104329.556343+480', '创建时间必须是 wmic 原始串（接管身份按精确相等比对）');
  // 沿 ppid 能走完整条进程链（清理时用来保护控制台自己的祖先）
  assert.equal(map.get(16116).ppid, 26448);
  assert.equal(map.get(26448).ppid, 22260);
});

test('parseWmicCsv：查询无结果时 wmic 先吐本地化错误行再吐表头——不能把错误行当表头', () => {
  const text = ['没有可用实例', '', 'Node,CreationDate,Name,ParentProcessId,ProcessId'].join('\r\n');
  assert.equal(parseWmicCsv(text).size, 0);
  // 完全无表头（wmic 被移除的新系统）→ 空表，不抛
  assert.equal(parseWmicCsv('随便什么').size, 0);
  assert.equal(parseWmicCsv('').size, 0);
});

test('parseNetstatListeners：只认 LISTENING、精确匹配端口、IPv4/IPv6 去重', () => {
  const text = [
    '  TCP    0.0.0.0:8083           0.0.0.0:0              LISTENING       25452',
    '  TCP    [::]:8083              [::]:0                 LISTENING       25452',
    '  TCP    127.0.0.1:3010         127.0.0.1:52344        ESTABLISHED     22260', // 不是监听
    '  TCP    0.0.0.0:808            0.0.0.0:0              LISTENING       999', // 端口不同（808 ≠ 8083 的前缀陷阱）
    '  UDP    0.0.0.0:8083           *:*                                    25452', // 不是 TCP
  ].join('\r\n');
  assert.deepEqual(parseNetstatListeners(text, 8083), [25452]);
  assert.deepEqual(parseNetstatListeners(text, 808), [999]);
  assert.deepEqual(parseNetstatListeners(text, 3010), [], 'ESTABLISHED 的不是占用者');
});

test('createWin32Adapter.listProcesses / portOwners：探测命令失败时降级为空结果，不抛', async () => {
  const { EventEmitter } = await import('node:events');
  const makeSpawn = (exitCode) => (_file, _args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from(''));
      child.emit('exit', exitCode);
    });
    return child;
  };
  const adapter = createWin32Adapter({ logger: createSilentLogger(), spawnImpl: makeSpawn(1) });
  assert.equal((await adapter.listProcesses()).size, 0, 'wmic 非零退出 → 空快照');
  assert.deepEqual(await adapter.portOwners(8083), [], 'netstat 非零退出 → 空占用者');
});

test('createWin32Adapter.listProcesses / portOwners：正常输出经解析得到快照与占用者', async () => {
  const { EventEmitter } = await import('node:events');
  const spawnImpl = (file, _args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      const body = file === 'wmic' ? WMIC_SAMPLE : `  TCP    0.0.0.0:8083    0.0.0.0:0    LISTENING    25452\r\n`;
      child.stdout.emit('data', Buffer.from(body, 'utf8'));
      child.emit('exit', 0);
    });
    return child;
  };
  const adapter = createWin32Adapter({ logger: createSilentLogger(), spawnImpl });
  assert.equal((await adapter.listProcesses()).get(25452).name, 'python.exe');
  assert.deepEqual(await adapter.portOwners(8083), [25452]);
});
