/**
 * 环境档案（dev / production）的**唯一定义处**。
 *
 * 切换环境 = 换一个档案名，不改任何配置文件：
 *
 *   npm start                      → 生产：3010，托管 client/dist
 *   node src/index.js --env=development  → 开发：3011，只出 API（前端交给 Vite，见 npm run dev）
 *
 * ## 为什么档案名只从 argv 取，不认 LSC_ENV
 *
 * 计划任务或 shell 里残留一个 `LSC_ENV=development`，就会把生产入口**静默**变成开发档，
 * 而开发档和生产线共用 `data/` 台账——那种错配没有任何提示。argv 是每次启动显式给出的，
 * 不存在「上一次留下的值」这回事。
 *
 * ## 为什么这个文件放在 server 而不是根 scripts/
 *
 * `client/vite.config.js` 与 `scripts/dev.mjs` 都要 import 它。反过来让 `server/src/**`
 * 去 import 根 `scripts/**` 会污染 `desktop/scripts/build-bundle.mjs` 从
 * `desktop/server-entry.mjs` 打出的 `server.bundle.mjs`，而且产物里 `import.meta.url`
 * 指向别处，任何基于它的路径推导会静默失效。所以箭头只允许单向流入 server。
 *
 * ## 硬约束：本文件只放纯字面量数据 + 纯函数
 *
 * 不读 `import.meta.url`、不在模块级推导路径——Vite 会先用 esbuild 把配置文件打成临时产物，
 * 桌面版还会把整棵 server 打成单文件，届时 `import.meta.url` 都不是你以为的那个路径。
 * 所有路径推导必须由调用方把 `root` 传进来（见 `profileEnv`）。
 *
 * 环境变量清单见 README.md「两种环境」与「环境变量」两节。
 */
import path from 'node:path';

export const PROFILE_NAMES = Object.freeze(['production', 'development']);

/** 默认档案：不带 `--env` 时用它。必须是 production，否则 desktop / e2e / 打包验证全会被带偏。 */
export const DEFAULT_PROFILE = 'production';

/**
 * `dataDir` 两个档案**都**是 `data`——开发与生产共用同一份服务台账（这是刻意选的：
 * 开发时想看到真实的服务列表）。运行态不在此列，它只在各进程内存里。
 * 共用台账的代价见 README「两种环境」一节的说明。
 */
export const PROFILES = Object.freeze({
  production: Object.freeze({
    label: '生产',
    port: 3010,
    dataDir: 'data',
    serveClient: true,
    /** 只钉文件名，不钉路径：路径由**生效的** dataDir 推导（见 profileEnv），
     *  否则覆盖 LSC_DATA_DIR 后日志仍会写回仓库的 data/logs。 */
    consoleLogName: 'console.log',
    nodeEnv: 'production',
  }),
  development: Object.freeze({
    label: '开发',
    port: 3011,
    dataDir: 'data',
    serveClient: false,
    /**
     * 开发档单独一个 console 日志名。共用 data/ 后两个进程会同时追加并轮转同一个文件，
     * 而 fileSink 的轮转基于**各自进程内**的 size 记账——一方 rename 会把文件从另一方
     * 脚下搬走，记账随即失真。台账共用是刻意的，日志没必要跟着一起冒险。
     */
    consoleLogName: 'console-dev.log',
    nodeEnv: 'development',
  }),
});

/** Vite dev server 端口。前端与 scripts/dev.mjs 共用，避免两处各写一个数。 */
export const DEV_CLIENT_PORT = 5173;

const ARG_PREFIX = '--env=';

/**
 * 从 argv 里读档案名。
 *
 * 认不出的名字**直接报错**而不是回退默认档：`--env=dev` 这种笔误若静默落到生产档，
 * 你以为在开发、实际在写生产台账，且 3010 上通常已经有一个控制台在跑。
 *
 * @param {string[]} argv 通常是 process.argv
 * @returns {string|null} 档案名；没给 `--env=` 时返回 null（由调用方套默认档）
 */
export function readProfileArg(argv = []) {
  for (const arg of argv) {
    if (typeof arg !== 'string' || !arg.startsWith(ARG_PREFIX)) continue;
    const name = arg.slice(ARG_PREFIX.length).trim();
    if (!PROFILE_NAMES.includes(name)) {
      throw new Error(`未知的环境档案 --env=${name}，可选：${PROFILE_NAMES.join(' / ')}`);
    }
    return name;
  }
  return null;
}

/**
 * 把档案展开成一组环境变量，交给 `loadConfig` 消费。
 *
 * **档案给默认值，显式环境变量优先**（`base.LSC_PORT ?? ...`）。这不是风格偏好：
 * `client/e2e/console-server.mjs`（3199）与 `scripts/verify-bundle.mjs`（3098）都靠显式
 * env 隔离端口，档案若压过它们，这两个隔离实例会跑来抢 3011；`desktop/main.js` 也早已
 * 写下「给默认值，不是锁死」。代价是 shell 里一个陈旧的 `LSC_PORT` 会静默改变行为——
 * 由 index.js 的启动横幅打印**生效值**来兜住。
 *
 * @param {string} name 档案名
 * @param {{ root: string, base?: Record<string, string|undefined> }} options
 *   `root` = 仓库根目录，由调用方传入（见文件头「硬约束」）；`base` 默认 process.env
 */
export function profileEnv(name, { root, base = process.env } = {}) {
  const profile = PROFILES[name];
  if (!profile) throw new Error(`未知的环境档案 ${name}，可选：${PROFILE_NAMES.join(' / ')}`);
  if (!root) throw new Error('profileEnv 需要 root（仓库根目录），用于把档案里的相对路径展开成绝对路径');

  const abs = (relative) => path.join(root, relative);

  // 日志路径跟着**生效的** dataDir 走，而不是跟着档案里那个写死的相对路径：
  // 覆盖了 LSC_DATA_DIR 却仍把日志写回仓库 data/logs，会让「换个数据目录做隔离测试」
  // 变成一句假话——隔离实例照样在污染真实日志。
  const dataDir = base.LSC_DATA_DIR ?? abs(profile.dataDir);

  return {
    NODE_ENV: base.NODE_ENV ?? profile.nodeEnv,
    LSC_PORT: base.LSC_PORT ?? String(profile.port),
    LSC_DATA_DIR: dataDir,
    LSC_SERVE_CLIENT: base.LSC_SERVE_CLIENT ?? (profile.serveClient ? '1' : '0'),
    LSC_CONSOLE_LOG_FILE: base.LSC_CONSOLE_LOG_FILE ?? path.join(dataDir, 'logs', profile.consoleLogName),
  };
}

/**
 * 列出被环境变量压过的键，供启动横幅提示。
 *
 * 静默覆盖是这个设计里唯一不透明的部分，所以必须能看见：档案说 3011、实际起在 3010 时，
 * 屏幕上得有句话解释为什么。
 */
export function overriddenKeys(name, { root, base = process.env } = {}) {
  // 拿档案的原始取值当基准。**不能**跟 base 比：环境变量赢了之后 resolved[key] 就等于
  // base[key]，那样比出来永远是「没被覆盖」，这函数会变成一句哑的。
  const baseline = profileEnv(name, { root, base: {} });
  const resolved = profileEnv(name, { root, base });
  return Object.keys(resolved).filter((key) => base[key] !== undefined && resolved[key] !== baseline[key]);
}
