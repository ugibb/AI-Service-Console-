/**
 * 进程适配器契约。
 *
 * procManager（平台无关编排）只依赖下面的接口，不依赖任何平台 API。
 * 这样：
 * - macOS 上可以用 fake adapter 完整测试状态机（T1.4 标注为 Mac 可验的原因）；
 * - M2 增加 posix 实现时无需改动编排逻辑。
 *
 * 接口：
 *   platform: string
 *   isSupported(): boolean
 *   spawn({ scriptPath, workDir, onStdout, onStderr, onExit }) => Promise<{ pid }>
 *     - spawn 失败（脚本不存在 / 权限 / 不是可执行命令）→ reject(Error)
 *     - onExit({ code, signal }) 在子进程退出时回调一次
 *     - onStdout / onStderr 收到 Buffer 块
 *   killTree(pid, { force }) => Promise<{ ok, notFound?, message? }>
 *     - notFound = true 表示进程已不存在（幂等场景，不算错误）
 *   isAlive(pid) => boolean
 */
import { AppError, ERROR_CODES } from '../lib/errors.js';

export const UNSUPPORTED_MESSAGE =
  '当前主机不是 Windows，M1 版进程启停仅在 Windows 上可用（M2 会补 POSIX 实现）。配置管理与日志查看不受影响。';

/** 非 Windows 占位适配器：只报错，不误做事 */
export function createUnsupportedAdapter({ platform = process.platform } = {}) {
  const reject = () => {
    throw new AppError(ERROR_CODES.ADAPTER_UNSUPPORTED, UNSUPPORTED_MESSAGE, { status: 501, details: { platform } });
  };
  return {
    platform,
    isSupported: () => false,
    async spawn() {
      reject();
    },
    async killTree() {
      reject();
    },
    isAlive: () => false,
  };
}
