/**
 * 测试用临时目录：每个用例一个独立目录，退出时清理。
 * 日志/配置文件一律写在系统临时目录，不污染仓库（data/ 已被 .gitignore 排除，但测试仍不应写它）。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const created = [];

export async function makeTempDir(prefix = 'lsc-test-') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

export async function cleanupTempDirs() {
  await Promise.all(created.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => {})));
}

export async function writeFileIn(dir, name, content) {
  const target = path.join(dir, name);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
  return target;
}
