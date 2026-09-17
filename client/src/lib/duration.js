/**
 * 相对时长格式化（「已启动 1m05s」）。
 *
 * 用途：AI 服务加载模型要几十秒到几分钟，宽限期内必须让用户看到「还在走」，
 * 否则「启动中」和「卡住」在观感上无法区分。
 */
export function formatElapsed(ms) {
  const totalSeconds = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m${String(seconds).padStart(2, '0')}s`;

  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
}
