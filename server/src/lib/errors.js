/**
 * 统一错误类型与错误码。
 *
 * 所有对外暴露的错误都走 AppError：带 HTTP status + 机器可读 code + 用户可读 message。
 * 非 AppError 的异常一律在错误中间件里降级为 INTERNAL_ERROR，不泄漏堆栈。
 */
export class AppError extends Error {
  /**
   * @param {string} code 机器可读错误码（见 ERROR_CODES）
   * @param {string} message 用户可读信息（中文，直接展示给运维者）
   * @param {{ status?: number, details?: unknown, cause?: Error }} [options]
   */
  constructor(code, message, { status = 500, details, cause } = {}) {
    super(message, { cause });
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
    this.expose = true;
  }
}

export const ERROR_CODES = Object.freeze({
  SERVICE_NOT_FOUND: 'SERVICE_NOT_FOUND',
  SERVICE_BUSY: 'SERVICE_BUSY',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  CONFLICT: 'CONFLICT',
  CONFIG_CORRUPT: 'CONFIG_CORRUPT',
  LOG_PATH_MISSING: 'LOG_PATH_MISSING',
  LOG_PATH_IS_DIRECTORY: 'LOG_PATH_IS_DIRECTORY',
  LOG_PERMISSION_DENIED: 'LOG_PERMISSION_DENIED',
  LOG_READ_FAILED: 'LOG_READ_FAILED',
  SPAWN_FAILED: 'SPAWN_FAILED',
  KILL_FAILED: 'KILL_FAILED',
  ADAPTER_UNSUPPORTED: 'ADAPTER_UNSUPPORTED',
  NOT_FOUND: 'NOT_FOUND',
  BAD_REQUEST: 'BAD_REQUEST',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
});

export function serviceNotFound(id) {
  return new AppError(ERROR_CODES.SERVICE_NOT_FOUND, `服务不存在或已被删除（id=${id}）`, { status: 404 });
}

export function serviceBusy(id, status) {
  const label = { starting: '正在启动中', stopping: '正在停止中', running: '正在运行中' }[status] || status;
  return new AppError(ERROR_CODES.SERVICE_BUSY, `服务当前${label}，请稍后再试`, { status: 409, details: { id, status } });
}

export function validationFailed(errors) {
  const message = errors.map((e) => e.message).join('；') || '参数校验失败';
  return new AppError(ERROR_CODES.VALIDATION_FAILED, message, { status: 400, details: { errors } });
}
