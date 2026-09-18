/**
 * 桌面外壳与后端之间的**唯一接缝**。
 *
 * 外壳只认这个文件，不直接深入 `server/src/` 的内部路径——这样后端重构目录结构时，
 * 要改的地方永远只有这一处。
 *
 * 它同时是 esbuild 打包的入口（见 `scripts/build-bundle.mjs`）。
 */
export { loadConfig } from '../server/src/config.js';
export { bootstrap, createConsoleLogger } from '../server/src/index.js';
