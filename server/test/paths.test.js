import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  DATE_PLACEHOLDER,
  expandLogFileTemplate,
  formatDateToken,
  preflight,
  resolveLogPath,
  resolveServicePaths,
} from '../src/services/paths.js';
import { cleanupTempDirs, makeTempDir } from '../testkit/tmp.js';

after(cleanupTempDirs);

/** 本地时间构造，避免 UTC 解析把日期挪走一天（new Date('2026-09-17') 是 UTC 午夜） */
const localDate = (y, m, d) => new Date(y, m - 1, d, 12, 0, 0);

/** 假的 fs：只有 existing 里列出的路径 stat 成功；同时记下被问过哪些路径 */
function fakeFs(existing = []) {
  const set = new Set(existing);
  const seen = [];
  return {
    seen,
    stat: async (target) => {
      seen.push(target);
      if (set.has(target)) return { isFile: () => true };
      const err = new Error(`ENOENT: no such file or directory, stat '${target}'`);
      err.code = 'ENOENT';
      throw err;
    },
  };
}

const INFLOW = { workDir: '/srv/inflow', startScript: '/srv/inflow/start.bat' };
const dayPath = (dateStr) => path.resolve(INFLOW.workDir, `06-log/${dateStr}.log`);

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

test('formatDateToken：本地日期补零成 YYYY-MM-DD', () => {
  assert.equal(formatDateToken(localDate(2026, 9, 17)), '2026-09-17');
  assert.equal(formatDateToken(localDate(2026, 1, 5)), '2026-01-05', '个位数月/日要补零');
  assert.equal(formatDateToken(localDate(2026, 12, 31)), '2026-12-31');
});

test('formatDateToken：按本地日期算，不按 UTC', () => {
  // 本地 1 月 1 日 00:30 —— 东八区此时 UTC 还停在 12 月 31 日。
  // 日志名是服务端按本地时钟起的，控制台必须跟着本地走，否则跨年那天会差一整年。
  const newYearEve = new Date(2027, 0, 1, 0, 30, 0);
  assert.equal(formatDateToken(newYearEve), '2027-01-01');
});

test('expandLogFileTemplate：{date} 展开为当天，其余部分不动', () => {
  const now = localDate(2026, 9, 17);
  assert.equal(expandLogFileTemplate('06-log/{date}.log', now), '06-log/2026-09-17.log');
  assert.equal(expandLogFileTemplate('C:\\svc\\logs\\{date}.log', now), 'C:\\svc\\logs\\2026-09-17.log');
  assert.equal(expandLogFileTemplate(DATE_PLACEHOLDER, now), '2026-09-17');
});

test('expandLogFileTemplate：没有占位符时原样返回（固定名日志不受影响）', () => {
  const now = localDate(2026, 9, 17);
  assert.equal(expandLogFileTemplate('C:\\svc\\app.log', now), 'C:\\svc\\app.log');
  assert.equal(expandLogFileTemplate('C:\\svc\\{date}\\app.log', now), 'C:\\svc\\2026-09-17\\app.log');
});

test('expandLogFileTemplate：多处出现全部展开', () => {
  const now = localDate(2026, 9, 17);
  assert.equal(expandLogFileTemplate('logs/{date}/app-{date}.log', now), 'logs/2026-09-17/app-2026-09-17.log');
});

test('resolveServicePaths：logFile 含 {date} 时展开后再解析相对路径', () => {
  const now = localDate(2026, 9, 17);
  const resolved = resolveServicePaths(
    { workDir: '/srv/inflow', startScript: '/srv/inflow/start.bat', logFile: '06-log/{date}.log' },
    { now },
  );
  assert.equal(resolved.logPath, path.resolve('/srv/inflow/06-log/2026-09-17.log'));
});

test('resolveServicePaths：startScript 里的 {date} 不展开（避免「每天跑不同脚本」）', () => {
  const now = localDate(2026, 9, 17);
  const resolved = resolveServicePaths({ workDir: '/srv/svc', startScript: 'start-{date}.bat', logFile: 'app.log' }, { now });
  assert.equal(resolved.scriptPath, path.resolve('/srv/svc/start-{date}.bat'));
  assert.equal(resolved.logPath, path.resolve('/srv/svc/app.log'), '不含占位符的 logFile 保持原样');
});

test('resolveLogPath：不含 {date} 时等同于 resolveServicePaths，且完全不碰文件系统', async () => {
  const fsImpl = fakeFs([]);
  const target = await resolveLogPath({ ...INFLOW, logFile: 'app.log' }, { now: localDate(2026, 9, 17), fsImpl });
  assert.equal(target, path.resolve(INFLOW.workDir, 'app.log'));
  assert.deepEqual(fsImpl.seen, [], '固定名日志不该因为回退逻辑多出 stat 开销（1 秒轮询一次）');
});

test('resolveLogPath：当天文件存在 → 就是当天，不做多余探查', async () => {
  const fsImpl = fakeFs([dayPath('2026-09-17')]);
  const target = await resolveLogPath({ ...INFLOW, logFile: '06-log/{date}.log' }, { now: localDate(2026, 9, 17), fsImpl });
  assert.equal(target, dayPath('2026-09-17'));
  assert.equal(fsImpl.seen.length, 1, '第一个候选命中就该停');
});

test('resolveLogPath：当天不存在、昨天存在 → 回退到昨天（跨夜常驻的进程）', async () => {
  // 这就是 inFlow 的实际处境：worker 昨天启动，今天还在写昨天那个文件
  const fsImpl = fakeFs([dayPath('2026-09-16')]);
  const target = await resolveLogPath({ ...INFLOW, logFile: '06-log/{date}.log' }, { now: localDate(2026, 9, 17), fsImpl });
  assert.equal(target, dayPath('2026-09-16'));
});

test('resolveLogPath：中间几天缺失 → 取最近的一个，而不是找到就停', async () => {
  const fsImpl = fakeFs([dayPath('2026-09-14'), dayPath('2026-09-11')]);
  const target = await resolveLogPath({ ...INFLOW, logFile: '06-log/{date}.log' }, { now: localDate(2026, 9, 17), fsImpl });
  assert.equal(target, dayPath('2026-09-14'), '14 号比 11 号新，必须选 14 号');
});

test('resolveLogPath：回退跨越月份与年份仍算对', async () => {
  const fsImpl = fakeFs([dayPath('2025-12-31')]);
  const target = await resolveLogPath({ ...INFLOW, logFile: '06-log/{date}.log' }, { now: localDate(2026, 1, 2), fsImpl });
  assert.equal(target, dayPath('2025-12-31'));
});

test('resolveLogPath：整个回退窗口内都没有 → 返回当天路径（报错要指向「今天本该有的文件」）', async () => {
  const fsImpl = fakeFs([]);
  const target = await resolveLogPath({ ...INFLOW, logFile: '06-log/{date}.log' }, { now: localDate(2026, 9, 17), fsImpl });
  assert.equal(target, dayPath('2026-09-17'));
});

test('resolveLogPath：maxLookbackDays 是回退窗口的上界', async () => {
  const only = dayPath('2026-09-07'); // 距今 10 天
  const within = await resolveLogPath(
    { ...INFLOW, logFile: '06-log/{date}.log' },
    { now: localDate(2026, 9, 17), fsImpl: fakeFs([only]), maxLookbackDays: 10 },
  );
  assert.equal(within, only);

  const beyond = await resolveLogPath(
    { ...INFLOW, logFile: '06-log/{date}.log' },
    { now: localDate(2026, 9, 17), fsImpl: fakeFs([only]), maxLookbackDays: 9 },
  );
  assert.equal(beyond, dayPath('2026-09-17'), '窗口是 9 天时第 10 天那个文件不该被翻到');
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
