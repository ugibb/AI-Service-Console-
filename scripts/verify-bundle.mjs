/**
 * 验证「esbuild 单文件打包」的产物能否在**没有 node_modules** 的环境里独立运行。
 *
 * 这不是单测（单测不该起网络服务、不该依赖构建产物），而是一次性的构建验证脚本。
 * 用途：改动了 server 依赖、或升级 esbuild / express / iconv-lite 之后跑一次，
 * 确认打包没把动态 require 打断。
 *
 * 用法：node scripts/verify-bundle.mjs <bundle 路径>
 *
 * 两个必须验到的点，都是「打包器容易悄悄弄坏、而单测发现不了」的：
 *   1. express 的路由能正常响应；
 *   2. iconv-lite 能真的解码 GBK —— 它靠动态 require 加载编码表，
 *      打包成 ESM 后会缺 require（safer-buffer 报 "Dynamic require of buffer"）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const bundlePath = path.resolve(process.argv[2] ?? 'desktop/build/server.bundle.mjs');
if (!fs.existsSync(bundlePath)) {
  console.error(`找不到打包产物：${bundlePath}\n请先执行 npm run build:server-bundle`);
  process.exit(1);
}

const PORT = 3098;
const isoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsc-iso-'));
fs.mkdirSync(path.join(isoDir, 'data'), { recursive: true });
fs.copyFileSync(bundlePath, path.join(isoDir, 'server.bundle.mjs'));

// 造一份 GBK 中文日志：UTF-8 环境下读它必然乱码，能反证 iconv-lite 真的生效了
const iconv = require('iconv-lite');
const logFile = path.join(isoDir, 'data', 'app.log');
fs.writeFileSync(logFile, iconv.encode('服务启动成功\n连接数据库失败：超时\n', 'gbk'));

const base = `http://127.0.0.1:${PORT}`;
const child = spawn(process.execPath, ['server.bundle.mjs'], {
  cwd: isoDir,
  env: { ...process.env, LSC_DATA_DIR: path.join(isoDir, 'data'), LSC_PORT: String(PORT), LSC_HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverOutput = '';
child.stdout.on('data', (d) => (serverOutput += d));
child.stderr.on('data', (d) => (serverOutput += d));

const cleanup = async () => {
  if (child.exitCode === null) {
    const exited = new Promise((r) => child.once('exit', r));
    child.kill();
    // Windows 上「进程已退出」与「目录句柄已释放」之间有一小段延迟，
    // 不等就 rm 会 EBUSY（子进程的 cwd 正指向这个目录）
    await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
  }
  for (let i = 0; i < 10; i += 1) {
    try {
      fs.rmSync(isoDir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
};

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ok  ' : '  FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

const waitForHealth = async () => {
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return await res.json();
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
};

try {
  console.log(`产物：${bundlePath}`);
  console.log(`隔离目录（无 node_modules）：${isoDir}\n`);

  const health = await waitForHealth();
  if (!health) {
    console.error('服务未能启动，产物输出如下：\n' + serverOutput);
    process.exitCode = 1;
    throw new Error('启动失败');
  }
  check('express 在打包产物中可用（/api/health 响应）', health.ok === true, `adapter=${health.data?.adapter}`);

  const created = await fetch(`${base}/api/services`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'GBK 验证',
      workDir: isoDir,
      startScript: path.join(isoDir, 'run.bat'),
      logFile,
    }),
  }).then((r) => r.json());

  if (!created.ok) {
    check('登记服务', false, JSON.stringify(created.error));
    throw new Error('登记失败');
  }
  check('登记服务成功（配置层可用）', true);

  const logs = await fetch(`${base}/api/services/${created.data.id}/logs?tail=10`).then((r) => r.json());
  const lines = logs.data?.lines ?? [];
  const text = lines.join('\n');
  check('iconv-lite 在打包产物中可解码 GBK', text.includes('连接数据库失败：超时'), `encoding=${logs.data?.encoding}`);
  check('日志内容无乱码', !text.includes('�'), lines[0] ?? '');
} catch (err) {
  if (process.exitCode !== 1) {
    console.error(`\n验证过程中出错：${err.message}`);
    process.exitCode = 1;
  }
} finally {
  await cleanup();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
process.exitCode = failed.length === 0 && results.length > 0 ? 0 : 1;
