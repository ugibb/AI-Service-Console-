/**
 * 统一响应信封（ROUTES 层唯一出口）：
 *   成功 → { ok: true, data: ... }
 *   失败 → { ok: false, error: { code, message, details? } }
 */
export function sendOk(res, data, status = 200) {
  return res.status(status).json({ ok: true, data });
}

export function errorBody(err) {
  return {
    ok: false,
    error: {
      code: err.code ?? 'INTERNAL_ERROR',
      message: err.message ?? '服务器内部错误',
      ...(err.details === undefined ? {} : { details: err.details }),
    },
  };
}
