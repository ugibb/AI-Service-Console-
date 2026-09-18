/**
 * 把后端打成单文件，供 Electron 外壳内嵌运行。
 *
 * **为什么要打包，而不是把 node_modules 一起塞进 exe**（见方案 §8-R1）：
 * 这是个 npm workspaces 单仓，依赖被提升到根 `node_modules`，而 electron-builder 收集
 * 生产依赖时对「提升布局 + 非根 workspace」的组合支持得很别扭，很容易打出一个
 * 缺 express、一运行就崩的包。打成单文件后产物**不依赖任何 node_modules**，
 * 这个风险就不存在了；顺带包体也小得多。
 *
 * ⚠️ **banner 不是可有可无的**：后端依赖的 `iconv-lite` 会经由 `safer-buffer`
 * 动态 `require('buffer')`。esbuild 输出 ESM 时没有 `require` 可用，运行时会抛
 * `Dynamic require of "buffer" is not supported`。banner 注入一个真的 `require` 解决它。
 * 这条已有验证脚本兜底：`npm run verify:bundle`。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(here, '..');

const outfile = path.join(desktopDir, 'build', 'server.bundle.mjs');

await build({
  entryPoints: [path.join(desktopDir, 'server-entry.mjs')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  // 与 Electron 44 内置的 Node 对齐；同时保证 start.bat（Node 20+）路径也兼容
  target: 'node20',
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);",
  },
  // 打包产物要提交进 exe，不需要 sourcemap 增加体积；排障靠控制台自己的日志文件
  sourcemap: false,
  logLevel: 'info',
});

console.log(`后端已打包：${path.relative(process.cwd(), outfile)}`);
