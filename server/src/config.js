/**
 * 全站配置集中点。
 *
 * 设计约束：
 * - 不硬编码密钥 / 机器相关绝对路径：所有路径由 PROJECT_ROOT 推导，可用环境变量覆盖。
 * - 纯函数 loadConfig(env) 便于测试注入不同环境（测试不污染真实 process.env）。
 *
 * 环境变量清单见 README.md「配置」一节。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_STARTUP_GRACE_MS } from './lib/validate.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** server/ 目录 */
export const SERVER_ROOT = path.resolve(here, '..');
/** 仓库根目录 */
export const PROJECT_ROOT = path.resolve(SERVER_ROOT, '..');

/** 进程适配器取值：win32 = Windows 真实实现；unsupported = 非 Windows 占位（M2 才做 posix 实现） */
export const PROC_ADAPTERS = Object.freeze(['win32', 'unsupported']);

const DEFAULT_TAIL_LINES = 500;
const MAX_TAIL_LINES = 20000;

function readInt(env, key, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER, warnings } = {}) {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    warnings?.push(`环境变量 ${key}="${raw}" 不是合法整数（范围 ${min}~${max}），已回退默认值 ${fallback}`);
    return fallback;
  }
  return value;
}

function readEnum(env, key, allowed, fallback, warnings) {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  if (!allowed.includes(raw)) {
    warnings.push(`环境变量 ${key}="${raw}" 不在允许值 [${allowed.join(', ')}] 内，已回退默认值 ${fallback}`);
    return fallback;
  }
  return raw;
}

/**
 * @param {Record<string, string|undefined>} env
 * @returns {Readonly<object>} 冻结的配置对象 + warnings 数组
 */
export function loadConfig(env = process.env) {
  const warnings = [];

  const port = readInt(env, 'LSC_PORT', 3010, { min: 1, max: 65535, warnings });
  const host = env.LSC_HOST?.trim() || '127.0.0.1';
  const dataDir = env.LSC_DATA_DIR?.trim() ? path.resolve(env.LSC_DATA_DIR.trim()) : path.join(PROJECT_ROOT, 'data');

  const defaultTailLines = readInt(env, 'LSC_LOG_TAIL_LINES', DEFAULT_TAIL_LINES, {
    min: 1,
    max: MAX_TAIL_LINES,
    warnings,
  });

  const adapter = readEnum(env, 'LSC_PROC_ADAPTER', PROC_ADAPTERS, 'win32', warnings);

  const config = {
    port,
    host,
    nodeEnv: env.NODE_ENV || 'development',
    adapter,

    dataDir,
    servicesFile: path.join(dataDir, 'services.json'),
    corruptBackupDir: path.join(dataDir, 'corrupt'),

    /** 生产模式托管前端构建产物 */
    clientDistDir: path.resolve(env.LSC_CLIENT_DIST?.trim() || path.join(PROJECT_ROOT, 'client', 'dist')),
    serveClient: env.LSC_SERVE_CLIENT !== '0',

    /** 日志 tail 读取参数 */
    log: {
      defaultTailLines,
      maxTailLines: MAX_TAIL_LINES,
      /** 反向读块大小：64KB */
      chunkSize: readInt(env, 'LSC_LOG_CHUNK_SIZE', 64 * 1024, { min: 1024, max: 8 * 1024 * 1024, warnings }),
      /** 单行超长阈值：超过则截断，避免异常日志拖垮前端 */
      maxLineBytes: readInt(env, 'LSC_LOG_MAX_LINE_BYTES', 1024 * 1024, { min: 4096, max: 64 * 1024 * 1024, warnings }),
      /** 首选编码；解码出现替换字符时回退 fallbackEncoding */
      preferredEncoding: 'utf8',
      fallbackEncoding: 'gbk',
    },

    /** 进程生命周期参数 */
    proc: {
      /** spawn 成功后的存活校验延迟（防御「启动即退出」型 .bat，见 PRD §7.3） */
      startVerifyDelayMs: readInt(env, 'LSC_START_VERIFY_DELAY_MS', 800, { min: 50, max: 30000, warnings }),
      /**
       * 启动宽限期默认值（毫秒）：服务未单独配置 startupGraceMs 时用它。
       *
       * 宽限期内进程存活 → 状态为 starting（UI 显示「启动中」+ 已启动时长）；
       * 宽限期结束仍存活 → running。宽限期内退出 → start_failed；宽限期后退出 → error。
       * AI / LLM 服务加载模型要几十秒到几分钟，应在服务上单独设大（如 60000）。
       */
      startupGraceMs: readInt(env, 'LSC_STARTUP_GRACE_MS', 5000, { min: 0, max: MAX_STARTUP_GRACE_MS, warnings }),
      /**
       * 启动失败判定窗口：**仅在服务未启用宽限期（startupGraceMs 为 0/缺省且全局宽限期为 0）时生效**，
       * 作为「窗口内退出即视为启动失败（含退出码 0）」的兜底判定。
       */
      startFailureWindowMs: readInt(env, 'LSC_START_FAILURE_WINDOW_MS', 5000, { min: 100, max: 120000, warnings }),
      /** 停止宽限：先 taskkill /T，等待该时长未退出则 /T /F 强杀 */
      stopGraceTimeoutMs: readInt(env, 'LSC_STOP_GRACE_MS', 5000, { min: 100, max: 120000, warnings }),
      /** 等待期间轮询间隔 */
      exitPollIntervalMs: readInt(env, 'LSC_EXIT_POLL_MS', 200, { min: 20, max: 5000, warnings }),
      /** 启动诊断环形缓冲行数（仅启动失败诊断用，不作实时日志） */
      diagBufferLines: readInt(env, 'LSC_DIAG_BUFFER_LINES', 200, { min: 10, max: 5000, warnings }),
    },

    /** 前端轮询间隔（由 /api/health 下发给前端，便于统一调整） */
    poll: {
      logsMs: readInt(env, 'LSC_POLL_LOGS_MS', 1000, { min: 200, max: 60000, warnings }),
      servicesMs: readInt(env, 'LSC_POLL_SERVICES_MS', 1500, { min: 200, max: 60000, warnings }),
    },

    jsonBodyLimit: '256kb',
    warnings,
  };

  return Object.freeze({
    ...config,
    log: Object.freeze(config.log),
    proc: Object.freeze(config.proc),
    poll: Object.freeze(config.poll),
  });
}

/** 默认实例：从真实 process.env 读取 */
export const config = loadConfig();
