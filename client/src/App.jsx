import { useCallback, useEffect, useMemo, useState } from 'react';
import { createApiClient } from './api/client.js';
import { usePolling } from './hooks/usePolling.js';
import { FAILED_STATUSES, createServicesStore } from './store/servicesStore.js';
import { useStoreState } from './store/useStoreState.js';
import { ServiceList } from './components/ServiceList/ServiceList.jsx';
import { ServiceForm } from './components/ServiceForm/ServiceForm.jsx';
import { LogViewer } from './components/LogViewer/LogViewer.jsx';
import './App.css';

const FALLBACK_API = createApiClient();

/**
 * 应用组装（T1.17）。
 *
 * 视图结构刻意只有两段：上「正在看的东西」（日志 / 编辑表单），下「纳管的服务」。
 * 日志在上并占满整幅宽度——看日志是这台控制台的主任务，横向留白越少每行装得越多；
 * 卡片在下横向排布，数量超出容器时左右滑动，不再挤压日志区。
 * 单用户 + 少服务，路由和多页切换是多余的复杂度。
 */
export function App({ api = FALLBACK_API, store, servicesPollMs = 1500, logsPollMs = 1000 }) {
  const [fallbackStore] = useState(() => (store ? null : createServicesStore({ api })));
  const servicesStore = store ?? fallbackStore;
  const state = useStoreState(servicesStore);

  const [selectedId, setSelectedId] = useState(null);
  const [editor, setEditor] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [editorError, setEditorError] = useState(null);

  usePolling(() => servicesStore.load(), { intervalMs: servicesPollMs });

  // 列表接口不带启动诊断；只有失败态才值得多花一次请求把原因取回来
  const failedIds = useMemo(
    () => state.services.filter((item) => FAILED_STATUSES.includes(item.status) && !item.startupDiagnostics).map((item) => item.id),
    [state.services],
  );
  const failedKey = failedIds.join(',');
  useEffect(() => {
    for (const id of failedIds) servicesStore.hydrateDiagnostics(id);
    // 依赖里带 lastUpdatedAt（每次 load 成功都会变）：列表本身不带诊断，一次瞬时失败若
    // 只靠 failedKey 触发就再也不会重试，卡片会永久空着。跟着轮询重试即可自愈——
    // 请求成功那一刻该服务就退出重试集合；轮询间隔本身就是节流，无需再加退避。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failedKey, state.lastUpdatedAt, servicesStore]);

  const selected = selectedId ? (state.services.find((item) => item.id === selectedId) ?? null) : null;

  const handleSubmit = useCallback(
    async (values) => {
      setSubmitting(true);
      setEditorError(null);
      const saved = await servicesStore.save(values, editor?.service?.id);
      setSubmitting(false);
      if (!saved) {
        setEditorError(servicesStore.getState().error);
        return;
      }
      setEditor(null);
    },
    [editor, servicesStore],
  );

  const handleDelete = useCallback(
    async (id) => {
      await servicesStore.remove(id);
      setSelectedId((current) => (current === id ? null : current));
    },
    [servicesStore],
  );

  return (
    <div className="app">
      <header className="app__header" role="banner">
        <div className="app__brand">
          <span className="app__mark" aria-hidden="true" />
          <div className="app__brand-text">
            <h1 className="app__title">AI Service Console</h1>
            <p className="app__subtitle">本机服务启停与日志控制台 · 默认仅监听 127.0.0.1</p>
          </div>
        </div>
      </header>

      {state.error ? (
        <p className="app__error" role="alert">
          {state.error.message}
          <button type="button" className="btn btn--quiet" onClick={() => servicesStore.clearError()}>
            关闭提示
          </button>
        </p>
      ) : null}

      <main className="app__main" role="main">
        <div className="app__column app__column--detail">
          {editor ? (
            <ServiceForm
              initialValue={editor.service}
              submitting={submitting}
              error={editorError}
              onSubmit={handleSubmit}
              onCancel={() => setEditor(null)}
            />
          ) : selected ? (
            <LogViewer service={selected} api={api} intervalMs={logsPollMs} />
          ) : (
            <div className="app__placeholder">
              <p className="app__placeholder-title">选择下方任意服务</p>
              <p className="app__placeholder-hint">
                点卡片即可看它自己写的日志文件（每秒刷新），点卡片上的「启动 / 停止 / 重启」直接操作进程，不必再 RDP 找目录、回忆命令。
              </p>
            </div>
          )}
        </div>

        <div className="app__column app__column--list">
          <ServiceList
            services={state.services}
            warnings={state.warnings}
            pending={state.pending}
            loaded={state.loaded}
            activeId={selectedId}
            onStart={(id) => servicesStore.start(id)}
            onStop={(id) => servicesStore.stop(id)}
            onRestart={(id) => servicesStore.restart(id)}
            onEdit={(id) => {
              setEditor({ service: servicesStore.getService(id) });
              setEditorError(null);
            }}
            onDelete={handleDelete}
            // 点卡片就是「我要看这个服务的日志」，因此顺带关掉编辑表单：
            // 表单开着时 selected 不参与渲染，只 setSelectedId 的话点了卡片毫无反应，
            // 看起来像卡死。表单本身很小，且随时可再从「编辑」重开。
            onOpenLogs={(id) => {
              setEditor(null);
              setSelectedId(id);
            }}
            onCreate={() => {
              setEditor({ service: null });
              setEditorError(null);
            }}
          />
        </div>
      </main>
    </div>
  );
}
