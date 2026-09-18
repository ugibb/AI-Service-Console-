/**
 * 控制台自身日志的落盘 sink（T-desktop，见 `02-doc/02-design/030-desktop-packaging.md` §5.2）。
 *
 * **为什么需要它**：桌面版（Electron）没有控制台窗口，`process.stdout` 直接进黑洞。
 * 一旦「控制台起不来」或「某个服务启动失败」，现场没有任何可查的东西。
 * 这是离线机器上排障的唯一途径，所以必须做。
 *
 * 设计取舍：
 * - **同步写**。日志量本身很低（子进程 stdout 走 diagBuffer，不经这里），
 *   同步换来的是「进程崩溃/被杀时日志一定已经落盘」——排障场景下这个比吞吐重要得多。
 * - **写失败绝不抛出**。日志器自身崩掉会连累整个控制台，这是不可接受的降级路径，
 *   所以所有 IO 都包在 try/catch 里，失败只记在 lastError 上，由调用方决定要不要提示。
 * - **按大小轮转**。长期运行的控制台不能让它把磁盘写满。
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * 把多个 sink 合成一个：任何一条日志同时写给所有 sink。
 *
 * **单个 sink 抛错不能连累其他 sink，更不能连累调用方**。
 * 桌面版的 Electron GUI 进程没有控制台，`process.stdout` 的写入是可能抛错的；
 * 若任它冒泡，一条本意是「记录问题」的日志反而会把控制台打挂——正好把工具的作用反过来。
 * 这里静默吞掉是刻意的：日志已经尽力而为，写入失败没有更好的补救动作。
 * 需要感知落盘失败的场景，用 `createRotatingFileSink` 的 `lastError` / `onError`。
 *
 * @param {Array<{write: (chunk: string) => void}>} sinks
 */
export function createMultiSink(sinks) {
  const list = sinks.filter(Boolean);
  return {
    write(chunk) {
      for (const sink of list) {
        try {
          sink.write(chunk);
        } catch {
          /* 见上方说明：单个 sink 失败不扩散 */
        }
      }
    },
  };
}

/**
 * 按大小轮转的文件 sink。
 *
 * 轮转规则（maxBackups = 3 时）：
 * ```text
 * console.log.3  ← 丢弃
 * console.log.2  → console.log.3
 * console.log.1  → console.log.2
 * console.log    → console.log.1        （当前文件超限时）
 * console.log    ← 新建，继续写
 * ```
 *
 * @param {{ filePath: string, maxBytes?: number, maxBackups?: number,
 *           fsImpl?: typeof fs, onError?: (err: Error) => void }} options
 */
export function createRotatingFileSink({ filePath, maxBytes = 2 * 1024 * 1024, maxBackups = 3, fsImpl = fs, onError } = {}) {
  if (!filePath) throw new Error('createRotatingFileSink 需要 filePath');

  let size = 0;
  let lastError = null;

  const exists = (p) => {
    try {
      return fsImpl.existsSync(p);
    } catch {
      return false;
    }
  };

  const removeQuietly = (p) => {
    try {
      fsImpl.rmSync(p, { force: true });
    } catch {
      /* 删不掉不影响继续写，下一轮再试 */
    }
  };

  const fail = (err) => {
    lastError = err;
    // 刻意不在这里写日志：onError 一旦回调日志器就会无限递归
    onError?.(err);
  };

  try {
    fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
    // 追加写：控制台重启后应接着上次写，而不是把上次的日志冲掉
    size = exists(filePath) ? fsImpl.statSync(filePath).size : 0;
  } catch (err) {
    fail(err);
  }

  function rotate() {
    const oldest = `${filePath}.${maxBackups}`;
    if (maxBackups <= 0) {
      removeQuietly(filePath);
      return;
    }
    removeQuietly(oldest);
    for (let i = maxBackups - 1; i >= 1; i -= 1) {
      const from = `${filePath}.${i}`;
      if (exists(from)) fsImpl.renameSync(from, `${filePath}.${i + 1}`);
    }
    if (exists(filePath)) fsImpl.renameSync(filePath, `${filePath}.1`);
  }

  return {
    filePath,

    write(chunk) {
      const text = String(chunk);
      const bytes = Buffer.byteLength(text, 'utf8');
      try {
        if (size > 0 && size + bytes > maxBytes) {
          rotate();
          size = 0;
        }
        fsImpl.appendFileSync(filePath, text, 'utf8');
        size += bytes;
      } catch (err) {
        fail(err);
      }
    },

    /** 当前文件字节数（测试与诊断用） */
    get size() {
      return size;
    },

    /** 最近一次写失败的原因；正常时为 null */
    get lastError() {
      return lastError;
    },
  };
}
