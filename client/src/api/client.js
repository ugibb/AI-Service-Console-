/**
 * REST 封装（T1.10）。
 *
 * 后端统一信封：{ ok: true, data } / { ok: false, error: { code, message, details } }
 * 这一层唯一的职责是「把信封拆开、把失败变成可读的 ApiError」，
 * 组件层不应该再看到 ok 字段或 HTTP 状态码。
 */

export const DEFAULT_BASE_URL = '/api';

const FALLBACK_MESSAGES = Object.freeze({
  NETWORK_ERROR: '无法连接到控制台后端，请确认服务是否在运行',
  HTTP_ERROR: '后端返回了无法解析的响应',
  UNKNOWN_ERROR: '请求失败，请稍后重试',
});

export class ApiError extends Error {
  constructor(message, { code = 'UNKNOWN_ERROR', status = 0, details } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function buildUrl(baseUrl, path, query) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) search.set(key, String(value));
  }
  const qs = search.toString();
  return `${baseUrl}${path}${qs ? `?${qs}` : ''}`;
}

/** 路径段必须编码：服务 id 由后端生成，但不应假设它永远是 URL 安全的 */
const segment = (value) => encodeURIComponent(String(value));

function toApiError(response, payload) {
  const isEnvelope = payload !== null && typeof payload === 'object' && 'ok' in payload;
  const error = (isEnvelope && payload.error) || null;
  const code = error?.code ?? (isEnvelope ? 'UNKNOWN_ERROR' : 'HTTP_ERROR');
  const message = error?.message ?? FALLBACK_MESSAGES[code] ?? FALLBACK_MESSAGES.UNKNOWN_ERROR;
  return new ApiError(message, { code, status: response.status, details: error?.details });
}

export function createApiClient({ baseUrl = DEFAULT_BASE_URL, fetchImpl } = {}) {
  const doFetch = fetchImpl ?? ((url, init) => globalThis.fetch(url, init));

  async function request(path, { method = 'GET', body, query } = {}) {
    const url = buildUrl(baseUrl, path, query);
    let response;
    try {
      response = await doFetch(url, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (cause) {
      throw new ApiError(FALLBACK_MESSAGES.NETWORK_ERROR, {
        code: 'NETWORK_ERROR',
        status: 0,
        details: { cause: String(cause) },
      });
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    const hasEnvelope = payload !== null && typeof payload === 'object' && 'ok' in payload;
    if (!hasEnvelope || payload.ok !== true) throw toApiError(response, payload);

    return payload.data;
  }

  const servicePath = (id) => `/services/${segment(id)}`;

  return {
    request,
    health: () => request('/health'),

    listServices: () => request('/services'),
    getService: (id) => request(servicePath(id)),
    createService: (input) => request('/services', { method: 'POST', body: input }),
    updateService: (id, input) => request(servicePath(id), { method: 'PUT', body: input }),
    deleteService: (id) => request(servicePath(id), { method: 'DELETE' }),

    startService: (id) => request(`${servicePath(id)}/start`, { method: 'POST' }),
    stopService: (id) => request(`${servicePath(id)}/stop`, { method: 'POST' }),
    restartService: (id) => request(`${servicePath(id)}/restart`, { method: 'POST' }),

    getLogs: (id, { tail } = {}) => request(`${servicePath(id)}/logs`, { query: { tail } }),
  };
}
