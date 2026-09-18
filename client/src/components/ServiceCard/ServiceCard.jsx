import { useState } from 'react';
import { useNow } from '../../hooks/useNow.js';
import { formatElapsed } from '../../lib/duration.js';
import { StatusBadge } from '../StatusBadge/StatusBadge.jsx';
import './ServiceCard.css';

const BUSY_LABELS = Object.freeze({
  start: '启动中…',
  stop: '停止中…',
  restart: '重启中…',
});

/** 可停止 = 真在跑的（含接管的）+ 启动中（启动中允许取消，既有行为） */
const STOPPABLE = ['running', 'starting', 'adopted'];
/** 「启动」的语义是「确保只有一个实例在跑」：稳态下都可点——
 *  stopped/error/start_failed 是常规启动；running/adopted 是先杀旧的再起新的（服务端保证）。
 *  只有过渡态（starting/stopping）置灰：点了也是 SERVICE_BUSY。 */
const TRANSIENT = ['starting', 'stopping'];
const RESTARTABLE = ['running', 'adopted'];

/**
 * 启动中已用时长。每秒走一次，让「启动中」看起来是在推进而不是卡死——
 * AI 服务加载模型要几十秒，没有计时的话用户分不清「在加载」和「挂了」。
 */
function StartingElapsed({ startedAt }) {
  const nowMs = useNow() * 1000;
  const elapsedMs = nowMs - new Date(startedAt).getTime();
  return <span className="service-card__elapsed">已启动 {formatElapsed(elapsedMs)}</span>;
}

/**
 * 单个服务卡片（T1.14）。
 *
 * 目标场景是「RDP 进来点一下」：状态和路径要一眼看到，
 * 按钮的可用性必须与当前状态严格对应（避免点了没反应的困惑）。
 *
 * 整张卡片就是「看日志」的入口 —— 日志是这台控制台的主任务，点卡片即切换，
 * 因此不再单设「看日志」按钮（多一个按钮会把操作区挤成两行，卡片高出一截，
 * 反而压缩了日志区）。名称做成真按钮，键盘和读屏仍有一条明确的可达路径；
 * 卡片其余区域的可点只是给鼠标的快捷方式。
 *
 * 按钮区整体 stopPropagation：点「启动」不应该顺带把日志切走。
 */
export function ServiceCard({ service, busy = null, active = false, onStart, onStop, onRestart, onEdit, onDelete, onOpenLogs }) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const status = service.status ?? 'stopped';
  const locked = Boolean(busy);
  const canStart = !TRANSIENT.includes(status);
  const canStop = STOPPABLE.includes(status);
  const canRestart = RESTARTABLE.includes(status);
  const diagnostics = Array.isArray(service.startupDiagnostics) ? service.startupDiagnostics : [];
  const showRunInfo = service.port != null || service.pid != null;

  const openLogs = () => onOpenLogs(service.id);

  return (
    <article
      className={`service-card${active ? ' service-card--active' : ''}`}
      aria-current={active ? 'true' : undefined}
      onClick={openLogs}
    >
      <header className="service-card__head">
        <h3 className="service-card__name">
          <button
            type="button"
            className="service-card__name-btn"
            title="查看日志"
            onClick={(event) => {
              event.stopPropagation();
              openLogs();
            }}
          >
            {service.name}
          </button>
        </h3>
        <div className="service-card__status">
          <StatusBadge status={status} exitCode={service.exitCode} />
          {status === 'starting' && service.startedAt ? <StartingElapsed startedAt={service.startedAt} /> : null}
        </div>
      </header>

      <dl className="service-card__meta">
        <div className="service-card__meta-row">
          <dt>目录</dt>
          <dd className="service-card__path" title={service.workDir}>
            {service.workDir}
          </dd>
        </div>
        {/* 端口与 PID 并成一行：两者都只是「一眼扫过」的信息，各占一行白白拉高卡片 */}
        {showRunInfo ? (
          <div className="service-card__meta-row">
            {service.port == null ? null : (
              <>
                <dt>端口</dt>
                <dd className="service-card__mono">{service.port}</dd>
              </>
            )}
            {service.pid == null ? null : (
              <>
                <dt>PID</dt>
                <dd className="service-card__mono">{service.pid}</dd>
              </>
            )}
          </div>
        ) : null}
      </dl>

      {service.statusMessage ? <p className="service-card__message">{service.statusMessage}</p> : null}

      {/* 默认折叠：失败原因在上面的 statusMessage 里已经给了，原始输出按需展开即可，
          常驻展开会把卡片顶高一两百像素（max-height 14rem） */}
      {diagnostics.length > 0 ? (
        <details className="service-card__diag">
          <summary>启动诊断输出（{diagnostics.length} 行）</summary>
          <pre>{diagnostics.join('\n')}</pre>
        </details>
      ) : null}

      <div className="service-card__actions" onClick={(event) => event.stopPropagation()}>
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
