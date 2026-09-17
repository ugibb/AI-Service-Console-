/**
 * 前端状态管理（T1.12）——刻意不引入 Redux/Zustand。
 *
 * 单用户、本机、服务数量少：一个「不可变状态 + 订阅」的小 store 就够，
 * 且能在没有 React 的环境里直接单测（状态机逻辑才是真正容易写错的部分）。
 *
 * 状态不缓存任何从服务端可推导的东西：`services` 永远是最近一次服务端返回的副本。
 */

const DEFAULT_POLL = Object.freeze({ logsMs: 1000, servicesMs: 1500 });

const createInitialState = () => ({
  services: [],
  warnings: [],
  poll: DEFAULT_POLL,
  loaded: false,
  loading: false,
  error: null,
  /** { [serviceId]: 'start' | 'stop' | 'restart' } */
  pending: {},
  lastUpdatedAt: null,
});

function toPlainError(error) {
  return {
    message: error?.message ?? '操作失败，请重试',
    code: error?.code ?? 'UNKNOWN_ERROR',
  };
}

export function createServicesStore({ api }) {
  let state = createInitialState();
  const listeners = new Set();

  /** 对外返回防御性副本，外部改快照不会污染 store 内部 */
  const getState = () => ({
    ...state,
    services: [...state.services],
    warnings: [...state.warnings],
    pending: { ...state.pending },
  });

  const commit = (patch) => {
    state = { ...state, ...patch };
    for (const listener of listeners) {
      try {
        listener(state);
      } catch {
        // 监听器（UI）自己的异常不该影响数据流
      }
    }
  };

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  /** 用服务端返回的最新对象替换列表里的同 id 条目；不存在则追加 */
  function mergeService(service) {
    if (!service?.id) return;
    const index = state.services.findIndex((item) => item.id === service.id);
    if (index === -1) {
      commit({ services: [...state.services, service] });
      return;
    }
    const next = state.services.slice();
    next[index] = service;
    commit({ services: next });
  }

  function markPending(id, action) {
    commit({ pending: { ...state.pending, [id]: action } });
  }

  function clearPending(id) {
    const next = { ...state.pending };
    delete next[id];
    commit({ pending: next });
  }

  async function load() {
    if (!state.loaded) commit({ loading: true });
    try {
      const data = await api.listServices();
      commit({
        services: Array.isArray(data?.services) ? data.services : [],
        warnings: Array.isArray(data?.warnings) ? data.warnings : [],
        poll: data?.poll ?? state.poll,
        loaded: true,
        loading: false,
        error: null,
        lastUpdatedAt: Date.now(),
      });
      return data;
    } catch (error) {
      // 失败不清空 services：保留上一次可用数据比清屏更有用
      commit({ loading: false, error: toPlainError(error) });
      return undefined;
    }
  }

  async function runAction(id, action, call) {
    markPending(id, action);
    try {
      const result = await call(id);
      if (result?.service) mergeService(result.service);
      commit({ error: null });
      return result;
    } catch (error) {
      commit({ error: toPlainError(error) });
      return undefined;
    } finally {
      clearPending(id);
    }
  }

  async function save(input, id) {
    try {
      const saved = id ? await api.updateService(id, input) : await api.createService(input);
      commit({ error: null });
      await load();
      return saved;
    } catch (error) {
      commit({ error: toPlainError(error) });
      return undefined;
    }
  }

  async function remove(id) {
    try {
      await api.deleteService(id);
      commit({ services: state.services.filter((item) => item.id !== id), error: null });
      await load();
      return true;
    } catch (error) {
      commit({ error: toPlainError(error) });
      return false;
    }
  }

  /** 详情接口带启动诊断，列表接口不带；失败态时按需补齐 */
  async function hydrateDiagnostics(id) {
    if (typeof api.getService !== 'function') return undefined;
    try {
      const detail = await api.getService(id);
      mergeService(detail);
      return detail;
    } catch {
      return undefined;
    }
  }

  return {
    getState,
    subscribe,
    load,
    refresh: load,
    start: (id) => runAction(id, 'start', api.startService),
    stop: (id) => runAction(id, 'stop', api.stopService),
    restart: (id) => runAction(id, 'restart', api.restartService),
    save,
    remove,
    hydrateDiagnostics,
    mergeService,
    getService: (id) => state.services.find((item) => item.id === id) ?? null,
    clearError: () => commit({ error: null }),
  };
}

export const FAILED_STATUSES = Object.freeze(['error', 'start_failed']);
