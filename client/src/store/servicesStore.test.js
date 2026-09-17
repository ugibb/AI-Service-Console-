import { describe, expect, it, vi } from 'vitest';
import { createServicesStore } from './servicesStore.js';

const service = (over = {}) => ({
  id: 's1',
  name: '订单服务',
  workDir: 'C:\\svc',
  startScript: 'C:\\svc\\start.bat',
  logFile: 'C:\\svc\\app.log',
  port: 8081,
  status: 'stopped',
  pid: null,
  exitCode: null,
  ...over,
});

function makeApi(over = {}) {
  return {
    listServices: vi.fn(async () => ({
      services: [service()],
      warnings: [],
      poll: { logsMs: 1000, servicesMs: 1500 },
    })),
    createService: vi.fn(async (input) => service({ id: 'new', ...input })),
    updateService: vi.fn(async (id, input) => service({ id, ...input })),
    deleteService: vi.fn(async () => ({ removed: true })),
    startService: vi.fn(async (id) => ({ action: { name: 'start' }, service: service({ id, status: 'running', pid: 111 }) })),
    stopService: vi.fn(async (id) => ({ action: { name: 'stop' }, service: service({ id, status: 'stopped' }) })),
    restartService: vi.fn(async (id) => ({ action: { name: 'restart' }, service: service({ id, status: 'running', pid: 222 }) })),
    ...over,
  };
}

describe('servicesStore', () => {
  it('初始状态：空列表、未加载、无错误', () => {
    const store = createServicesStore({ api: makeApi() });
    expect(store.getState()).toMatchObject({ services: [], loaded: false, loading: false, error: null, pending: {} });
  });

  it('load：写入列表、告警与轮询节奏', async () => {
    const store = createServicesStore({ api: makeApi() });
    await store.load();
    const state = store.getState();
    expect(state.loaded).toBe(true);
    expect(state.loading).toBe(false);
    expect(state.services).toHaveLength(1);
    expect(state.poll).toEqual({ logsMs: 1000, servicesMs: 1500 });
    expect(typeof state.lastUpdatedAt).toBe('number');
  });

  it('load：已加载后的轮询刷新不把 loading 置回 true（避免整页闪 loading）', async () => {
    const store = createServicesStore({ api: makeApi() });
    await store.load();
    const seen = [];
    store.subscribe((s) => seen.push(s.loading));
    await store.load();
    expect(seen).toEqual([false]);
  });

  it('load 失败：记录 error，已加载的列表不被清空（保留上一次可用数据）', async () => {
    const api = makeApi();
    const store = createServicesStore({ api });
    await store.load();
    api.listServices.mockRejectedValueOnce(Object.assign(new Error('接口挂了'), { code: 'NETWORK_ERROR' }));

    await store.load();
    expect(store.getState().error).toMatchObject({ message: '接口挂了', code: 'NETWORK_ERROR' });
    expect(store.getState().services).toHaveLength(1);
  });

  it('subscribe：状态变化被通知，退订后不再通知', async () => {
    const store = createServicesStore({ api: makeApi() });
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    await store.load();
    expect(listener).toHaveBeenCalled();

    unsubscribe();
    const before = listener.mock.calls.length;
    await store.load();
    expect(listener.mock.calls.length).toBe(before);
  });

  it('start：pending 标记执行中 → 完成后清除，并把服务端返回的最新状态合并进列表', async () => {
    let release;
    const api = makeApi({
      startService: vi.fn(() => new Promise((resolve) => {
        release = () => resolve({ action: { name: 'start' }, service: service({ status: 'running', pid: 111 }) });
      })),
    });
    const store = createServicesStore({ api });
    await store.load();

    const pending = store.start('s1');
    expect(store.getState().pending.s1).toBe('start');
    release();
    await pending;

    expect(store.getState().pending.s1).toBeUndefined();
    expect(store.getState().services[0]).toMatchObject({ status: 'running', pid: 111 });
  });

  it('start 失败：记录 error、清除 pending、列表保持原状', async () => {
    const api = makeApi();
    const store = createServicesStore({ api });
    await store.load();
    api.startService.mockRejectedValueOnce(Object.assign(new Error('启动失败：ENOENT'), { code: 'SPAWN_FAILED' }));

    await store.start('s1');
    expect(store.getState().pending.s1).toBeUndefined();
    expect(store.getState().error).toMatchObject({ code: 'SPAWN_FAILED' });
    expect(store.getState().services[0].status).toBe('stopped');
  });

  it('stop / restart：调用对应接口并合并结果', async () => {
    const api = makeApi();
    const store = createServicesStore({ api });
    await store.load();
    await store.stop('s1');
    expect(api.stopService).toHaveBeenCalledWith('s1');
    await store.restart('s1');
    expect(api.restartService).toHaveBeenCalledWith('s1');
    expect(store.getState().services[0]).toMatchObject({ status: 'running', pid: 222 });
  });

  it('save：无 id → 新增；有 id → 编辑；两者都会刷新列表', async () => {
    const api = makeApi();
    const store = createServicesStore({ api });
    await store.load();

    await store.save({ name: '新服务' });
    expect(api.createService).toHaveBeenCalledWith({ name: '新服务' });

    await store.save({ name: '改名' }, 's1');
    expect(api.updateService).toHaveBeenCalledWith('s1', { name: '改名' });

    expect(api.listServices.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('remove：删除后本地列表同步移除', async () => {
    const api = makeApi({
      listServices: vi.fn()
        .mockResolvedValueOnce({ services: [service(), service({ id: 's2' })], warnings: [], poll: { logsMs: 1000, servicesMs: 1500 } })
        .mockResolvedValue({ services: [service({ id: 's2' })], warnings: [], poll: { logsMs: 1000, servicesMs: 1500 } }),
    });
    const store = createServicesStore({ api });
    await store.load();
    await store.remove('s1');
    expect(api.deleteService).toHaveBeenCalledWith('s1');
    expect(store.getState().services.map((s) => s.id)).toEqual(['s2']);
  });

  it('clearError：清掉错误横幅', async () => {
    const api = makeApi();
    const store = createServicesStore({ api });
    api.listServices.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'E' }));
    await store.load();
    expect(store.getState().error).toBeTruthy();
    store.clearError();
    expect(store.getState().error).toBeNull();
  });

  it('getState 返回快照，外部改动不影响内部状态', async () => {
    const store = createServicesStore({ api: makeApi() });
    await store.load();
    store.getState().services.pop();
    expect(store.getState().services).toHaveLength(1);
  });

  it('getService：按 id 取单个服务，不存在返回 null', async () => {
    const store = createServicesStore({ api: makeApi() });
    await store.load();
    expect(store.getService('s1').name).toBe('订单服务');
    expect(store.getService('nope')).toBeNull();
  });
});
