import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient } from './client.js';

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
  json: async () => body,
});

const okResponse = (data, status = 200) => jsonResponse({ ok: true, data }, status);
const errResponse = (error, status) => jsonResponse({ ok: false, error }, status);

function makeClient(handler) {
  const fetchImpl = vi.fn(handler);
  return { client: createApiClient({ baseUrl: '/api', fetchImpl }), fetchImpl };
}

describe('createApiClient', () => {
  it('默认带 /api 前缀，并解包 { ok, data } 信封', async () => {
    const { client, fetchImpl } = makeClient(async () => okResponse({ services: [{ id: 'a' }] }));
    const data = await client.listServices();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe('/api/services');
    expect(data.services).toEqual([{ id: 'a' }]);
  });

  it('GET 请求不带 body、不带 content-type', async () => {
    const { client, fetchImpl } = makeClient(async () => okResponse({ status: 'ok' }));
    await client.health();
    expect(fetchImpl.mock.calls[0][0]).toBe('/api/health');
    expect(fetchImpl.mock.calls[0][1].method).toBe('GET');
    expect(fetchImpl.mock.calls[0][1].body).toBeUndefined();
  });

  it('logs：拼出 tail 查询参数（服务 id 做 URL 编码）', async () => {
    const { client, fetchImpl } = makeClient(async () => okResponse({ lines: [] }));
    await client.getLogs('a b/c', { tail: 200 });
    expect(fetchImpl.mock.calls[0][0]).toBe('/api/services/a%20b%2Fc/logs?tail=200');
  });

  it('logs：未指定 tail 时不带查询串，交由后端用默认值', async () => {
    const { client, fetchImpl } = makeClient(async () => okResponse({ lines: [] }));
    await client.getLogs('svc-1');
    expect(fetchImpl.mock.calls[0][0]).toBe('/api/services/svc-1/logs');
  });

  it('create：POST + JSON body', async () => {
    const { client, fetchImpl } = makeClient(async () => okResponse({ id: 'new' }, 201));
    const created = await client.createService({ name: '订单服务' });
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ name: '订单服务' });
    expect(created.id).toBe('new');
  });

  it('update / delete / 三种 action 的 method 与路径正确', async () => {
    const { client, fetchImpl } = makeClient(async () => okResponse({ ok: true }));
    await client.updateService('s1', { name: 'x' });
    await client.deleteService('s1');
    await client.startService('s1');
    await client.stopService('s1');
    await client.restartService('s1');
    expect(fetchImpl.mock.calls.map(([url, init]) => `${init.method} ${url}`)).toEqual([
      'PUT /api/services/s1',
      'DELETE /api/services/s1',
      'POST /api/services/s1/start',
      'POST /api/services/s1/stop',
      'POST /api/services/s1/restart',
    ]);
  });

  it('ok:false → 抛 ApiError，带 code / status / details', async () => {
    const { client } = makeClient(async () =>
      errResponse({ code: 'VALIDATION_FAILED', message: '名称不能为空', details: { errors: [{ field: 'name' }] } }, 400),
    );
    await expect(client.createService({})).rejects.toBeInstanceOf(ApiError);
    await expect(client.createService({})).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 400,
      message: '名称不能为空',
      details: { errors: [{ field: 'name' }] },
    });
  });

  it('HTTP 层失败但响应体不可解析 → 抛 ApiError(HTTP_ERROR) 并保留状态码', async () => {
    const { client } = makeClient(async () => ({
      ok: false,
      status: 500,
      text: async () => '<html>500</html>',
      json: async () => {
        throw new Error('not json');
      },
    }));
    await expect(client.listServices()).rejects.toMatchObject({ code: 'HTTP_ERROR', status: 500 });
  });

  it('网络异常 → 抛 ApiError(NETWORK_ERROR)，不把原始异常漏给 UI', async () => {
    const { client } = makeClient(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(client.listServices()).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });

  it('未穷尽的错误码也有可读兜底文案（不会出现 undefined）', async () => {
    const { client } = makeClient(async () => jsonResponse({ ok: false }, 500));
    await expect(client.listServices()).rejects.toMatchObject({ code: 'UNKNOWN_ERROR' });
    await expect(client.listServices()).rejects.toThrow(/请求失败/);
  });
});
