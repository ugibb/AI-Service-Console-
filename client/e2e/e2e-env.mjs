/**
 * E2E 共用路径与端口（config / webServer / spec 三处必须一致，故集中在这里）。
 *
 * 用固定目录而非随机目录：Playwright 的 config、webServer 子进程、测试 worker
 * 是三个不同的进程，随机目录无法在它们之间传递。
 */
import os from 'node:os';
import path from 'node:path';

export const E2E_PORT = Number(process.env.E2E_PORT || 3199);
export const E2E_ROOT = path.join(os.tmpdir(), 'lsc-e2e-root');

export const DATA_DIR = path.join(E2E_ROOT, 'data');
export const WORK_DIR = path.join(E2E_ROOT, 'svc');
/** 真实存在的启动脚本（E2E 服务端会创建它，preflight 需要文件存在） */
export const SCRIPT = path.join(WORK_DIR, 'run.bat');
/** 不存在的脚本：用于「启动失败诊断」用例 */
export const MISSING_SCRIPT = path.join(WORK_DIR, 'not-here.bat');
/** 服务自写的日志文件；测试直接往这里追加内容来验证 1s 刷新 */
export const LOG_FILE = path.join(WORK_DIR, 'app.log');
