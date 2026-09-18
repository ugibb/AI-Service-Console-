/**
 * 服务路径解析与启动前检查（平台无关，Mac 可验）。
 *
 * PRD §6：workDir 用 path.resolve 规范化；startScript / logFile 建议绝对路径，
 * 相对路径则相对 workDir 解析。
 *
 * logFile 额外支持 {date} 占位符。有些服务的日志名是按天生成的（inFlow 就是
 * 06-log/YYYY-MM-DD.log），而且那个名字在进程启动那一刻算一次、也没有固定名的
 * 汇总文件 —— 运维要么每天改一遍配置，要么把规律教给控制台。控制台本来就是
 * 替人记这类约定的地方，所以在这里展开。
 *
 * 但「当天」未必是「正在写的那个文件」。跨夜常驻的进程（inFlow worker 就是）
 * 昨天启动、今天还在写昨天的文件，纯粹按当天展开会指到一个不存在的路径。
 * 所以读日志时走 resolveLogPath：当天文件不存在就往前逐天找最近一个存在的。
 */
import path from 'node:path';
import fs from 'node:fs/promises';

/** logFile 中可用的日期占位符。展开为本地日期，形如 2026-09-17 */
export const DATE_PLACEHOLDER = '{date}';

/**
 * 本地日期 → YYYY-MM-DD。
 *
 * 刻意用本地时间而不是 UTC：日志名是服务端自己按本地日期生成的
 * （见 inFlow 的 logger.py，datetime.date.today()），控制台若按 UTC 展开，
 * 在时区偏移的日界前后会差一天 —— 那正是这个占位符要解决的问题本身。
 */
export function formatDateToken(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * 展开 logFile 里的 {date}；不含占位符时原样返回。
 *
 * 只作用于 logFile，不碰 startScript：`start.bat` 写成 `{date}.bat` 意味着
 * 「每天跑不同的程序」，几乎不可能是本意。与其猜，不如让 preflight 老老实实
 * 报「启动脚本不可用」，用户一眼能看出问题。
 */
export function expandLogFileTemplate(logFile, now = new Date()) {
  if (typeof logFile !== 'string' || !logFile.includes(DATE_PLACEHOLDER)) return logFile;
  return logFile.split(DATE_PLACEHOLDER).join(formatDateToken(now));
}

/**
 * @param {{ workDir: string, startScript: string, logFile: string }} service
 * @param {{ now?: Date }} [options] now 只为测试能把「当天」钉死，正常调用不必传
 * @returns {{ workDir: string, scriptPath: string, logPath: string }}
 */
export function resolveServicePaths(service, { now = new Date() } = {}) {
  const workDir = path.resolve(service.workDir);
  const resolveOne = (p) => (path.isAbsolute(p) ? path.normalize(p) : path.resolve(workDir, p));
  return {
    workDir,
    scriptPath: resolveOne(service.startScript),
    logPath: resolveOne(expandLogFileTemplate(service.logFile, now)),
  };
}

/** 回退搜索的天数上限：够覆盖「跨了个周末 / 小长假」的常驻进程，又不至于翻遍整个历史 */
export const MAX_LOG_LOOKBACK_DAYS = 30;

/** 把「基准日往前第 daysAgo 天」代入模板。用 12:00 构造，避开夏令时切换导致的日期漂移 */
function expandDaysAgo(logFile, now, daysAgo) {
  return expandLogFileTemplate(logFile, new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, 12, 0, 0));
}

async function pathExists(target, fsImpl) {
  try {
    await fsImpl.stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * 解析「这次到底该读哪个文件」。
 *
 * 不含 {date} 的 logFile 与 resolveServicePaths 的结果完全一致，一次 stat 都不做。
 * 含 {date} 的：先试当天，不存在就往前逐天找，取第一个存在的。
 * 这样跨夜常驻的进程（昨天启动、今天仍在写昨天的文件）不用等重启就能读到。
 *
 * 一路找不到才放弃，此时返回当天的路径：报错里给出「今天本该有的那个文件」
 * 比给出 30 天前的路径更好排查。
 *
 * 注意只判断「存在」不判断「是不是文件」：当天的路径真配成了目录时，要让它继续
 * 落到 tailFile 的 directory 降级分支上，给出「配置的日志路径是一个目录」这句
 * 明确提示，而不是被这里当成「没找到」而含糊掉。
 */
export async function resolveLogPath(service, { now = new Date(), fsImpl = fs, maxLookbackDays = MAX_LOG_LOOKBACK_DAYS } = {}) {
  const resolveFor = (daysAgo) =>
    resolveServicePaths({ ...service, logFile: expandDaysAgo(service.logFile, now, daysAgo) }, { now }).logPath;

  if (typeof service.logFile !== 'string' || !service.logFile.includes(DATE_PLACEHOLDER)) return resolveFor(0);

  for (let daysAgo = 0; daysAgo <= maxLookbackDays; daysAgo += 1) {
    const candidate = resolveFor(daysAgo);
    if (await pathExists(candidate, fsImpl)) return candidate;
  }
  return resolveFor(0);
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
