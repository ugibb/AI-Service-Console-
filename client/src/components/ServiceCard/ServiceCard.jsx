import { useState } from 'react';
import { StatusBadge } from '../StatusBadge/StatusBadge.jsx';
import './ServiceCard.css';

const BUSY_LABELS = Object.freeze({
  start: '启动中…',
  stop: '停止中…',
  restart: '重启中…',
});

const STOPPABLE = ['running', 'starting'];
const STARTABLE = ['stopped', 'error', 'start_failed'];

/**
 * 单个服务卡片（T1.14）。
 *
 * 目标场景是「RDP 进来点一下」：状态和路径要一眼看到，
 * 按钮的可用性必须与当前状态严格对应（避免点了没反应的困惑）。
 */
export function ServiceCard({ service, busy = null, active = false, onStart, onStop, onRestart, onEdit, onDelete, onOpenLogs }) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const status = service.status ?? 'stopped';
  const locked = Boolean(busy);
  const canStart = STARTABLE.includes(status);
  const canStop = STOPPABLE.includes(status);
  const canRestart = status === 'running';
  const diagnostics = Array.isArray(service.startupDiagnostics) ? service.startupDiagnostics : [];

  return (
    <article className={`service-card${active ? ' service-card--active' : ''}`} aria-current={active ? 'true' : undefined}>
      <header className="service-card__head">
        <h3 className="service-card__name">{service.name}</h3>
        <StatusBadge status={status} exitCode={service.exitCode} />
      </header>

      <dl className="service-card__meta">
        <div className="service-card__meta-row">
          <dt>目录</dt>
          <dd className="service-card__path" title={service.workDir}>
            {service.workDir}
          </dd>
        </div>
        {service.port == null ? null : (
          <div className="service-card__meta-row">
            <dt>端口</dt>
            <dd className="service-card__mono">{service.port}</dd>
          </div>
        )}
        {service.pid == null ? null : (
          <div className="service-card__meta-row">
            <dt>PID</dt>
            <dd className="service-card__mono">{service.pid}</dd>
          </div>
        )}
      </dl>

      {service.statusMessage ? <p className="service-card__message">{service.statusMessage}</p> : null}

      {diagnostics.length > 0 ? (
        <details className="service-card__diag" open>
          <summary>启动诊断输出（{diagnostics.length} 行）</summary>
          <pre>{diagnostics.join('\n')}</pre>
        </details>
      ) : null}

      <div className="service-card__actions">
        {confirmingDelete ? (
          <>
            <span className="service-card__confirm">确认删除该服务配置？</span>
            <button type="button" className="btn btn--danger" onClick={() => onDelete(service.id)}>
              确认删除
            </button>
            <button type="button" className="btn btn--ghost" onClick={() => setConfirmingDelete(false)}>
              取消
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn btn--primary" disabled={locked || !canStart} onClick={() => onStart(service.id)}>
              {busy === 'start' ? BUSY_LABELS.start : '启动'}
            </button>
            <button type="button" className="btn btn--ghost" disabled={locked || !canStop} onClick={() => onStop(service.id)}>
              {busy === 'stop' ? BUSY_LABELS.stop : '停止'}
            </button>
            <button type="button" className="btn btn--ghost" disabled={locked || !canRestart} onClick={() => onRestart(service.id)}>
              {busy === 'restart' ? BUSY_LABELS.restart : '重启'}
            </button>
            <span className="service-card__spacer" />
            <button type="button" className="btn btn--quiet" onClick={() => onOpenLogs(service.id)}>
              看日志
            </button>
            <button type="button" className="btn btn--quiet" onClick={() => onEdit(service.id)}>
              编辑
            </button>
            <button type="button" className="btn btn--quiet" disabled={locked} onClick={() => setConfirmingDelete(true)}>
              删除
            </button>
          </>
        )}
      </div>
    </article>
  );
}
