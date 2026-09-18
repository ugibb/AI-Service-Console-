/**
 * 日志字节流的编码判定与解码（T1.4）。
 *
 * 存在的理由：Windows 上的服务日志大多是 GBK（cmd.exe / 老 Java / 国产中间件的默认编码），
 * 而项目自己的日志是 UTF-8。读到字节后必须先判编码再解码，否则中文全是乱码 ——
 * 这是 Windows 现场最常见的坑，也是 PRD §8.3 明确要求的一项。
 *
 * 判定策略（不引入 jschardet 之类重依赖，用廉价且可解释的启发式）：
 *   1. 空 buffer → utf8
 *   2. 整块是合法 UTF-8 → utf8（GBK 字节几乎不可能整块合法）
 *   3. 否则按 UTF-8 试解码，看替换字符（U+FFFD）占比：
 *        占比低 → 只是尾部被截断了半个多字节字符，主体仍是 UTF-8
 *        占比高 → 真 GBK
 *      实测分界很宽：截断的 UTF-8 约 0.17，GBK 最低也在 0.60 以上，阈值取 0.3 有余量。
 */
import iconv from 'iconv-lite';

/** 替换字符：解码失败的标志 */
const REPLACEMENT = '�';

/**
 * UTF-8 解码出现替换字符的比例阈值，超过即认为是 GBK。
 * 见文件头注释的实测数据（截断 UTF-8 0.17 / GBK ≥0.60）。
 */
const GBK_REPLACEMENT_RATIO = 0.3;

/** GBK 双字节字符的首字节范围 */
const GBK_LEAD_MIN = 0x81;
const GBK_LEAD_MAX = 0xfe;

/** GBK 双字节字符的跟随字节范围（注意与首字节范围重叠，不能只看单字节） */
function isGbkTrail(byte) {
  return (byte >= 0x40 && byte <= 0x7e) || (byte >= 0x80 && byte <= 0xfe);
}

/** 统计字符串里的替换字符个数 */
export function countReplacements(text) {
  let n = 0;
  for (const ch of text) if (ch === REPLACEMENT) n += 1;
  return n;
}

/** 统计 buffer 里某个字节出现的次数 */
export function countByte(buffer, byte) {
  let n = 0;
  for (let i = 0; i < buffer.length; i += 1) if (buffer[i] === byte) n += 1;
  return n;
}

/**
 * 整块是否是合法 UTF-8。
 * 空 buffer 视为合法（无内容无所谓编码）。
 */
export function isValidUtf8(buffer) {
  if (buffer.length === 0) return true;
  // Buffer#toString 会把非法字节变成 U+FFFD；反过来用替换字符判定最省事，
  // 但注意「内容本身含 U+FFFD」的合法 UTF-8 会被误判 —— 日志场景可接受。
  return !buffer.toString('utf8').includes(REPLACEMENT);
}

/** 判断编码：'utf8' | 'gbk' */
export function detectEncoding(buffer) {
  if (buffer.length === 0) return 'utf8';
  if (isValidUtf8(buffer)) return 'utf8';

  const text = buffer.toString('utf8');
  const replacements = countReplacements(text);
  const chars = [...text].length;
  if (chars > 0 && replacements / chars <= GBK_REPLACEMENT_RATIO) return 'utf8';
  return 'gbk';
}

/**
 * 去掉尾部「不完整的多字节字符」，避免解码出替换字符。
 *
 * 只在「多字节字符刚好被块边界切开」时裁剪，不会动中间的内容。
 * 关键约束：**不能把 GBK 误当成截断的 UTF-8 裁掉**（GBK 字节里到处都是 0x80~0xBF 的跟随字节样）。
 * 做法是从尾部回退不超过 3 个跟随字节找到首字节，按首字节算应有长度，不够才裁。
 */
export function trimIncompleteUtf8Tail(buffer) {
  if (buffer.length === 0 || isValidUtf8(buffer)) return buffer;

  let i = buffer.length - 1;
  let trailCount = 0;
  // 回退时最多看 3 个跟随字节（UTF-8 最长 4 字节）
  while (i >= 0 && (buffer[i] & 0xc0) === 0x80 && trailCount < 3) {
    i -= 1;
    trailCount += 1;
  }
  if (i < 0) return buffer;

  const lead = buffer[i];
  let need;
  if ((lead & 0x80) === 0x00) need = 1;
  else if ((lead & 0xe0) === 0xc0) need = 2;
  else if ((lead & 0xf0) === 0xe0) need = 3;
  else if ((lead & 0xf8) === 0xf0) need = 4;
  else return buffer; // 首字节本身不合法 → 不是「被截断」，原样返回

  const have = buffer.length - i;
  return have < need ? buffer.subarray(0, i) : buffer;
}

/**
 * 去掉尾部「孤立的 GBK 首字节」。
 *
 * 必须从头成对扫描：GBK 的首字节范围（0x81~0xFE）与跟随字节范围（0x80~0xFE）大面积重叠，
 * 只看最后一个字节根本分不清它是「首字节」还是「跟随字节」。
 */
export function trimIncompleteGbkTail(buffer) {
  let i = 0;
  while (i < buffer.length) {
    const byte = buffer[i];
    if (byte < 0x80) {
      i += 1;
    } else if (byte >= GBK_LEAD_MIN && byte <= GBK_LEAD_MAX) {
      if (i + 1 >= buffer.length) return buffer.subarray(0, i); // 尾部只剩一个首字节
      if (!isGbkTrail(buffer[i + 1])) {
        i += 1; // 不成对，当单字节处理，继续往后找
        continue;
      }
      i += 2;
    } else {
      i += 1; // 非法字节，跳过
    }
  }
  return buffer;
}

/** 去掉字符串开头的 BOM */
export function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** 去掉 buffer 尾部的 CR（CRLF 行尾） */
export function stripCr(buffer) {
  return buffer.length > 0 && buffer[buffer.length - 1] === 0x0d ? buffer.subarray(0, buffer.length - 1) : buffer;
}

/**
 * 按指定编码解码一个 buffer。
 * @param {Buffer} buffer
 * @param {{ encoding?: 'utf8'|'gbk', trimTail?: boolean }} [options]
 *        trimTail=true 时先裁掉尾部不完整的多字节字符（分块读取时用）
 * @returns {{ text: string, encoding: string, replacements: number }}
 */
export function decodeBuffer(buffer, { encoding = 'utf8', trimTail = false } = {}) {
  const normalized = encoding === 'gbk' ? 'gbk' : 'utf8';
  const source = trimTail ? (normalized === 'gbk' ? trimIncompleteGbkTail(buffer) : trimIncompleteUtf8Tail(buffer)) : buffer;
  const text = stripBom(iconv.decode(source, normalized));
  return { text, encoding: normalized, replacements: countReplacements(text) };
}

/**
 * 自动判编码后解码。用于「拿不准是什么编码」的单块内容（如启动诊断输出）。
 * @returns {{ text: string, encoding: string }}
 */
export function decodeAuto(buffer) {
  const encoding = detectEncoding(buffer);
  const { text } = decodeBuffer(buffer, { encoding });
  return { text, encoding };
}

/**
 * 按 0x0A 切分 buffer，保留末尾未成行的残段。
 *
 * 返回的是 **Buffer 数组**而不是字符串：调用方（诊断缓冲）需要先做字节级处理
 * （去 CR）再解码，过早解码会在块边界上切坏多字节字符。
 *
 * 返回的行不含结尾的 0x0A；若 buffer 以 0x0A 结尾，tail 为空 buffer。
 * @returns {{ lines: Buffer[], tail: Buffer }}
 */
export function splitLines(buffer) {
  const lines = [];
  let start = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer[i] === 0x0a) {
      lines.push(buffer.subarray(start, i));
      start = i + 1;
    }
  }
  return { lines, tail: buffer.subarray(start) };
}
