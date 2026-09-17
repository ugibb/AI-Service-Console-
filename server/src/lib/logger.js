/**
 * 极简分级日志器（无第三方依赖）。
 * 控制台自身运行在 RDP 会话里，日志直接进 stdout，方便排查「控制台起不来」。
 */
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

export function createLogger({ level = 'info', scope = 'console', sink = process.stdout, errorSink = process.stderr } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;

  function write(target, levelName, message, meta) {
    const line = `${new Date().toISOString()} [${levelName.toUpperCase()}] [${scope}] ${message}`;
    const extra = meta === undefined ? '' : ` ${safeStringify(meta)}`;
    target.write(`${line}${extra}\n`);
  }

  const logger = {};
  for (const [name, rank] of Object.entries(LEVELS)) {
    logger[name] = (message, meta) => {
      if (rank > threshold) return;
      write(name === 'error' ? errorSink : sink, name, message, meta);
    };
  }
  logger.child = (childScope) => createLogger({ level, scope: `${scope}:${childScope}`, sink, errorSink });
  return logger;
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const logger = createLogger({ level: process.env.LSC_LOG_LEVEL || 'info' });
