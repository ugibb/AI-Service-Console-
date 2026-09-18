/**
 * 服务配置入参校验（系统边界，PRD §6 服务定义模型）。
 *
 * 两条特殊约束：
 * 1. 路径不能含 cmd 元字符：" & | < > ^ —— 因为 startScript 最终经 cmd.exe 执行，
 *    含这些字符的路径会被 cmd 解析为控制符（不是安全问题，自用场景，但会导致启动失败且难排查）。
 * 2. port 不用于探活（PRD §9），但启动前清理会按它结束端口占用进程；因此可选，允许 null。
 */
import { AppError, ERROR_CODES } from './errors.js';

/** 启动宽限期上限：30 分钟（防止误把秒数当毫秒填进来，例如填 60000 秒 = 1000 分钟） */
export const MAX_STARTUP_GRACE_MS = 30 * 60 * 1000;

export const SERVICE_LIMITS = Object.freeze({
  name: 100,
  path: 500,
  portMin: 1,
  portMax: 65535,
  startupGraceMsMin: 0,
  startupGraceMsMax: MAX_STARTUP_GRACE_MS,
});

export const SERVICE_FIELDS = Object.freeze(['name', 'workDir', 'startScript', 'logFile', 'port', 'startupGraceMs']);
export const REQUIRED_FIELDS = Object.freeze(['name', 'workDir', 'startScript', 'logFile']);

/** cmd.exe 无法安全承载的字符（路径会经 cmd 执行） */
const CMD_UNSAFE_PATTERN = /["&|<>^\r\n\0]/;
const CMD_UNSAFE_LABEL = '" & | < > ^';

const FIELD_LABELS = Object.freeze({
  name: '名称',
  workDir: '工作目录',
  startScript: '启动脚本',
  logFile: '日志文件',
  port: '端口',
  startupGraceMs: '启动宽限期',
});

function validateText(value, field, errors) {
  const label = FIELD_LABELS[field];
  if (value === undefined || value === null) {
    errors.push({ field, message: `${label}不能为空` });
    return undefined;
  }
  if (typeof value !== 'string') {
    errors.push({ field, message: `${label}必须是字符串` });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    errors.push({ field, message: `${label}不能为空` });
    return undefined;
  }
  if (trimmed.length > SERVICE_LIMITS.path) {
    errors.push({ field, message: `${label}长度不能超过 ${SERVICE_LIMITS.path} 个字符` });
    return undefined;
  }
  if (CMD_UNSAFE_PATTERN.test(trimmed)) {
    errors.push({ field, message: `${label}不能包含 ${CMD_UNSAFE_LABEL} 等 cmd 特殊字符` });
    return undefined;
  }
  return trimmed;
}

function validateName(value, errors) {
  const label = FIELD_LABELS.name;
  if (typeof value !== 'string') {
    errors.push({ field: 'name', message: `${label}必须是字符串` });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    errors.push({ field: 'name', message: `${label}不能为空` });
    return undefined;
  }
  if (trimmed.length > SERVICE_LIMITS.name) {
    errors.push({ field: 'name', message: `${label}长度不能超过 ${SERVICE_LIMITS.name} 个字符` });
    return undefined;
  }
  return trimmed;
}

function validatePort(value, errors) {
  if (value === undefined || value === null || value === '') return null;
  const num = typeof value === 'string' ? Number(value.trim()) : value;
  if (!Number.isInteger(num) || num < SERVICE_LIMITS.portMin || num > SERVICE_LIMITS.portMax) {
    errors.push({
      field: 'port',
      message: `端口必须是 ${SERVICE_LIMITS.portMin}~${SERVICE_LIMITS.portMax} 之间的整数（选填；填写后用于启动前清理端口占用）`,
    });
    return undefined;
  }
  return num;
}

/**
 * 启动宽限期（毫秒）：可选。留空 → null，表示沿用全局默认（config.proc.startupGraceMs）。
 * 只允许非负整数，并设上限防止误填（把「秒」当「毫秒」写进来是最常见的误填）。
 */
function validateStartupGraceMs(value, errors) {
  if (value === undefined || value === null || value === '') return null;
  const num = typeof value === 'string' ? Number(value.trim()) : value;
  if (!Number.isInteger(num) || num < SERVICE_LIMITS.startupGraceMsMin || num > SERVICE_LIMITS.startupGraceMsMax) {
    errors.push({
      field: 'startupGraceMs',
      message:
        `启动宽限期必须是 ${SERVICE_LIMITS.startupGraceMsMin}~${SERVICE_LIMITS.startupGraceMsMax} 之间的整数毫秒数；` +
        '可留空（沿用全局默认）。AI 服务建议 60000（60 秒）或更大',
    });
    return undefined;
  }
  return num;
}

/**
 * @param {unknown} input
 * @returns {{ ok: true, value: object } | { ok: false, errors: {field:string,message:string}[] }}
 */
export function validateServiceInput(input) {
  const errors = [];
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: [{ field: '_', message: '请求体必须是 JSON 对象' }] };
  }

  const value = {
    name: validateName(input.name, errors),
    workDir: validateText(input.workDir, 'workDir', errors),
    startScript: validateText(input.startScript, 'startScript', errors),
    logFile: validateText(input.logFile, 'logFile', errors),
    port: validatePort(input.port, errors),
    startupGraceMs: validateStartupGraceMs(input.startupGraceMs, errors),
  };

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value };
}

/** 校验失败即抛 AppError（供路由层直接使用） */
export function assertValidServiceInput(input) {
  const result = validateServiceInput(input);
  if (!result.ok) {
    const message = result.errors.map((e) => e.message).join('；');
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, message, { status: 400, details: { errors: result.errors } });
  }
  return result.value;
}
