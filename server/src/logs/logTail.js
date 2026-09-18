/**
 * 日志文件尾部读取（T1.5）。
 *
 * 三条设计约束（都来自 PRD §8.2）：
 *  1. **不整文件读入**：从文件末尾反向分块读，只取够 N 行就停。AI 服务的日志动辄几百 MB。
 *  2. **每次请求重新 tail（全量 tail）**：不记 offset、不做增量。文件被轮转（改名 + 新建）
 *     或截断后，下一次请求读到的天然就是新内容 —— 这是「免疫」而不是「处理」。
 *  3. **降级不抛异常**：文件不存在 / 是目录 / 没权限，都返回结构化结果，
 *     由路由层翻译成 `available:false`。这些是「服务还没写日志」的正常状态，不是请求错误。
 *
 * 编码处理的关键顺序：**先在字节层面按 0x0A 切行，再对整行解码**。
 * 反过来做（先解码整块再切行）会在块边界上把多字节字符切坏 —— 0x0A 在 UTF-8 与 GBK 里
 * 都是单字节且不会出现在多字节字符内部，所以它是两种编码下都安全的切分锚点。
 */
import fs from 'node:fs/promises';
import { countByte, countReplacements, decodeBuffer, detectEncoding, splitLines, stripCr } from './decode.js';

/** 尾部读取的降级类型，与路由层的 DEGRADED_MESSAGES 一一对应 */
export const TAIL_KINDS = Object.freeze({
  MISSING: 'missing',
  DIRECTORY: 'directory',
  PERMISSION: 'permission',
  UNKNOWN: 'unknown',
});

/** 单行被截断时追加的标记（前面还会有一个省略号，见 truncateLine） */
export const TRUNCATED_MARKER = '（单行超长，已截断）';

/** 截断时保留的省略号：与 MARKER 分开，便于前端只认 MARKER 做高亮 */
const ELLIPSIS = '…';

const DEFAULT_CHUNK_SIZE = 64 * 1024;
const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;
const DEFAULT_FALLBACK_ENCODING = 'gbk';

/**
 * 把底层 fs 错误翻译成结构化降级结果。
 * Windows 的本地化文案不可靠，一律看 err.code（与 proc/win32.js 的 taskkill 处理同一原则）。
 */
function classifyFsError(err, filePath) {
  const code = err?.code;
  if (code === 'ENOENT') {
    return { ok: false, kind: TAIL_KINDS.MISSING, code: 'LOG_PATH_MISSING', message: '日志文件尚未生成', path: filePath };
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return { ok: false, kind: TAIL_KINDS.PERMISSION, code: 'LOG_PATH_PERMISSION', message: '没有读取该日志文件的权限', path: filePath };
  }
  if (code === 'EISDIR') {
    return {
      ok: false,
      kind: TAIL_KINDS.DIRECTORY,
      code: 'LOG_PATH_IS_DIRECTORY',
      message: '配置的日志路径是一个目录，不是文件',
      path: filePath,
    };
  }
  return {
    ok: false,
    kind: TAIL_KINDS.UNKNOWN,
    code: 'LOG_READ_FAILED',
    message: `读取日志文件失败：${err?.message ?? err}`,
    path: filePath,
  };
}

/**
 * 超长单行截断。按**字符**切而不是按字节切：一个字宽的截断点比「半个汉字」好得多，
 * 且此时内容已经解码完成，再按字节切反而会把好好的中文切坏。
 */
function truncateLine(text, maxLineBytes) {
  if (text.length <= maxLineBytes) return { text, truncated: false };
  return { text: `${text.slice(0, maxLineBytes)}${ELLIPSIS}${TRUNCATED_MARKER}`, truncated: true };
}

/**
 * 从文件尾部反向读够 N 行所需的字节。
 * @returns {{ region: Buffer, reachedStart: boolean }}
 */
async function readTailRegion(handle, size, { lines, chunkSize }) {
  const targetNewlines = lines + 1; // 多要一个换行，用来判定 hasMore
  let position = size;
  let newlineCount = 0;
  let reachedStart = false;
  /** @type {Buffer[]} 由新到旧读入，最后反转拼接 */
  const chunks = [];

  while (position > 0) {
    const readSize = Math.min(chunkSize, position);
    position -= readSize;
    const buffer = Buffer.allocUnsafe(readSize);
    const { bytesRead } = await handle.read(buffer, 0, readSize, position);
    const chunk = buffer.subarray(0, bytesRead);
    chunks.unshift(chunk);
    newlineCount += countByte(chunk, 0x0a);
    if (position === 0) reachedStart = true;
    if (newlineCount >= targetNewlines) break;
  }

  return { region: Buffer.concat(chunks), reachedStart };
}

/**
 * 读取日志文件最后 N 行。
 *
 * @param {string} filePath
 * @param {{ lines?: number, chunkSize?: number, maxLineBytes?: number, fallbackEncoding?: string }} [options]
 * @returns {Promise<object>} 成功：{ ok:true, lines, lineCount, hasMore, truncatedLines, encoding,
 *                                    fileSize, mtime, path, emptyFile? }
 *                            降级：{ ok:false, kind, code, message, path }
 */
export async function tailFile(
  filePath,
  { lines = 200, chunkSize = DEFAULT_CHUNK_SIZE, maxLineBytes = DEFAULT_MAX_LINE_BYTES, fallbackEncoding = DEFAULT_FALLBACK_ENCODING } = {},
) {
  const want = Math.max(1, Math.floor(lines) || 1);

  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch (err) {
    return classifyFsError(err, filePath);
  }

  // 先判目录而不是直接 open：Windows 上 open 一个目录报的错（EISDIR/EPERM）
  // 与「没权限」不好区分，stat 是确定的。
  if (stat.isDirectory()) {
    return {
      ok: false,
      kind: TAIL_KINDS.DIRECTORY,
      code: 'LOG_PATH_IS_DIRECTORY',
      message: '配置的日志路径是一个目录，不是文件',
      path: filePath,
    };
  }

  const base = { path: filePath, fileSize: stat.size, mtime: stat.mtimeMs };

  if (stat.size === 0) {
    return { ok: true, ...base, emptyFile: true, lines: [], lineCount: 0, hasMore: false, truncatedLines: 0, encoding: null };
  }

  let handle;
  try {
    handle = await fs.open(filePath, 'r');
  } catch (err) {
    return classifyFsError(err, filePath);
  }

  let region;
  let reachedStart;
  try {
    ({ region, reachedStart } = await readTailRegion(handle, stat.size, { lines: want, chunkSize }));
  } catch (err) {
    return classifyFsError(err, filePath);
  } finally {
    await handle.close();
  }

  // 字节级切行（对 UTF-8 / GBK 都安全，见文件头注释）。
  // 文件以换行结尾 → tail 为空；不以换行结尾 → tail 是最后一行（没有 \n 也是完整的一行）。
  const { lines: segments, tail } = splitLines(region);
  const realSegments = tail.length > 0 ? [...segments, tail] : segments;
  // 未能读到文件开头时，第一段是被切掉一半的半行：既不是完整行，也会给编码判定带去假替换字符
  const completeSegments = reachedStart ? realSegments : realSegments.slice(1);

  const hasMore = !reachedStart || completeSegments.length > want;
  const kept = completeSegments.slice(-want);

  // 编码判定用「本次实际保留的完整行」：避开了半行带来的假替换字符，也不受 chunkSize 影响
  const encoding = detectEncoding(Buffer.concat(kept)) === 'utf8' ? 'utf8' : fallbackEncoding;

  let truncatedLines = 0;
  const decoded = kept.map((segment) => {
    const { text } = decodeBuffer(stripCr(segment), { encoding });
    const { text: finalText, truncated } = truncateLine(text, maxLineBytes);
    if (truncated) truncatedLines += 1;
    return finalText;
  });

  return {
    ok: true,
    ...base,
    emptyFile: false,
    lines: decoded,
    lineCount: decoded.length,
    hasMore,
    truncatedLines,
    encoding,
    replacements: countReplacements(decoded.join('\n')),
  };
}
