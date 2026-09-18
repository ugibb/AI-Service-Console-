#!/usr/bin/env node
/**
 * 开发模式并行启动：后端（开发档，3011，只出 API）+ 前端 Vite dev server (5173)。
 *
 * 端口与「是否托管前端构建产物」由环境档案决定，定义处是 server/src/profiles.js——
 * 后端子进程靠 server/package.json 的 dev 脚本带上 `--env=development`。
 * 仅用于开发/调试，生产运行请用根目录 start.bat（或 npm start，生产档 3010）。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';
const npmCmd = isWindows ? 'npm.cmd' : 'npm';

const targets = [
  { label: 'server', args: ['run', 'dev', '--workspace', 'server'] },
  { label: 'client', args: ['run', 'dev', '--workspace', 'client'] },
];

const children = [];
let exitCode = 0;

function shutdown(code = 0) {
  exitCode = code;
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
}

for (const target of targets) {
  const child = spawn(npmCmd, target.args, {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    /*
     * Windows 上必须走 shell：Node ≥20.12 为修 CVE-2024-27980 不再允许直接 spawn `.cmd`/`.bat`，
     * 不带 shell 就是 `spawn EINVAL`（整条 `npm run dev` 直接挂掉）。这里的 args 都是
     * 固定字面量、不含需要引号的字符，交给 cmd.exe 拼是安全的。
     */
    shell: isWindows,
  });
  children.push(child);

  const prefix = `[${target.label}]`;
  const pipe = (stream, sink) => {
    stream.setEncoding('utf8');
    let pending = '';
    stream.on('data', (chunk) => {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) sink.write(`${prefix} ${line}\n`);
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);

  child.on('exit', (code, signal) => {
    process.stdout.write(`${prefix} 退出 (code=${code} signal=${signal})\n`);
    shutdown(code ?? 0);
  });
  child.on('error', (err) => {
    process.stderr.write(`${prefix} 启动失败: ${err.message}\n`);
    shutdown(1);
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(0));
}
process.on('exit', () => {
  process.exitCode = exitCode;
});
