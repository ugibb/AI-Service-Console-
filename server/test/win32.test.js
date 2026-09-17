import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import {
  buildSpawnOptions,
  buildTaskkillArgs,
  classifyTaskkillResult,
  createWin32Adapter,
  isProcessAlive,
  TASKKILL_NOT_FOUND_EXIT_CODE,
} from '../src/proc/win32.js';
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
  const script = path.join(dir, 'run.sh');
  await fs.writeFile(script, '#!/bin/sh\necho hello-from-script\n');
  await fs.chmod(script, 0o755);

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
  assert.match(Buffer.concat(stderrChunks).toString('utf8'), /No such file|not found|找不到/i);

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
  const makeSpawn = (exitCode, stderr = '') =>
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
