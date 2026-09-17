/**
 * 服务路径解析与启动前检查（平台无关，Mac 可验）。
 *
 * PRD §6：workDir 用 path.resolve 规范化；startScript / logFile 建议绝对路径，
 * 相对路径则相对 workDir 解析。
 */
import path from 'node:path';
import fs from 'node:fs/promises';

/**
 * @param {{ workDir: string, startScript: string, logFile: string }} service
 * @returns {{ workDir: string, scriptPath: string, logPath: string }}
 */
export function resolveServicePaths(service) {
  const workDir = path.resolve(service.workDir);
  const resolveOne = (p) => (path.isAbsolute(p) ? path.normalize(p) : path.resolve(workDir, p));
  return {
    workDir,
    scriptPath: resolveOne(service.startScript),
    logPath: resolveOne(service.logFile),
  };
}

/**
 * 启动前检查：路径不存在时给出比 spawn 报错更明确的提示（PRD §12 首行）。
 * @returns {Promise<{ ok: true } | { ok: false, reason: string, message: string }>}
 */
export async function preflight({ workDir, scriptPath }, { fsImpl = fs } = {}) {
  const statOrNull = async (target) => {
    try {
      return await fsImpl.stat(target);
    } catch (err) {
      return { error: err };
    }
  };

  const workDirStat = await statOrNull(workDir);
  if (workDirStat.error || !workDirStat.isDirectory()) {
    return {
      ok: false,
      reason: 'preflight_workdir_missing',
      message: `工作目录不可用：${workDir}（${workDirStat.error?.message ?? '不是目录'}）`,
    };
  }

  const scriptStat = await statOrNull(scriptPath);
  if (scriptStat.error) {
    return {
      ok: false,
      reason: 'preflight_script_missing',
      message: `启动脚本不可用：${scriptPath}（${scriptStat.error.message}）`,
    };
  }
  if (scriptStat.isDirectory()) {
    return { ok: false, reason: 'preflight_script_not_file', message: `启动脚本路径是一个目录：${scriptPath}` };
  }
  return { ok: true };
}
