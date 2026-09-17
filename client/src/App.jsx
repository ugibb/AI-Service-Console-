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
 * 视图结构刻意只有两栏：左「纳管的服务」，右「正在看的东西」（日志 / 编辑表单）。
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failedKey, servicesStore]);

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

  const runningCount = state.services.filter((item) => item.status === 'running').length;

  return (
    <div className="app">
      <header className="app__header" role="banner">
        <div className="app__brand">
          <span className="app__mark" aria-hidden="true" />
          <div>
            <h1 className="app__title">AI Service Console</h1>
            <p className="app__subtitle">本机服务启停与日志控制台 · 默认仅监听 127.0.0.1</p>
          </div>
        </div>

        <dl className="app__stats">
          <div>
            <dt>服务</dt>
            <dd>共 {state.services.length} 个服务</dd>
          </div>
          <div>
            <dt>状态</dt>
            <dd>运行中 {runningCount}</dd>
          </div>
        </dl>
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
        <div className="app__column">
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
            onOpenLogs={setSelectedId}
            onCreate={() => {
              setEditor({ service: null });
              setEditorError(null);
            }}
          />
        </div>

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
            <LogViewer service={selected} api={api} intervalMs={logsPollMs} onClose={() => setSelectedId(null)} />
          ) : (
            <div className="app__placeholder">
              <p className="app__placeholder-title">选择左侧任意服务</p>
              <p className="app__placeholder-hint">
                点「看日志」查看它自己写的日志文件（每秒刷新），点「启动 / 停止 / 重启」直接操作进程， 不必再 RDP 找目录、回忆命令。
              </p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
