/**
 * 启动诊断缓冲：环形保存最近 N 行 stdout/stderr，**仅用于启动失败诊断**（PRD §8.5）。
 *
 * 正常运行日志一律以服务自写的日志文件为准（见 logs/logTail.js），
 * 这里只在「服务没起来、日志文件还空着」时提供线索，窗口过后停止写入。
 */
import { decodeAuto, splitLines, stripCr } from '../logs/decode.js';

/** 单行上限，避免某行超长把内存吃光 */
const MAX_LINE_CHARS = 4000;
/** 未成行的残留字节上限 */
const MAX_PENDING_BYTES = 64 * 1024;

export function createDiagBuffer({ maxLines = 200 } = {}) {
  /** @type {string[]} */
  let lines = [];
  let pending = Buffer.alloc(0);
  let bytes = 0;
  let truncated = false;

  function pushLine(buffer) {
    const line = stripCr(buffer);
    const { text } = decodeAuto(line);
    lines.push(text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)} …` : text);
    if (lines.length > maxLines) {
      lines = lines.slice(-maxLines);
      truncated = true;
    }
  }

  return {
    /** 追加一块子进程输出 */
    push(chunk) {
      if (!chunk || chunk.length === 0) return;
      bytes += chunk.length;
      pending = pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([pending, chunk]);
      const { lines: complete, tail } = splitLines(pending);
      for (const line of complete) pushLine(line);
      pending = tail;
      if (pending.length > MAX_PENDING_BYTES) pending = pending.subarray(pending.length - MAX_PENDING_BYTES);
    },
    /** 进程退出时把未成行的残留也收进来 */
    flush() {
      if (pending.length === 0) return;
      pushLine(pending);
      pending = Buffer.alloc(0);
    },
    lines: () => [...lines],
    bytes: () => bytes,
    wasTruncated: () => truncated,
    isEmpty: () => lines.length === 0,
  };
}
