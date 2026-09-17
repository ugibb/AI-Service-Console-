import './StatusBadge.css';

/**
 * 状态徽标（T1.13）。
 *
 * 颜色是**语义**的，不是装饰：ok=在跑、busy=过渡中、danger=需要人管、idle=不在跑。
 * tone 只在这里定义一次，组件用类名承载，避免色值散落在 JSX 里。
 */
export const STATUS_META = Object.freeze({
  running: { label: '运行中', tone: 'ok', active: true },
  stopped: { label: '已停止', tone: 'idle', active: false },
  starting: { label: '启动中', tone: 'busy', active: true },
  stopping: { label: '停止中', tone: 'busy', active: true },
  error: { label: '异常', tone: 'danger', active: false },
  start_failed: { label: '启动失败', tone: 'danger', active: false },
});

const FALLBACK = Object.freeze({ label: '未知', tone: 'idle', active: false });

export function StatusBadge({ status, exitCode = null, className = '' }) {
  const meta = STATUS_META[status] ?? FALLBACK;
  const classes = ['status-badge', `status-badge--${meta.tone}`];
  if (meta.active) classes.push('status-badge--active');
  if (className) classes.push(className);

  return (
    <span className={classes.join(' ')} data-status={status}>
      <span className="status-badge__dot" aria-hidden="true" />
      <span className="status-badge__label">{meta.label}</span>
      {exitCode === null || exitCode === undefined ? null : <span className="status-badge__exit">退出码 {exitCode}</span>}
    </span>
  );
}
