# AI Service Console（本地服务统一管理控制台）

一台 **Windows 服务器**上的本机 Web 控制台：列出这台机器上跑着的自建服务，一键启停重启，
并实时跟着看它们自己写的日志文件。目标是省掉「RDP 进去 → 找目录 → 回忆命令」这两步。

- 需求与决策：[`02-doc/02-design/010-prd.md`](02-doc/02-design/010-prd.md)（v3.0，权威）
- 任务与验收标注：[`02-doc/02-design/020-tasks.md`](02-doc/02-design/020-tasks.md)
- 场景与用户决策：[`01-init/010-init.md`](01-init/010-init.md)

## 快速开始（Windows 服务器）

```bat
:: 1. 首次运行：装依赖 → 构建前端 → 打开浏览器 → 前台运行控制台
start.bat

:: 2. 确认能打开 http://127.0.0.1:3010 后，注册开机自启（需管理员）
install-autostart.bat

:: 取消自启
uninstall-autostart.bat
```

浏览器打开 `http://127.0.0.1:3010` → 点「新增服务」登记：名称、工作目录、
启动脚本（`.bat`）、日志文件路径、端口（选填）→ 之后就是点按钮和看日志。

## 架构

```text
根 package.json（npm workspaces）
├── server/   Express + node:test        后端：配置持久化 / 进程管理 / 日志 tail / REST API
├── client/   React 19 + Vite + Vitest   前端：服务列表 + 操作 + 日志查看器
└── scripts/  开发与部署脚本
```

- **生产**：单端口。Express 同时提供 `/api/*` 与 `client/dist` 静态资源 → `http://127.0.0.1:3010`
- **开发**：`npm run dev` 并行起后端（3010）与 Vite（5173），Vite 把 `/api` 代理到 3010

### 后端要点

| 模块 | 位置 | 说明 |
|------|------|------|
| 配置集中项 | `server/src/config.js` | 端口/绑定地址/tail 行数/编码策略/超时，全部可用 `LSC_*` 环境变量覆盖 |
| 配置持久化 | `server/src/db/configStore.js` | `data/services.json`，临时文件 + rename 原子写，写操作串行化；损坏文件备份到 `data/corrupt/` 后降级为空列表 |
| 日志 tail | `server/src/logs/` | 尾部反向分块读 N 行（不整文件读入）；UTF-8 优先、失败回退 GBK（iconv-lite）；文件缺失/是目录/无权限都返回结构化降级 |
| 进程编排 | `server/src/services/procManager.js` | 平台无关状态机；适配器注入，因此在 macOS 上可完整单测 |
| Windows 适配 | `server/src/proc/win32.js` | `shell:true` + `windowsHide`；`taskkill /T` 优雅终止，超时后 `/T /F` 强杀 |

### 前端要点

- 轮询而非 WebSocket（PRD §8.4）：日志 1s、服务状态 1.5s，`usePolling` 负责防重叠与卸载清理
- 状态语义色只定义一次（`StatusBadge`），数据用等宽字体，UI 文案用无衬线

## 开发

```bash
npm install
npm run dev          # 前后端并行（scripts/dev.mjs），带 [server]/[client] 前缀输出
npm test             # server(node:test) + client(vitest)
npm run test:cov     # 覆盖率
npm run build        # 构建前端到 client/dist
```

测试框架选择：

- **server 用 `node --test`**：代码是纯 ESM JS，`node:test` + `node:assert` 零额外依赖，
  自带覆盖率和 watch。集成用例直接起真实 HTTP 服务打真实请求。
- **client 用 Vitest + Testing Library**：Vite 原生集成、jsdom 环境、React 组件测试生态成熟。

### 平台差异：为什么 macOS 上点不动「启动」

M1 只实现 Windows 的进程层。非 Windows 平台下 `/api/services/:id/start|stop|restart`
返回 **HTTP 501** 并附带说明（配置 CRUD 与日志查看不受影响）。这是刻意的：宁可明确报错，
也不要让人误以为「点了没反应」。POSIX 实现是 M2（`server/src/proc/posix.js`，未做）。

## Windows 验证清单

以下项目在 macOS 上**只能写不能验**，交付时标注为「待 Windows 验证」，需要在 Windows 机器上实测。

### 0. 前置

```bat
node -v            :: 需要 20 或更高
npm install
npm run build
```

### 1. 启动与自启

```bat
start.bat                     :: 应自动打开 http://127.0.0.1:3010
curl http://127.0.0.1:3010/api/health
:: 期望：{"ok":true,"data":{"platform":"win32","adapter":"win32",...}}

install-autostart.bat         :: 需管理员；应打印已注册
schtasks /query /tn "AI Service Console" /v /fo LIST
:: 重点看：Task To Run = cmd.exe /c "...\scripts\console-run.bat"
::         Schedule Type = On Logon
::         Repeat: Task 状态、以及「如果任务失败，则重试」是否为 1 分钟 3 次
schtasks /run /tn "AI Service Console"     :: 不重启也能试
:: 退出并重新登录（或重启），确认控制台自动拉起且 logs\console.log 有记录
```

### 2. `.bat` 是阻塞式还是「启动即退出」型（最关键的一项）

这是 PRD §17 的待确认问题，决定 PID 跟踪与树杀是否成立。

```bat
:: 登记一个服务后点「启动」，然后看卡片上的 PID 与任务管理器里的 PID 是否一致
:: 情况 A（阻塞式，如 java -jar / node server.js）：状态稳定显示「运行中」，PID 长期不变 → 符合设计
:: 情况 B（启动即退出型，脚本内部用 start 起了后台进程然后自己退出）：
::    → 应立即变成「启动失败」，且提示里出现「退出码 0」和 start /wait 的改造建议
::    → 这是防御性设计生效的样子；若此时仍显示「运行中」，说明防御失效，需回报
:: 修法（情况 B）：把 .bat 改成阻塞式，例如
::    start /wait "" "C:\path\to\app.exe" --args
::    或直接 call / 前台运行，不要让脚本提前退出
```

### 3. 日志

```bat
:: 造一份 GBK 中文日志，确认页面无乱码
powershell -NoProfile -Command "[IO.File]::WriteAllText('C:\svc\app.log', '服务启动成功`n连接数据库失败：超时', [Text.Encoding]::GetEncoding(936))"
curl "http://127.0.0.1:3010/api/services/<id>/logs?tail=50"
:: 期望：encoding = "gbk"，lines 是正常中文
```

- [ ] 页面日志区 1 秒刷新一次（用 `echo` 持续追加日志，观察是否自动滚动）
- [ ] 日志文件不存在 → 页面显示「日志文件尚未生成（服务可能未启动，或尚未产生输出）」，不报错
- [ ] 把 `logFile` 配成目录 → 显示「配置的日志路径是一个目录，不是文件」
- [ ] 日志被轮转（改名 + 新文件）或截断后，仍能读到最新内容

### 4. 进程树与停止

```bat
:: 找一个会 spawn 孙进程的 .bat（如 cmd → java → …）
:: 点「停止」后确认：
tasklist /fi "imagename eq node.exe"        :: 孙进程不应残留
:: 停止过程中若进程顽抗：日志/状态应显示「已强制终止」（走了 /T /F）
:: 停掉一个已经自行退出的服务：应幂等成功，不报错
```

### 5. 边界与异常（PRD §12）

- [ ] `.bat` 路径不存在 → `start_failed`，卡片上能看到原因
- [ ] 工作目录不存在 → `start_failed`，提示「工作目录不可用」
- [ ] 启动后立即崩溃 → `start_failed`，且能看到退出码与启动诊断输出
- [ ] 对「启动中」的服务再点启动 → 被拒并提示（按钮也会置灰）
- [ ] 删除正在运行的服务 → 被拒 409（防止孤儿进程）
- [ ] 假死服务（进程在、端口不通）→ 显示「运行中」，这是 PRD §9 已接受的限制
- [ ] 控制台重启后：配置完整恢复，运行状态重置为 `stopped`，日志从文件重新读取
- [ ] 3010 被占用 → 控制台启动失败并提示改端口，不静默退出
- [ ] 手动改坏 `data/services.json` → 启动时告警 + 备份到 `data/corrupt/` + 降级为空列表

### 6. 环境变量

| 变量 | 默认 | 用途 |
|------|------|------|
| `LSC_PORT` | `3010` | 监听端口 |
| `LSC_HOST` | `127.0.0.1` | 绑定地址（改 `0.0.0.0` 可供局域网访问，届时请自行评估鉴权） |
| `LSC_DATA_DIR` | `<项目>/data` | 配置与损坏备份目录 |
| `LSC_LOG_TAIL_LINES` | `500` | 默认 tail 行数 |
| `LSC_SERVE_CLIENT` | `0` | 是否托管前端静态资源（`start.bat` 会置 1） |
| `LSC_AUTOSTART_OPEN_BROWSER` | 开 | 自启时置 `0` 可不自动打开浏览器 |

## 已知偏差与遗留

1. **PRD §7.4 写的 `shell: 'cmd.exe /c'` 不能照抄。** Node 会把字符串形式的 `shell` 当作
   可执行文件名而非「命令 + 参数」，结果是 `ENOENT: spawn cmd.exe /c ENOENT`。
   实现用 `shell: true`（Windows 下 Node 内部就是 `cmd.exe /d /s /c`），语义相同。
   反例与正例都有真实测试：`server/test/win32.test.js`。
2. **`install-autostart.bat` 用 `schtasks /create /xml` 而不是纯命令行参数。**
   命令行参数表达不了「失败自动重启」，而 PRD §10 明确要求它。
3. **依赖与 PRD §14 的差异**：未使用 `cors`（同源/代理场景不需要）、未使用 `uuid`
   （用 `node:crypto.randomUUID`）。两者都不在 PRD 的集成点清单里。
4. **`.bat` 是否为阻塞式仍未确认**（PRD §17 待确认 #1）。已按「不成立也不会卡在假运行态」
   的方向做了防御（启动窗口内退出、PID 消失都判定 `start_failed` 并给出改造建议）。
5. **非 Windows 平台启停返回 501**，POSIX 实现属 M2，本版未做。
