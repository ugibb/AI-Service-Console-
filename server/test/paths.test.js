import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { preflight, resolveServicePaths } from '../src/services/paths.js';
import { cleanupTempDirs, makeTempDir } from '../testkit/tmp.js';

after(cleanupTempDirs);

test('resolveServicePaths：绝对路径原样规范化，相对路径相对 workDir 解析', () => {
  const resolved = resolveServicePaths({
    workDir: '/srv/order',
    startScript: '/srv/order/start.bat',
    logFile: 'logs/app.log',
  });
  assert.equal(resolved.workDir, path.resolve('/srv/order'));
  assert.equal(resolved.scriptPath, path.normalize('/srv/order/start.bat'));
  assert.equal(resolved.logPath, path.resolve('/srv/order/logs/app.log'));
});

test('resolveServicePaths：Windows 风格路径在 path.win32 语义下也成立（模拟）', () => {
  // 在 macOS 上 path 是 posix，这里只验证「反斜杠不会被当作目录分隔符」这一常见误解不会发生：
  // 真实 Windows 行为需在 Windows 上验证（见 README 验证清单）。
  const resolved = resolveServicePaths({
    workDir: 'C:\\services\\order',
    startScript: 'start.bat',
    logFile: 'logs\\app.log',
  });
  assert.equal(resolved.workDir, path.resolve('C:\\services\\order'));
  assert.ok(resolved.scriptPath.endsWith('start.bat'));
});

test('preflight：工作目录与脚本都存在 → ok', async () => {
  const dir = await makeTempDir();
  const script = path.join(dir, 'start.bat');
  await fs.writeFile(script, '@echo off\n');
  assert.deepEqual(await preflight({ workDir: dir, scriptPath: script }), { ok: true });
});

test('preflight：工作目录不存在 → 明确原因（不交给 spawn 报错）', async () => {
  const dir = await makeTempDir();
  const script = path.join(dir, 'start.bat');
  await fs.writeFile(script, '@echo off\n');
  const result = await preflight({ workDir: path.join(dir, 'nope'), scriptPath: script });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'preflight_workdir_missing');
  assert.match(result.message, /工作目录不可用/);
});

test('preflight：脚本不存在 → 明确原因', async () => {
  const dir = await makeTempDir();
  const result = await preflight({ workDir: dir, scriptPath: path.join(dir, 'missing.bat') });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'preflight_script_missing');
  assert.match(result.message, /启动脚本不可用/);
});

test('preflight：脚本路径指向目录 → 明确原因', async () => {
  const dir = await makeTempDir();
  const asDir = path.join(dir, 'start.bat');
  await fs.mkdir(asDir);
  const result = await preflight({ workDir: dir, scriptPath: asDir });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'preflight_script_not_file');
});
