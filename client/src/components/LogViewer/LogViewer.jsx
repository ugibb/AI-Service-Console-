import { useEffect, useMemo, useRef, useState } from 'react';
import { usePolling } from '../../hooks/usePolling.js';
import './LogViewer.css';

const DEFAULT_TAIL = 500;

/** 后端回的是 iconv 的编码名（utf8 / gbk），展示时用人类写法 */
const ENCODING_LABELS = { utf8: 'UTF-8', gbk: 'GBK', utf16le: 'UTF-16LE' };
const formatEncoding = (encoding) => (encoding ? (ENCODING_LABELS[encoding.toLowerCase()] ?? encoding.toUpperCase()) : '—');

const formatClock = (timestamp) => (timestamp ? new Date(timestamp).toLocaleTimeString('zh-CN', { hour12: false }) : '—');

const formatSize = (bytes) => {
  if (bytes == null) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

/** 抽成纯函数，是因为「关闭自动滚动时切换关键字」也要用它算新的计数基线 */
const filterLines = (lines, keyword) => {
  const needle = String(keyword ?? '')
    .trim()
    .toLowerCase();
  if (!needle) return lines;
  return lines.filter((line) => String(line).toLowerCase().includes(needle));
};

/**
 * 日志查看器（T1.16）。
 *
 * 日志一律来自服务自己写的文件（尾部 N 行），1s 轮询重读（PRD §8.2 全量 tail）。
 * 过滤是纯客户端行为（§8.6）：对已经拿到的行做关键字匹配，不额外请求。
 *
 * 「自动滚动」只控制**视口**，不控制轮询：关掉它日志照样每秒拉取、内容照样更新，
 * 只是不再把滚动条拽到底部——否则用户往回翻查历史时会被一直甩回末尾。
 */
export function LogViewer({ service, api, intervalMs = 1000, tail = DEFAULT_TAIL, onClose }) {
  const [keyword, setKeyword] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [pauseBaseline, setPauseBaseline] = useState(0);
  const bodyRef = useRef(null);

  const { data, error, loading, lastUpdatedAt } = usePolling(() => api.getLogs(service.id, { tail }), { intervalMs });

  const lines = useMemo(() => (Array.isArray(data?.lines) ? data.lines : []), [data]);

  const filtered = useMemo(() => filterLines(lines, keyword), [lines, keyword]);

  // 暂停期间累积的新行数。纯推导（当前行数 − 暂停时的行数），不需要额外 effect：
  // 轮转/截断导致行数变少时 Math.max 兜住，不会出现负数。
  const pendingCount = autoScroll ? 0 : Math.max(0, filtered.length - pauseBaseline);

  const setAutoScrollFrom = (next) => {
    setAutoScroll(next);
    setPauseBaseline(filtered.length);
  };

  const handleKeywordChange = (event) => {
    const next = event.target.value;
    setKeyword(next);
    if (!autoScroll) setPauseBaseline(filterLines(lines, next).length);
  };

  useEffect(() => {
    if (!autoScroll || !bodyRef.current) return;
    const element = bodyRef.current;
    if (typeof element.scrollTo === 'function') element.scrollTo({ top: element.scrollHeight });
    else element.scrollTop = element.scrollHeight;
  }, [filtered, autoScroll]);

  const unavailable = Boolean(data) && data.available === false;
  const emptyFile = Boolean(data) && data.available !== false && lines.length === 0;
  const size = formatSize(data?.fileSize);

  return (
    <section className="log-viewer" aria-label={`${service.name} 的日志`}>
      <header className="log-viewer__head">
        <div className="log-viewer__ident">
          <h2 className="log-viewer__title">{service.name}</h2>
          <p className="log-viewer__path" title={data?.path ?? service.logFile}>
            {data?.path ?? service.logFile}
          </p>
        </div>

        <dl className="log-viewer__stats">
          <div>
            <dt>编码</dt>
            <dd>{formatEncoding(data?.encoding)}</dd>
          </div>
          <div>
            <dt>行数</dt>
            <dd>{lines.length}</dd>
          </div>
          <div>
            <dt>大小</dt>
            <dd>{size ?? '—'}</dd>
          </div>
          <div>
            <dt>更新</dt>
            <dd>{formatClock(lastUpdatedAt)}</dd>
          </div>
        </dl>

        {onClose ? (
          <button type="button" className="btn btn--quiet" aria-label="关闭日志" onClick={onClose}>
            关闭
          </button>
        ) : null}
      </header>

      <div className="log-viewer__toolbar">
        <label className="log-viewer__search">
          <span className="log-viewer__search-label">关键字过滤</span>
          <input
            type="search"
            className="field__input"
            value={keyword}
            placeholder="例如 ERROR / 超时 / 端口"
            onChange={handleKeywordChange}
          />
        </label>

        {keyword.trim() ? (
          <span className="log-viewer__hits">
            命中 {filtered.length} / {lines.length} 行
          </span>
        ) : null}

        <label className="log-viewer__auto-scroll">
          <input type="checkbox" checked={autoScroll} onChange={(event) => setAutoScrollFrom(event.target.checked)} />
          自动滚动
        </label>

        {data?.truncatedLines > 0 ? <span className="log-viewer__truncated">{data.truncatedLines} 行过长已截断</span> : null}
      </div>

      {error ? (
        <p className="log-viewer__alert" role="alert">
          {error.message}
        </p>
      ) : null}

      {unavailable ? (
        <p className="log-viewer__placeholder">{data.message}</p>
      ) : emptyFile ? (
        <p className="log-viewer__placeholder">{data.message ?? '日志文件已存在，但当前内容为空'}</p>
      ) : filtered.length === 0 ? (
        <p className="log-viewer__placeholder">没有匹配「{keyword.trim()}」的日志行</p>
      ) : (
        <div className="log-viewer__body-wrap">
          <div className="log-viewer__body" ref={bodyRef} role="log" aria-live="off" tabIndex={0}>
            {filtered.map((line, index) => (
              <div className="log-line" key={`${index}-${line.length}`}>
                <span className="log-line__no">{index + 1}</span>
                <span className="log-line__text">{line}</span>
              </div>
            ))}
          </div>

          {!autoScroll && pendingCount > 0 ? (
            <button type="button" className="log-viewer__jump" onClick={() => setAutoScrollFrom(true)}>
              {pendingCount} 条新日志
            </button>
          ) : null}
        </div>
      )}

      {loading ? <p className="log-viewer__foot">正在读取日志…</p> : null}
    </section>
  );
}
