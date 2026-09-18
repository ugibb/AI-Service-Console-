/**
 * 开发模式启动桌面版。
 *
 * 存在的唯一理由是**主动剔除 `ELECTRON_RUN_AS_NODE`**：
 * 该变量一旦被父进程带进来，`electron.exe` 会退化成纯 Node 运行——
 * 表现是 `import { app } from 'electron'` 全是 undefined，报错却只说
 * 「Cannot read properties of undefined」，很难联想到环境变量。
 * 从 IDE 或别的 Electron 应用里拉起调试时尤其容易踩到。
 *
 * 顺带把 electron 可执行文件的解析收在一处，npm scripts 里不用再关心路径。
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// electron 包在非 Electron 环境下被 require 时，返回的就是可执行文件的绝对路径
const electronPath = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, ['.'], { stdio: 'inherit', cwd: process.cwd(), env });
child.on('exit', (code) => process.exit(code ?? 0));
