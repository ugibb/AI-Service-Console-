# AI Service Console（AI 服务控制台）

一台 **Windows 机器**上的本机服务控制台：列出这台机器上跑着的自建服务，一键启停重启，
并实时跟着看它们自己写的日志文件。目标是省掉「RDP 进去 → 找目录 → 回忆命令」这两步。

同一套后端两种交付形态：**Web 版**（浏览器访问）与**桌面版**（单个 exe，双击即用，目标机无需装 Node、无需联网）。

- 需求与决策：[`02-doc/02-design/010-prd.md`](02-doc/02-design/010-prd.md)（v3.0，权威）
- 任务与验收标注：[`02-doc/02-design/020-tasks.md`](02-doc/02-design/020-tasks.md)
- 桌面版打包方案：[`02-doc/02-design/030-desktop-packaging.md`](02-doc/02-design/030-desktop-packaging.md)（v1.0；P0/P1 已完成，P2/P3 待做）
- 场景与用户决策：[`01-init/010-init.md`](01-init/010-init.md)

## 使用说明

后端只有一份，两种跑法：**桌面版**（单个 exe，双击即用）和 **Web 版**（bat 启动 + 浏览器）。
功能完全一致——登记服务、启停重启、看日志，界面是同一套前端。按目标机器的条件选：

| | 桌面版（CS 可执行文件） | Web 版 |
|---|---|---|
| 形态 | 单个 `.exe`，双击即用 | `.bat` 启动，浏览器访问 |
| 目标机要装 Node 吗 | **不用**，运行时已打进去 | 要（Node 20 以上） |
| 界面 | 独立窗口 | `http://127.0.0.1:3010` |
| 监听端口 | 系统随机分配空闲端口 | 固定 3010 |
| 开机自启 | **暂未做**（P2） | `install-autostart.bat`（需管理员） |
| 适合 | **无外网的机器**、不想装环境 | 已装好环境的机器、日常开发调试 |

### 方式一：桌面版（单文件 exe，无外网目标机推荐）

**① 打包——在能上网的机器上做一次**

```bat
npm install
npm run dist
```

产物是 `release\AI-Service-Console-1.0.0-portable.exe`，约 96 MB，单文件自包含，**不依赖目标机的 Node**。

> **打包前置：Node ≥ 22.12。** electron 44 与 electron-builder 都依赖 `require(esm)`，该能力在
> Node 22.12 才默认开启。在 22.11 这类版本上 `npm install` 会直接报 `ERR_REQUIRE_ESM`，
> 补一个开关即可：`set NODE_OPTIONS=--experimental-require-module` 后再 `npm install`。

**② 部署——拷到目标机**

1. 把 exe 拷到目标机任意**可写**目录（例如 `D:\AIConsole\`），双击运行。
2. 首次运行会在 exe **同级**自动建 `data\`，存 `services.json`、接管档案 `runtime-<端口>.json`
   和控制台自身日志 `data\logs\console.log`。
3. 整个目录拷走 = 带走全部配置。不写注册表、不写 `%APPDATA%`，卸载就是删目录。

**③ 行为约定**

- **端口不用管**：由系统分配空闲端口，从根上避免了 Web 版「3010 被占用起不来」的问题。
  有外部工具需要固定端口时，设 `LSC_PORT=xxxx` 再启动。
- **单实例**：双击第二次不会起两个控制台，而是把已有窗口拉到前台。
- **关窗口 ≠ 停服务**：退出控制台后，已经通过它启动的服务**继续运行**（PRD §9，刻意如此）。
  要停服务请在界面上点「停止」。
- **启动失败会弹窗**：GUI 没有控制台可看，所以缺后端产物、端口被占、权限不足都会明确弹窗，
  不会出现「双击了没反应」。
- 后端日志在 `data\logs\console.log`（2 MB 轮转，保留 3 份）。

> ⚠️ **同一批服务不要在两个控制台里同时管。** 桌面版和 Web 版各自维护自己的 `services.json`，
> 互相看不见对方启动的进程。例如 inFlow Worker 已由 Web 版起着，再从桌面版点一次「启动」就会**双开**。

### 方式二：Web 版（浏览器访问）

```bat
:: 1. 首次运行：装依赖 → 构建前端 → 打开浏览器 → 前台运行控制台
start.bat

:: 2. 确认能打开 http://127.0.0.1:3010 后，注册开机自启（需管理员）
install-autostart.bat

:: 取消自启
uninstall-autostart.bat
```

浏览器打开 `http://127.0.0.1:3010` 即可。注意 `start.bat` 是**前台运行**——
关掉那个 cmd 窗口就等于停掉控制台（已启动的子服务不受影响）。

### 登记一个服务

两种方式界面完全一样：点「新增服务」，填这张表。

| 字段 | 必填 | 说明 |
|---|---|---|
| 名称 | ✅ | 显示用，例如「订单服务」 |
| 工作目录 | ✅ | 启动脚本将在此目录下执行 |
| 启动脚本 | ✅ | 要执行的 `.bat`，建议填绝对路径。**路径含空格没问题**（D1 已修，见下） |
| 日志文件 | ✅ | 服务自己写的日志，控制台**只读**它。文件名按天变的服务用 `{date}` 占位，例如 `D:\svc\logs\{date}.log`，每次读取时展开成当天，不用天天改配置 |
| 端口 | | 选填。不用于探活，但**每次启动前会结束占用该端口的进程**，确保系统里只有一个实例在跑（见「日常操作」）|
| 启动宽限期 | | 选填，单位**毫秒**，留空沿用全局默认（5000）。宽限期内进程还活着就显示「启动中」并计时，超过才判「运行中」。AI 服务加载模型慢，建议填 `60000`（60 秒）或更大 |

**`.bat` 必须是阻塞式的。** 前台一直跑不退出（如 `java -jar app.jar`、`python cps.py`）就没问题；
如果脚本内部用 `start` 起了后台进程、自己却退出了，控制台会判定「启动失败」并给出改造建议。
修法是让脚本等在前台：

```bat
start /wait "" "C:\path\to\app.exe" --args
```

### 日常操作

| 操作 | 说明 |
|---|---|
| 启动 / 停止 / 重启 | 卡片上的按钮；过渡态（启动中/停止中）按钮置灰，避免重复点击 |
| 启动 | **语义是「确保只有一个实例在跑」**：运行中/已接管时点启动 = 先停旧实例再起新的；spawn 之前还会清掉档案残留的每一个进程和占用该服务端口的进程 |
| 停止 | 先 `taskkill /T` 优雅终止整棵进程树，超时后 `/T /F` 强杀；**壳已死、后代还在跑**的服务按档案逐个成员杀；走了强杀会在状态里标「已强制终止」 |
| 看日志 | 日志区 1 秒轮询自动刷新，跨夜常驻的服务在当天日志还没生成时会自动回退读最近一天 |
| 删除 | 运行中的服务不能删（返回 409），防止产生孤儿进程 |

**控制台重启后会自动「接管」**：本控制台启动的服务，在控制台重启后仍显示为「已接管」（紫色徽标）而不是
「已停止」——PID 可见，停止/重启照常可用。凭据是 `data/runtime-<port>.json` 里记的
**整棵进程子树**（`cmd.exe` 壳 + 全部后代），每个成员带 **pid + 操作系统报告的进程创建时间**
（不是「我以为的启动时刻」），重启后**树里至少一个成员**两者都对得上就认领。

记整棵树而不是只记壳，是被真机打出来的（见 `02-doc/03-test/020-test-report.md` 第十一章）：

- 真正持有服务端口的是壳的**孙进程**（现场：`node → cmd.exe → python → python` 才是监听 8083 的那个）；
- 壳**会先死，而后代继续跑**。只记壳的档案在最需要接管时恰好是一张废纸。
- 因此卡片上显示的 pid 是「验明正身里层级最深」的那个——用户拿它去任务管理器核对，看到的是认识的进程；
- **运行期间壳退出、后代仍在跑**的服务不再被判成「异常退出」，而是转「已接管」（现场老代码十几小时里
  一直显示「服务异常退出（退出码 1）」+ `pid=null`，而 python 仍在监听）。

- 进程已自行退出（树里一个不剩）→ 显示 `stopped`，不误报。
- **pid 被复用**（创建时间对不上）→ 丢弃记录、**不杀那个无关进程**，并在卡片上留下提示。
- 不接管**不是本控制台启动**的进程（用户手工起的、别的控制台起的）——那种情况显示 `stopped`。
- `.bat` 用 `start` 把服务甩到树外（成为孤儿）的，仍然接不上——这是 PRD §7.3 那条 `NONBLOCKING_HINT`
  要用户改成阻塞式脚本的原因。

启动前清理有**两条红线**：绝不杀控制台自身及其祖先链（把服务端口误配成控制台端口时会明确报错并
中止启动，而不是自杀）；占用进程杀不掉时**中止启动**（宁可不起，也不能起出第二个实例去抢端口）。
两种情况都会给出可读原因，失败原因码为 `prestart_cleanup_failed`。

## 架构

```text
根 package.json（npm workspaces）
├── server/   Express + node:test        后端：配置持久化 / 进程管理 / 日志 tail / REST API
├── client/   React 19 + Vite + Vitest   前端：服务列表 + 操作 + 日志查看器
├── desktop/  Electron + esbuild         桌面版外壳：单实例 / 数据目录 / 起后端 / 开窗口
└── scripts/  开发与部署脚本
```

- **Web 版**：`server` + `client` + `scripts`，单端口。
- **桌面版**：在 Web 版外面套一层 `desktop/`，后端与前端**一行都不用改**。
- **生产**：单端口。Express 同时提供 `/api/*` 与 `client/dist` 静态资源 → `http://127.0.0.1:3010`
- **开发**：`npm run dev` 并行起后端（3011，只出 API）与 Vite（5173），Vite 把 `/api` 代理到 3011。
  两个端口都取自 `server/src/profiles.js`，前端不再各写一份。

### 后端要点

| 模块 | 位置 | 说明 |
|------|------|------|
| 配置集中项 | `server/src/config.js` | 端口/绑定地址/tail 行数/编码策略/超时，全部可用 `LSC_*` 环境变量覆盖 |
| 配置持久化 | `server/src/db/configStore.js` | `data/services.json`，临时文件 + rename 原子写，写操作串行化；损坏文件备份到 `data/corrupt/` 后降级为空列表 |
| 接管档案 | `server/src/db/runtimeStore.js` | `data/runtime-<port>.json`，存**整棵进程子树**（壳 + 全部后代），每个成员带 pid + OS 创建时间。**刻意不写进 `services.json`**：那份台账只在 init 读一次、每次变更整文件重写且无跨进程锁，把每次启停写进去会把 last-writer-wins 的风险从「配置变更」扩散到「每次启停」；且 pid 属于实例而非配置。按端口分文件使 dev/prod 互不认领。v1 旧档案（只有单 pid）读进来退化成「只记了壳」的树，仍可用 |
| 进程树纯函数 | `server/src/proc/tree.js` | 从一份进程快照里切出子树、验明正身（存活 + 创建时间精确相等）、选代表 pid（层级最深）。不碰进程不碰文件，边界（成环、损坏数据、pid 复用、成员上限）全在单测里穷举 |
| 日志 tail | `server/src/logs/` | 尾部反向分块读 N 行（不整文件读入）；UTF-8 优先、失败回退 GBK（iconv-lite）；文件缺失/是目录/无权限都返回结构化降级 |
| 进程编排 | `server/src/services/procManager.js` | 平台无关状态机；适配器注入，因此在 macOS 上可完整单测。各阶段拆到 `services/lifecycle/`：`start`（含子树补记）/`stop`（对准全部验明正身的成员）/`exit`（含壳死后代仍在 → 转接管）/`adopt`（重启后接管）/`cleanup`（启动前清理） |
| Windows 适配 | `server/src/proc/win32.js` | `shell:true` + `windowsHide`；`taskkill /T` 优雅终止，超时后 `/T /F` 强杀。探测走**一次批量快照**：`wmic process get …/format:csv`（约 150ms 覆盖全部进程，GBK 解码，用于身份/父子链）与 `netstat -ano`（约 50ms，用于端口占用者），而不是按 pid 逐个查询 |

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

### 启动 dev 环境

dev = 后端 3011（只出 API）+ 前端 Vite 5173（改完即生效）。**两条命令，不用改任何配置文件。**

```bash
npm install     # 首次
npm run dev     # 前后端并行（scripts/dev.mjs），输出带 [server]/[client] 前缀
```

看到这几行就绪即可：

```
[server] 环境：开发（--env=development）
[server] 控制台已就绪：http://127.0.0.1:3011
[server] 前端：未托管（本档只出 API，界面由 Vite dev server 提供，见 npm run dev:client）
[client] ➜  Local:   http://127.0.0.1:5173/
```

**浏览器开 `http://127.0.0.1:5173`**——不是 3011，3011 只出 API、没有界面。
之后改 `client/src/**` 的 `.jsx` / `.css` 存盘即生效，页面不刷新、组件状态保留
（React Fast Refresh）；改 `server/src/**` 会自动重启后端。实测：改 CSS 与 JSX 均在
存盘后 2 秒内生效，页面级变量全程存活（确实没有整页刷新）。

也可以拆成两个终端各跑一半：

```bash
npm run dev:server   # 只要后端（3011，node --watch）
npm run dev:client   # 只要前端（5173，把 /api 代理到 3011）
```

**切回生产环境**（先 `Ctrl+C` 停掉 dev，理由见下方「不要同时开着两个控制台」）：

```bash
npm run build        # dev 跑的是源码，生产吃的是 client/dist，改过前端就要重建
npm start            # 生产：http://127.0.0.1:3010（等价于 start.bat）
```

### 两种环境：dev 与 production

环境 = 一组「端口 + 前端由谁提供」的配置，**唯一定义处是 `server/src/profiles.js`**。
切换环境不需要改任何配置文件，只是换一条命令：

| | production（`npm start`） | development（`npm run dev`） |
|---|---|---|
| 后端端口 | **3010** | **3011** |
| 前端 | 后端托管 `client/dist`（需先 `npm run build`） | Vite dev server 提供，**改完即生效**（HMR） |
| 界面地址 | `http://127.0.0.1:3010` | `http://127.0.0.1:5173` |
| 控制台日志 | `data/logs/console.log` | `data/logs/console-dev.log` |
| 服务台账 | `data/services.json` | **同一份**（见下） |
| 接管档案 | `data/runtime-3010.json` | `data/runtime-3011.json`（**分开**，见下） |
| 换端口 | `LSC_PORT=… npm start` | `LSC_PORT=… npm run dev:server` |

只跑其中一半也可以：`npm run dev:server`（只要 API）/ `npm run dev:client`（只要前端）。

**两个档案共用 `data/services.json`**，这是刻意的——开发时想看到真实的服务列表。
代价必须知道：

- **运行态不共享。** 接管档案按端口分文件（`runtime-3010.json` / `runtime-3011.json`），
  所以生产启动的服务在 dev 控制台里**不会被认领**，一律显示「已停止」——这是刻意的：
  共用一份档案的话，dev 控制台会在启动时认领生产的进程，一键「停止」就能误杀生产服务。
- ⚠️ **但「启动」会清理端口占用者。** 端口写进服务配置即声明归属，启动前会结束占用该端口的进程。
  于是 dev 里对一个已停止的服务点「启动」，如果生产控制台起的实例正占着那个端口，
  **被杀的会是生产那个实例**——虽然不会出现两个实例抢端口，但这是个真实的跨环境副作用。
  所以仍然：**停一个、起一个，不要两个一起跑。**
- **不要同时开着两个控制台。** 台账每次变更都是**整文件重写**，没有跨进程锁，
  两边同开就是 last-writer-wins：dev 里新登记的服务会被生产的下一次写入抹掉，
  生产还可能把 dev 里删掉的服务「复活」。

所以「随时切换环境」的正确用法是**停一个、起一个**，不是两个一起跑。

档案名**只从命令行取**（`--env=development`），不认环境变量——否则 shell 或计划任务里
残留一个 `LSC_ENV=development` 就会把生产入口静默变成开发档。名字写错（如 `--env=dev`）
会直接报错退出，不会回退默认档。显式环境变量仍**优先于**档案（`LSC_PORT` 等照常生效），
启动横幅会把生效值与「哪些被环境变量覆盖了」一并打出来。

桌面版相关（详见 [使用说明](#使用说明)）：

```bash
npm run bundle:server   # 把后端打成单文件 desktop/build/server.bundle.mjs（esbuild）
npm run desktop         # 开发模式起桌面版（bundle + electron），改代码重跑即可
npm run verify:bundle   # 在无 node_modules 的隔离目录里验后端产物能独立跑
npm run dist            # 出便携 exe → release/AI-Service-Console-<版本>-portable.exe
```

`desktop/` 是纯粹的**外壳**，不含业务逻辑：单实例锁、定数据目录、起后端、开窗口。
它与后端之间只有 `desktop/server-entry.mjs` 一个接缝。后端用 esbuild 打成单文件，
是为了绕开 npm workspaces 的依赖提升与 electron-builder 之间的摩擦——
打包时 electron-builder 搜不到任何 node_modules 是**预期结果**，不是配置漏了。

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

> **已实测（2026-09-17，真中文 Windows + Node v22.11.0）**：逐条结果、抓到的缺陷与未验证项，见
> [`02-doc/03-test/020-test-report.md`](02-doc/03-test/020-test-report.md) **第十章**。
> 摘要：第 3/4/5/8/9/10 项通过，**第 1、11 项失败**（含空格的 `.bat` 路径无法启动，见 D1），
> 第 6/7/12 项因需管理员权限或测试环境限制未验证。

> **D1 已于 2026-09-18 修复**：`shell: true` 并不给命令路径加引号（cmd 的 `/s` 会剥掉 Node 补的那层），
> 含空格的路径被从第一个空格处截断。修法是命令串自己带引号（`server/src/proc/win32.js` 的
> `buildSpawnCommand`）。回归用例 `server/test/win32.test.js` 里那条**真起进程**的用例，
> 修复前实测 `exit=1` + `'C:\...\Temp\lsc' 不是内部或外部命令`，修复后 `exit=0` + `SPACED-OK`。
> 报告里的 **D2**（`taskkill` 退出码 128 被误判为「进程已不存在」）**仍未修**。

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
- [ ] 日志名按天生成的服务：`logFile` 写成 `06-log\{date}.log` → 响应里的 `path` 是**展开后的当天文件**，读到的是当天内容
- [ ] 同上，但当天文件不存在、前一天存在（跨夜常驻的进程）→ **回退到最近一天**，读到昨天那份，`path` 指向真正读到的文件
- [ ] 同上，但回退窗口内一个文件都没有 → `available:false` + 「日志文件尚未生成」，`path` 是当天该有的路径，不报错

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
- [ ] **控制台重启后**：配置完整恢复；本控制台启动且仍在跑的服务显示「已接管」，PID 可见，
      停止/重启可用；其余显示 `stopped`；日志从文件重新读取
- [ ] 控制台停机期间服务自行退出 → 重启后显示 `stopped`，不误报「已接管」
- [ ] **壳先死、后代还在跑**（真机上是常态）：启动一个服务 → 在任务管理器里只结束那个 `cmd.exe`
      （**不要**结束子进程）→ 控制台应转为「已接管」，pid 显示为仍在监听的子进程；
      再重启控制台 → 仍然「已接管」（旧实现这两步都会失败）
- [ ] **pid 复用**：把 `data/runtime-<port>.json` 里的 `creationDate` 改成一个假值再重启 →
      不认领、不杀那个无关进程，卡片上有「已被其他进程复用」的提示
- [ ] **启动前清理（档案残留）**：启动服务 → 强杀控制台（任务管理器结束 node）→ 重启控制台
      （此时显示「已接管」）→ 让它变成残留档案的场景可改为这时直接点「启动」→
      旧进程被杀、只留一个新实例，状态消息里有「已清理 N 个旧进程」
- [ ] **启动前清理（档案残留只剩后代，且服务没配端口）**：启动一个 `port` 为空的服务 →
      结束它的 `cmd.exe` 壳（只结束壳）→ 强杀控制台 → 重启控制台 → 点「启动」→
      老实例的**后代**被清掉、只留一个新实例（没有端口那道网时，档案里的树是唯一凭据）
- [ ] **启动前清理（端口占用）**：手工起一个占住服务端口（如 `python -m http.server 8083`）→
      在控制台点「启动」→ 占用者被杀、服务正常起来，状态消息里点名了占用者
- [ ] **红线一**：把某服务的端口配成 `3010`（控制台自己的端口）→ 点「启动」→
      中止启动（`start_failed`），提示端口被控制台自身占用，控制台**没有**自杀
- [ ] **运行中点启动**：服务运行中直接点「启动」→ 旧实例被杀、新实例起来，最终只有一个
      （`tasklist` 核对同端口只有一个监听者）
- [ ] 3010 被占用 → 控制台启动失败并提示改端口，不静默退出
- [ ] 手动改坏 `data/services.json` → 启动时告警 + 备份到 `data/corrupt/` + 降级为空列表
- [ ] 手动改坏 `data/runtime-<port>.json` → 备份到 `data/corrupt/` + 降级为空档案（接管是增强能力，
      不该挡住控制台启动）

### 6. 环境变量

下表的「默认」是 **production 档**的取值；development 档会覆盖其中几项（见
[两种环境](#两种环境dev-与-production)）。**显式设置的环境变量优先于档案**——
档案只提供默认值。在启动横幅里能看到最终生效的值。

| 变量 | 默认 | 用途 |
|------|------|------|
| `LSC_PORT` | `3010` | 监听端口（development 档为 `3011`） |
| `LSC_HOST` | `127.0.0.1` | 绑定地址（改 `0.0.0.0` 可供局域网访问，届时请自行评估鉴权） |
| `LSC_DATA_DIR` | `<项目>/data` | 配置与损坏备份目录 |
| `LSC_LOG_TAIL_LINES` | `500` | 默认 tail 行数 |
| `LSC_ADOPTED_POLL_MS` | `5000` | 「已接管」进程的存活轮询间隔（500–60000）。接管的进程不是当前进程的子进程，没有 `exit` 事件，只能轮询感知退出。轮询盯**全部**验明正身的成员，一个不剩才落回 `stopped` |
| `LSC_TREE_REFRESH_MS` | `1000` | 启动窗口内补记接管档案子树的间隔（200–60000）。spawn 那一拍后代往往还没出生，靠这个把新长出来的成员补进档案 |
| `LSC_TREE_REFRESH_WINDOW_MS` | `15000` | 子树补记的持续窗口（500–600000）。超过就停——后代已稳定，再扫 `wmic`（约 150ms/次）只是白烧 CPU。脚本从启动到拉起真正的服务进程耗时超过这个值的，要相应调大 |
| `LSC_SERVE_CLIENT` | `1` | 是否托管前端静态资源，**非 `0` 即为开**（development 档为 `0`：界面交给 Vite） |
| `LSC_AUTOSTART_OPEN_BROWSER` | 开 | 自启时置 `0` 可不自动打开浏览器 |
| `LSC_CONSOLE_LOG` | 开 | 置 `0` 关掉控制台**自身**日志落盘（不影响被管服务的日志） |
| `LSC_CONSOLE_LOG_FILE` | `<dataDir>/logs/console.log` | 控制台自身日志路径 |
| `LSC_CONSOLE_LOG_MAX_BYTES` | `2097152`（2MB） | 单份日志上限，超出轮转 |
| `LSC_CONSOLE_LOG_MAX_BACKUPS` | `3` | 轮转保留份数 |

## 已知偏差与遗留

1. **PRD §7.4 写的 `shell: 'cmd.exe /c'` 不能照抄。** Node 会把字符串形式的 `shell` 当作
   可执行文件名而非「命令 + 参数」，结果是 `ENOENT: spawn cmd.exe /c ENOENT`。
   实现用 `shell: true`（Windows 下 Node 内部就是 `cmd.exe /d /s /c`），语义相同。
   反例与正例都有真实测试：`server/test/win32.test.js`。
   **但 `shell: true` 不等于「路径会被自动加引号」**——引号必须自己加，见上方 D1 说明。
2. **`install-autostart.bat` 用 `schtasks /create /xml` 而不是纯命令行参数。**
   命令行参数表达不了「失败自动重启」，而 PRD §10 明确要求它。
3. **依赖与 PRD §14 的差异**：未使用 `cors`（同源/代理场景不需要）、未使用 `uuid`
   （用 `node:crypto.randomUUID`）。两者都不在 PRD 的集成点清单里。
4. **`.bat` 是否为阻塞式仍未确认**（PRD §17 待确认 #1）。已按「不成立也不会卡在假运行态」
   的方向做了防御（启动窗口内退出、PID 消失都判定 `start_failed` 并给出改造建议）。
5. **非 Windows 平台启停返回 501**，POSIX 实现属 M2，本版未做。
