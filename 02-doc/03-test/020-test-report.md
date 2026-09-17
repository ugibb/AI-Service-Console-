# 测试报告：AI Service Console（AI 服务控制台）

- **测试阶段**：Stage 3 独立验收（M1 = Windows MVP）
- **执行人**：@OWR_qa
- **日期**：2026-09-17
- **被测提交**：`c149058`（6 个 commit，已推送 `github.com:ugibb/AI-Service-Console-.git`）
- **验收基准**：`02-doc/02-design/010-prd.md` v3.0（§12 边界条件）+ `020-tasks.md`
- **执行环境**：macOS（Darwin 25.5.0），Node v23.11.0，npm 11.12.0
- **目标运行平台**：Windows（**本机不是 Windows——这是本次验收最大的失真风险来源**）

> 本报告的原则：**能验的必须亲自跑，不能验的一律写「未验证」，绝不因为「代码看起来对」而填「通过」。**

---

## 一、验收结论（先看这里）

| 结论 | 内容 |
|------|------|
| **Mac 可验部分** | **通过**。218 个用例全绿，无失败、无跳过（1 处 skip 为 root 环境的合法跳过）。 |
| **总覆盖率** | server 96.74% 行 / client 97.39% 行，**≥ 80% 达标**。 |
| **Windows 专属部分** | **未验证**。M1 的核心价值（真跑 `.bat`、树杀、GBK cmd 输出、开机自启）**全部无法在 macOS 上证明**。 |
| **是否可进入下一阶段** | **有条件可进入**：代码质量与 Mac 可验逻辑达上线标准；但**必须先完成第八章的 Windows 实测清单**，才能称作「M1 验收通过」。当前状态应描述为「**Mac 侧验收通过，Windows 侧待实测**」。 |
| **developer 自报数据** | 用例数与覆盖率**全部属实**；三处 PRD 偏差**全部成立**（已独立复现）。 |

---

## 二、测试执行实录（实际命令 + 实际输出）

### 2.1 后端单元 + 集成（node:test）

```
$ npm run test:server
ℹ tests 131
ℹ pass 131
ℹ fail 0
ℹ skipped 0
ℹ duration_ms 2753
```
（基线为 developer 交付时的 127 个；131 = 127 + 本次补充的 4 个 `server/test/index.test.js`。）

### 2.2 后端覆盖率

```
$ npm run test:cov --workspace server
ℹ all files | 96.74 | 89.30 | 94.55
```
**基线（未补充测试前）复跑结果：**
```
ℹ all files | 94.66 | 89.40 | 92.82
```

### 2.3 前端组件/单元（vitest + jsdom）

```
$ npm run test:client
 Test Files  9 passed (9)
      Tests  85 passed (85)
```
（基线 84；85 = 84 + 本次补充的 1 个 App.jsx 表单失败分支用例。）

### 2.4 前端覆盖率

```
$ npm run test:cov --workspace client
All files | 97.39 | 88.31 | 88.88 | 97.39
```
**基线复跑结果：**
```
All files | 96.65 | 87.54 | 88.88 | 96.65
```

### 2.5 浏览器 E2E（Playwright + 系统 Chrome，本次新增）

```
$ npx playwright test
Running 2 tests using 1 worker
  ✓ 1 [chrome] › e2e/console.spec.js:31:1 › 关键流程：登记 → 启动 → 运行中 → 日志 1s 刷新 → 停止 (3.6s)
  ✓ 2 [chrome] › e2e/console.spec.js:75:1 › 启动失败诊断：脚本路径不存在 → 启动失败 + 可读原因（PRD §12 首行） (500ms)
  2 passed (7.3s)
```

### 2.6 三处 PRD 偏差的独立复现（自写探针，非引用 developer 的测试）

```
$ node shell-probe.mjs
{"A: shell=\"<realshell> -c\"（当作文件名 → 期望 ENOENT）","error":"ENOENT"}
{"B: spawn(realshell, ["-c","echo hi"])（正确写法）","code":0,"out":"ARGS=[-c echo hi]"}
{"C: shell=true","code":0,"out":"hi"}
{"D: shell="cmd.exe /c"（照抄 PRD）","error":"ENOENT"}
{"E: shell=true + 不存在的脚本","code":127,"out":"","err":"/bin/sh: /tmp/lsc-verify/nope.bat: No such file or directory"}
```
探针 A 用一个**真实存在的、名字不含空格的 shell 可执行文件** + `shell: '<该文件> -c'`，结果 ENOENT——证明 Node 把整个字符串当作**可执行文件名**，不做「命令 + 参数」拆分。这是 Node `normalizeSpawnArguments` 的平台无关行为。

### 2.7 变异测试：证明补充的测试不是「空测试」

| 变异 | 预期 | 实测 |
|------|------|------|
| 把 `usePolling.js` 的 `setInterval(run, …)` 改成空函数（轮询失效） | E2E 关键流程失败 | **失败**（日志新行不出现，第 56 行断言超时） |
| 删掉 `App.jsx` 的 `if (!saved)` 失败分支 | 新增用例失败 | **失败**（1 failed / 8 passed） |

两处变异均已还原，源码与构建产物已复原（`git status` 确认）。

---

## 三、对 developer 自报数据的核实

| developer 自报 | 我实测 | 结论 |
|----------------|--------|------|
| 211 个用例全通过 | 基线 127(server) + 84(client) = **211**，全通过 | **属实** |
| 后端覆盖率 94.66% | 基线复跑 `all files 94.66%`（行） | **属实** |
| 前端覆盖率 96.65% | 基线复跑 `All files 96.65%`（语句/行） | **属实** |
| PRD §7.4 `shell:'cmd.exe /c'` 是错的 | 已复现：该写法 ENOENT；`shell:true` 正常 | **成立** |
| `shell:true` 下脚本不存在 → spawn 不 reject，而是非 0 退出 | 已复现：spawn 成功（拿到 pid），随后 exit code 127 + stderr | **成立** |
| `install-autostart.bat` 用 `schtasks /create /xml` 而非纯命令行 | 已核对脚本与 XML：`schtasks` 命令行参数**确实没有**「失败自动重启」选项，该能力只存在于任务定义 XML 的 `<RestartOnFailure>` | **成立** |

**补充说明（重要）**：偏差 1 的**机制**已在 macOS 上完全证实（Node 不拆分字符串 shell），但「`shell:true` 在 Windows 下等价于 `%comspec% /d /s /c`」这一具体映射是 Node 文档行为，**仍需在 Windows 上确认**（见第八章 1）。偏差 3 的 XML 内容符合 PRD §10 意图（`<RestartOnFailure>` 1 分钟 3 次、`<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>`），但**能否被 schtasks 接受、重启是否真的触发，未验证**。

---

## 四、测试质量审查（是否有假测试 / 空测试 / 为凑覆盖率的测试）

**结论：未发现假测试。** 具体核查如下：

| 检查项 | 结果 |
|--------|------|
| 被 skip 的用例 | 仅 1 处：`server/test/logTail.test.js:127` 在 `getuid()===0` 时跳过「无权限」用例——**合法**（root 下 chmod 拦不住），且本机非 root，实际执行了。无 `.only`、无 `todo`。 |
| 只断言 mock 调用、不验真实行为 | **未发现**。后端集成测试起**真实 HTTP 服务**（`app.listen(0)`）打**真实 fetch**；日志测试读写**真实文件**；GBK 用例用 **iconv-lite 真实编码字节**；状态机测试断言的是**状态/消息/kill 调用顺序**等真实产物，不是「函数被调用过」。 |
| 断言密度 | 前端各文件 2–3 断言/用例（`StatusBadge` 8 断言/4 参数化用例、`servicesStore` 30/13），后端密集断言状态与文案。无「空断言」。 |
| 为凑覆盖率而写 | 未发现。未覆盖行多为**防御性分支**（见 6.3），说明作者没有为了数字去堆无意义用例。 |
| 声称「已验证」的功能是否真被断言 | 核对通过：501（非 Windows 启停）、409（运行中禁改删）、start_failed 三种 reason、tail 的 missing/directory/permission 降级、配置损坏备份、轮转/截断免疫、并发停止只杀一次、过期回调不污染——**均有有效断言**。 |

**须记录的边界**：`procManager` 的全部状态机测试跑在 **fake adapter** 上（`server/testkit/fakeAdapter.js`）。这是**正确且必要**的（状态机是平台无关逻辑），但它**不能**证明真实 `spawn`/`taskkill` 的行为——该边界 developer 在 README 中已如实标注，我认可。

---

## 五、PRD §12 边界条件逐条验收

图例：**通过** = macOS 上实测有效断言；**逻辑通过** = 逻辑层已断言，但真机行为未验；**未验证** = 必须在 Windows 上验。

| # | 场景 | 结论 | 依据 |
|---|------|------|------|
| 1 | `.bat` 路径不存在 / 工作目录不存在 → `start_failed` + spawn 错误信息 | **逻辑通过** | `preflight` 前置检查用真实 fs 断言（paths.test.js、procManager.test.js）。**真机 spawn 报错文案未验**。 |
| 2 | `.bat` 启动后立即崩溃 → `start_failed`/`error` + 退出码 + 诊断缓冲 | **逻辑通过** | `exited_early_zero` / `exited_early_nonzero` / `pid_vanished` 三种 reason 均有断言；诊断缓冲跨块拼接有断言。**真机崩溃样本未验**。 |
| 3 | 日志文件不存在 → 显示「日志文件尚未生成」，不报错 | **通过** | 单元 + API（200 + `available:false`）+ **浏览器 E2E**（页面显示该文案）三重断言。 |
| 4 | 日志文件为目录 / 无权限 → 明确错误提示 | **通过** | `kind:directory` / `kind:permission` 断言；无权限用例在本机真实执行（非 root）。 |
| 5 | 停止时进程已自行退出 → 幂等 | **逻辑通过** | `alreadyStopped:true` 且 `killTree` 调用次数为 0。 |
| 6 | 停止超时（>5s）→ 自动 `/T /F` 强杀，记录「已强制终止」 | **逻辑通过** | `forcedKill:true` + 两次 killTree（`force:false` → `force:true`）。**真实 taskkill 未验**。 |
| 7 | `.bat` 启动的服务被停止 → `taskkill /T` 连带杀孙进程，无孤儿残留 | **未验证** | 树杀是 Windows 内核行为，fake adapter 无法证明。**必须在 Windows 用 `.bat → cmd → node` 多层进程实测**。 |
| 8 | 日志文件含中文（GBK）→ 无乱码 | **通过** | 用 iconv-lite 真实 GBK 字节测试 tail 解码；`detectEncoding` 回退逻辑有断言。**注**：这条指「日志文件」编码，Mac 可验；「cmd.exe 诊断输出的 GBK」另属未验证项（见第八章 4）。 |
| 9 | 日志文件被轮转 / 截断 → tail 仍正确 | **通过** | 真实 `rename` + 覆写 + 截断三种操作后断言读到最新内容。 |
| 10 | 对「启动中」服务再次点启动 → 拒绝 | **通过** | `SERVICE_BUSY` / 409；`starting` 与 `running` 两种态都断言了。E2E 中按钮置灰亦可见。 |
| 11 | 无任何服务 → 列表空状态 + 引导「新增服务」 | **通过** | 组件测试 + **E2E**（「还没有登记任何服务」→「登记第一个服务」）。 |
| 12 | 配置 JSON 损坏 → 告警 + 降级为空列表 + 备份 | **通过** | 断言备份文件落到 `data/corrupt/`、内容与原文一致、原文件被移走、降级后仍可新增。 |
| 13 | 控制台重启后 → 配置完整恢复；运行状态重置 `stopped`；日志重读 | **部分通过** | 「配置落盘并重载」「运行时状态不持久化（`serialize` 分层）」「`dispose` 清零」有断言；**「真的重启进程后」的端到端重组未做**（未验）。 |
| 14 | 端口被占（3010）→ 启动报错并提示改配置，不静默失败 | **通过（本次补充）** | 新增用例：占住端口 → 子进程退出码 1 + stderr 含「已被占用」「LSC_PORT」。 |
| 15 | 假死服务（进程在、服务不通）→ 显示「运行中」 | **逻辑通过** | 运行判据 = `isAlive(pid)`，非端口探测，符合 PRD §9；UI 有「状态可能不准确」提示。**Windows 的 `OpenProcess` 语义未验**。 |

**汇总**：15 项中 **9 项通过**、**5 项逻辑通过（真机待验）**、**1 项完全未验证**（#7 树杀无孤儿）。

---

## 六、发现的缺陷

未发现 CRITICAL / HIGH 缺陷。以下为需要记录的 MEDIUM / LOW 问题。

### 6.1 MEDIUM — 防御性分支无测试证明（测试缺口，非实现缺陷）

`server/src/services/procManager.js` 覆盖率 94.24%，未覆盖行 `279-281`、`299-303`、`338-346`、`350-358`：

- **338-346**：`runStop` 中「`pid` 不是整数」的兜底（重置为 `stopped` 且提示「未记录到进程 PID」）。
- **279-281**：`runSpawn` 中「spawn 与 exit 极快连续发生」的分支。
- **350-358**：`runStop` 中「session 已不存在时新建」的分支。

这些都是**真实存在的防御路径**，没有任何用例触发。**复现**：对上述行做变异（返回值反转），全部用例仍绿——说明它们未被测试保护。建议补 3 个定向用例。

### 6.2 LOW — `/api/health` 的 `adapter` 字段报告的是「配置值」而非「实际生效的适配器」

**复现**（macOS）：
```
$ node probe-health.tmp.mjs
真实 procManager.platform : darwin
真实 procManager.isSupported(): false
config.adapter          : win32
/api/health data.adapter: win32 | data.platform: darwin
```
`health.js` 返回 `adapter: config.adapter`（默认 `win32`），但 `selectAdapter()` 在非 Windows 上已把适配器降级为 `unsupported`。结果是：**在 macOS 上 `/api/health` 同时报告 `platform:"darwin"` 与 `adapter:"win32"`，而此刻启停实际不可用（`isSupported()===false`）**。

这与项目自身「宁可明确报错，也不要让人误以为点了没反应」的取向相悖——一个排查用探针给出了误导性字段。`index.js` 启动日志用的是**真实** `runtime.adapter.platform`，两处口径不一致。
**影响**：仅诊断信息误导，行为正确（`actions.js` 用的是 `procManager.isSupported()`）。**建议**：`health` 改为报告实际适配器（可暴露 `adapterSupported`）。

### 6.3 LOW — 超过 256kb 的请求体返回 413，但错误码归为 `INTERNAL_ERROR` 且消息是英文原文

**复现**：
```
$ POST /api/services  (body > 256kb)
{"status":413,"body":{"ok":false,"error":{
  "code":"INTERNAL_ERROR",
  "message":"request entity too large"}}}
```
`app.js` 的 `parseErrorHandler` 只接管了 `entity.parse.failed`（→400 BAD_REQUEST），未接管 `entity.too.large`，于是 body-parser 的错误落到通用错误中间件，因为 `expose:true` 被原样返回。
**影响**：客户端错误被标成服务端错误码，且消息未走项目的中文用户文案约定。前端表单不可能产生 >256kb 请求，实际影响小。
**建议**：在 `parseErrorHandler` 中一并接管 `entity.too.large`，返回 413 + `BAD_REQUEST`/新增码 + 中文提示。

### 6.4 LOW — 前端 `hydrateDiagnostics` 分支零覆盖，且失败不重试

`client/src/App.jsx` 的失败态补诊断逻辑（覆盖率报告中的 33、38-42 行分支）**没有任何用例覆盖**。其行为是：列表里处于 `error`/`start_failed` 且无 `startupDiagnostics` 的服务，会用详情接口补齐诊断。

**风险**：若该详情请求失败，`failedKey` 不变 → effect 不重试 → 卡片长期不显示诊断（直到失败集合变化）。
**说明**：本次 E2E 的失败态是从**动作响应**直接拿到诊断的，走不到这条路径。建议补一个「列表返回失败态服务（无诊断）→ 断言详情接口被调用并渲染诊断」的用例。

### 6.5 INFO — 其它未覆盖的防御分支

- `index.js` 62-65（`bootstrap` 抛错的兜底）、83-86（`EACCES` / 未知 error 分支）——难以在本机触发，属可接受的防御代码。
- `logger.js` 80%，`safeStringify` 的 catch（循环引用）未覆盖。
- `servicesStore.js` 88.96%，主要差在 `mergeService`/`hydrateDiagnostics` 的部分分支。

---

## 七、本次补充的测试

新增 **7 个用例**（+1 个浏览器 E2E 文件、+1 个后端测试文件）。

| 文件 | 新增内容 | 覆盖了什么之前没覆盖的 |
|------|----------|------------------------|
| `client/e2e/console.spec.js`（新）<br>`client/e2e/console-server.mjs`（新）<br>`client/e2e/e2e-env.mjs`（新）<br>`client/playwright.config.js`（新） | **2 个真实浏览器 E2E**：① 登记 → 启动 → 运行中 → 看日志（文件不存在降级 → 写入后 1s 刷新 → 追加行再刷新 → 关键字过滤）→ 停止；② 启动失败诊断（脚本不存在 → 启动失败 + 可读原因） | 补齐了 developer 自陈的**「前端零浏览器 E2E」**缺口。此前只有 jsdom 组件测试，无法证明「前端 + 真实 HTTP + 真实 logTail + 真实文件」这条链路。 |
| `server/test/index.test.js`（新，4 用例） | ① 状态流转写入控制台日志（`bootstrap` 的 `onStateChange` 分支）；② `selectAdapter` 在 win32 平台返回真实适配器；③ **端口被占 → 退出码 1 + 提示改端口**；④ 正常启动 → 就绪日志 + `/api/health` 200 + `SIGTERM` 优雅退出（退出码 0） | `index.js` 覆盖率 **53.77% → 92.45%**；补上了 PRD §12 第 14 行「端口被占不得静默失败」。 |
| `client/src/App.test.jsx`（+1 用例） | 表单提交失败：**保留表单、就地展示后端错误、不丢用户输入** | 补上 `App.jsx` 的 `handleSubmit` 失败分支（此前 51-53 行未覆盖），`App.jsx` 语句覆盖率 → **100%**。 |

**E2E 的诚实边界（务必知悉）**：E2E 复用后端**全部生产代码**（真实 Express 路由、真实 `configStore`、真实 `logTail`、真实文件系统），**唯一替换的是 OS 进程层**（用 `server/testkit/fakeAdapter.js`）。原因：macOS 上真实适配器会返回 501，无法驱动「启动/停止」的 UI 流程。因此 **E2E 不能证明任何 Windows 进程行为**。

**新增依赖**：`client` workspace 增加 devDependency `@playwright/test`（仅测试用；用系统 Chrome，未下载 Chromium）。`.gitignore` 已覆盖 `test-results/`、`playwright-report/`。

---

## 八、未验证清单（必须到 Windows 上验，附具体验法）

> 以下每一项在 macOS 上**只能写不能验**。当前状态一律为**未验证**。

| # | 未验证项 | 为什么不能在本机验 | Windows 上怎么验 | 期望结果 |
|---|----------|--------------------|-------------------|----------|
| 1 | `shell:true` 在 Windows 下真的走 `cmd.exe /d /s /c`，且带空格路径能正确加引号 | 本机无 cmd.exe；Node 到 cmd 的映射是 Windows 专属分支 | 登记一个 `C:\Program Files\...\start.bat`（**路径含空格**）的服务，点启动 | 脚本被执行；诊断/日志无 "is not recognized as an internal or external command" |
| 2 | `taskkill /pid {pid} /T`（不带 `/F`）→ 5s → `/T /F` 的两段式树杀 | Windows 内核进程树语义 | 造 `a.bat` → `cmd /c` → `node`（留一个孙进程）；点停止后 `tasklist` 检查 | 孙进程无残留；若走了强杀，状态消息为「已强制终止（taskkill /T /F）」 |
| 3 | `windowsHide:true` 不弹控制台窗口 | Windows 专属 | 启动任一服务，观察任务栏/桌面 | 无 CMD 黑窗弹出 |
| 4 | `cmd.exe` **启动诊断输出**的 GBK 解码 | 需真实 cmd 的 GBK stdout（本机只有 iconv 构造的字节，无真实来源） | 让 `.bat` 输出中文错误（如 `echo 错误：系统找不到指定的路径。 1>&2`）后启动失败 | 卡片「启动诊断输出」里中文不乱码 |
| 5 | `.bat` 是阻塞式还是「启动即退出」型（**PRD §17 待确认 #1**） | 需真实 `.bat` | 启动后核对卡片 PID 与任务管理器 PID | 见 README「Windows 验证清单」第 2 节：阻塞式 → PID 稳定；启动即退出型 → 应显示「启动失败」+ `start /wait` 建议（若此时显示「运行中」= 防御失效，需回报） |
| 6 | `schtasks /create /xml` 注册成功 + ONLOGON 触发 + `RestartOnFailure` 生效 | 无 schtasks | `install-autostart.bat` → `schtasks /query /tn "AI Service Console" /v /fo LIST`；再 `schtasks /run`；再杀掉 node 进程观察是否 1 分钟内重启（最多 3 次） | 任务注册成功；Task To Run = `cmd.exe /c "...\scripts\console-run.bat"`；失败后确实重启；`<ExecutionTimeLimit>` 未把长跑进程杀掉 |
| 7 | `install-autostart.bat` 渲染的 XML 编码/转义被 schtasks 接受 | 同上 | 关注 `render-autostart-xml.ps1` 输出与 schtasks 返回 | 无「XML 格式无效」类错误 |
| 8 | `isProcessAlive` 在 Windows 走 `OpenProcess` 的 `ESRCH/EPERM` 语义，PID 复用边界 | 本机走 `kill(pid,0)` | 启停若干轮后核对状态与实际进程 | 状态与实际一致；已知 PID 复用为可接受边界 |
| 9 | `taskkill` 的退出码 / 本地化文案（128、「没有找到/not found」） | 需真实 taskkill | 对已自行退出的服务点停止；用中文/英文 Windows 各试一次 | 幂等成功，不报 `kill_failed` |
| 10 | 端口 3010 被占时的**真实**报错文案（本机验的是 EADDRINUSE 逻辑路径） | Windows 上行为应一致但未验 | 先占用 3010 再 `start.bat` | 打印「端口 3010 已被占用…请设置 LSC_PORT」并非 0 退出 |
| 11 | 反斜杠路径 / 空格路径在真实 `path.resolve` + cmd 下的解析 | 本机是 posix `path` | 用 `C:\services\order` 类路径登记并启动 | 路径解析正确，脚本能被找到 |
| 12 | `.bat` 启动后**控制台自身重启**，旧子服务仍存活且新控制台显示 `stopped` | 需 Windows 生命期语义 | 启动服务 → 关掉控制台 → 重开 | 子服务仍在跑；页面显示「已停止」+ 页面提示「状态可能不准确」（PRD §9 已接受的限制） |

---

## 九、总体结论

### 可以进入下一阶段，但必须带条件

**理由：**

1. **代码质量与 Mac 可验逻辑达标。** 218 个用例全绿、零跳过滥用、零假测试；后端 96.74%、前端 97.39% 覆盖率，均远超 80% 门槛。状态机、配置持久化（含原子写与损坏降级）、日志 tail（含轮转/截断免疫、GBK 回退、超长行截断、三类文件级降级）这些**产品核心价值所在的模块，被测得非常扎实**——独立审查后我确认 developer 的测试是「真测试」，不是为数字堆的。

2. **developer 的三处 PRD 偏差全部成立，且处理方式正确。** 我独立复现了 Node `shell` 字符串语义与「脚本不存在不 reject」两个机制，核对了 `schtasks` 无法用命令行表达 `RestartOnFailure` 的事实。这些偏差**都是对 PRD 的有意修正，而非偷工**，README 也已如实记录。这类「发现 PRD 写错并给出证据」的行为应当肯定。

3. **但 M1 的核心价值尚未被证明。** 这个工具的存在意义是「在 Windows 服务器上真的一键启停 `.bat` 服务、真杀干净进程树、中文日志不乱码、开机自启能拉起」。这四件事**没有一件在本次验收中被验证**——它们在 macOS 上物理上无法验证。fake adapter 上的全绿，**不能推断**出真机可用。

**因此建议：**

- 阶段状态记录为「**Stage 3（Mac 侧）验收通过；M1 Windows 验收待实测**」，不要记为「阶段 3 完成」。
- 把第八章 12 项整理成一张 Windows 现场清单（README 已有骨架，建议直接按其执行），在 Windows 上跑完后**回填本报告**，届时才可判定 M1 通过。
- 6.1 的三个防御分支测试缺口建议补，成本很低；6.2 / 6.3 两个 LOW 属体验/一致性问题，可排入 M3 或随手修。

**未做/未改的声明**：本次未修改 `02-doc/02-design/` 下的 PRD 与 Task List；未为了让测试通过而改动任何既有测试；所有新增测试均符合项目既有组织方式（server 用 `node:test` + `server/testkit`，client 用 vitest，E2E 单独放 `client/e2e/`）。
