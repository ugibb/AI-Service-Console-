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
| **→ 后续** | 已于同日完成**真 Windows 现场验证**，见**第十章**。结论：**M1 不能判定通过**，现场抓到含空格路径无法启动等 P0 缺陷。 |
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

---
---

# 第十章：Windows 现场验证结果（2026-09-17 实测回填）

> 本章是第八章「未验证清单」的实测回填。**执行环境是真 Windows**，第 1–12 项逐条实跑，命令与输出均为真实抓取。

- **执行环境**：Windows 10 Pro 1903（build 18363），**中文 Windows，代码页 936（GBK）**，Node v22.11.0，npm 10.9.0，**非管理员**
- **被测提交**：`7e7131c`（从 `github.com/ugibb/AI-Service-Console-.git` **全新 clone**）
- **方法**：造真实 `.bat` 服务夹具（阻塞式 / 启动即退出式 / 含孙进程 / 含空格路径 / 输出 GBK 中文），经真实 HTTP API 驱动，结论以进程表、任务计划、`taskkill` 退出码等**外部证据**交叉核对，不采信应用自报状态

## 10.0 先说阻断项：仓库缺 `server/src/logs/`，clone 下来根本起不来

这是本次现场验证的**第一个、也是最严重的发现**，它使第 1–12 项**全部无法执行**——因为控制台进程本身起不来。

```
$ node server/src/index.js
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
  'F:\00-CC\AI-Service-Console-\server\src\logs\logTail.js'
  imported from ...\server\src\routes\logs.js
```

**根因**：`.gitignore` 第 14 行的 `logs/` 是**未锚定**的模式，会匹配任意深度的 `logs` 目录，于是把**源码目录** `server/src/logs/` 连同运行时的 `logs/` 一起忽略了：

```
$ git check-ignore -v server/src/logs/decode.js
.gitignore:14:logs/    server/src/logs/decode.js
```

**影响**：`server/src/logs/decode.js` 与 `logTail.js` **从未进入版本库**（`git ls-files` 可证；`git fsck` 无悬挂对象，本机也无其他副本）。后果是仓库 clone 后：

- 控制台**无法启动**；
- **35 个 server 测试文件中有 11 个失败**（api / bootstrap / configStore / decode / diagBuffer / index / logTail / procManager / procManagerDefensive / startupGrace / win32）。

> ⚠️ **第八章「218 个用例全绿」的结论在提交版上不可复现。** 该结论在 developer 的 macOS 工作区成立（源文件在本地），但**未被 `git add` 进去**——这正是「只能写不能验」清单存在的意义。

**处置（已修）**：

1. `.gitignore` 的 `data/` 与 `logs/` 改为根锚定 `/data/`、`/logs/`，并加注释说明踩过的坑；
2. 依据**已提交的** `server/test/decode.test.js`（104 行）与 `server/test/logTail.test.js`（155 行）重建 `server/src/logs/decode.js` 与 `logTail.js`。

> ⚠️ **诚实声明**：重建版满足全部既有测试的契约，但**它不是原作者那份实现**。因此在它之上得到的「日志 tail / 编码判定」类结论，验的是**重建版**。要彻底消除这一失真，应由原作者从 macOS 工作区把原文件提交回来，再复跑第 3 项与 §10.2 的日志相关结论。

## 10.1 第 1–12 项逐条结果

| # | 项 | 结果 | 关键证据 |
|---|----|------|----------|
| 1 | `shell:true` 带空格路径加引号 | ❌ **失败（P0）** | 见 10.2-D1，`'C:\lsc' 不是内部或外部命令` |
| 2 | `taskkill /T` 两段式树杀 | ⚠️ **通过（有保留）** | 整棵树 `cmd→node→node` 三进程全灭，无残留；但优雅段对 `windowsHide` 进程**永远无效**，每次停止必等满 5s（见 10.2-D2） |
| 3 | `windowsHide` 不弹控制台窗口 | ✅ 通过 | 服务 `cmd.exe` 的 `MainWindowHandle = 0`、`MainWindowTitle` 为空 |
| 4 | cmd 启动诊断输出的 GBK 解码 | ✅ 通过 | 真实 cmd.exe 吐 GBK 字节 → 诊断区显示 `系统找不到指定的路径。`，无乱码，退出码 3 正确判定 `start_failed` |
| 5 | `.bat` 是阻塞式还是「启动即退出」型 | ✅ 通过（**两种都验了**） | 阻塞式：`starting`→(5s 宽限)→`running`，PID 稳定；启动即退出型：24ms 内退出码 0 → `start_failed` + `start /wait` 改造建议。**防御在两种情况下都成立**，PRD §17 待确认 #1 有了答案：无论用户脚本是哪种，都不会卡在假运行态 |
| 6 | `schtasks /create /xml` + ONLOGON + `RestartOnFailure` | ⏸️ **未验证** | 需管理员权限，本环境无（且注册计划任务属持久化操作，需用户显式授权）。验法见 10.5 |
| 7 | 渲染 XML 的编码/转义被 schtasks 接受 | ⚠️ **部分通过** | 渲染产物为 **UTF-16LE 带 BOM**（`ff fe`）、占位符全部替换、`&`→`&amp;` 与 `<`→`&lt;` 转义正确、`.NET XmlDocument` 解析成功且根元素为 `Task`；**唯 `schtasks /create` 实际接受与否需管理员** |
| 8 | `isProcessAlive` 的 OpenProcess 语义 | ✅ 通过 | 重启后旧 PID 判定为已消失、新 PID 判定为存活，与进程表一致 |
| 9 | `taskkill` 退出码 / 本地化文案幂等 | ✅ 通过（幂等） | 对已自行退出的服务点停止 → HTTP 200 `stopped`，无 `kill_failed`；对 `stopped` 服务重复点停止同样幂等。**但退出码 128 的语义被误判**（见 10.2-D2） |
| 10 | 3010 被占时的真实报错 | ✅ 通过 | 真实 `EADDRINUSE` → `端口 3010 已被占用，控制台无法启动。请关掉占用该端口的程序，或设置环境变量 LSC_PORT 换一个端口后重试。`，**退出码 1**，非静默 |
| 11 | 反斜杠 / 空格路径在真实 `path.resolve` + cmd 下解析 | ❌ **失败** | 与 #1 同源：无空格路径正常，含空格路径无法启动 |
| 12 | 控制台重启后子服务存活、状态重置 | ⏸️ **本环境无法验证** | 见 10.4，测得的「连坐」是**测试环境（作业对象）产物，非产品缺陷** |

**汇总：7 项通过（其中 2 项带保留）、2 项失败（P0 缺陷）、2 项未验证、1 项部分通过。**

## 10.2 现场新发现的缺陷

### D1（P0）`shell:true` 并不给路径加引号——含空格的 `.bat` 完全无法启动

`server/src/proc/win32.js` 文件头注释写着：*「`shell: true`：Windows 下 Node 自动用 `%comspec%`（cmd.exe）/d /s /c "<command>" 执行，**并负责路径加引号（带空格的 .bat 路径可用）**」*。**这句话是错的**，现场实测把它证伪了：

```
登记 C:\lsc verify\spaced\run.bat 并启动：
启动诊断输出：'C:\lsc' 不是内部或外部命令，也不是可运行的程序或批处理文件。
```

从进程表抓到的真实命令行，说明了原因：

```
cmd.exe /d /s /c "C:\lsc-verify\blocking\run.bat"     ← 无空格路径，正常
```

Node 确实包了 `/d /s /c "<command>"`，但 **cmd 的 `/s` 会把最外层这一对引号剥掉**，剥完剩下的 `C:\lsc verify\spaced\run.bat` 就成了「命令 `C:\lsc` + 参数 `verify\spaced\run.bat`」。于是**路径里的第一个空格就把命令截断了**。

最小复现与修复候选（同一条路径，只改 spawn 写法）：

| 方案 | 写法 | 结果 |
|------|------|------|
| A 现状 | `spawn(scriptPath, [], { shell: true })` | ❌ `'C:\lsc' 不是内部或外部命令` |
| B 自己加引号 | `spawn('"'+scriptPath+'"', [], { shell: true })` | ✅ `SPACED-OK` |
| C `windowsVerbatimArguments:false` | 同上加该选项 | ❌ 仍失败 |
| D 对照（无空格） | `spawn(scriptPath, [], { shell: true })` | ✅ `PLAIN-OK`（**证明只在有空格时触发**） |
| E cmd 经典双引号 | `spawn('cmd.exe', ['/d','/s','/c','""'+p+'""'], …)` | ✅ `SPACED-OK` |

**影响**：`C:\Program Files\…`、`C:\Users\Foo Bar\…`、`D:\My Services\…` 在 Windows 上极其常见，这类服务**一个都起不来**。这是现场验证最该抓到的缺陷类型——单测在 fake adapter 上全绿，因为它验的是「命令怎么拼」的纯函数，而**加引号这件事被默认为 Node 会做**。

### D2（P1）`taskkill` 退出码 128 被误判为「进程已不存在」，日志误导且每次停止白等 5 秒

`win32.js` 里 `TASKKILL_NOT_FOUND_EXIT_CODE = 128`，注释写「进程不存在时的退出码」。现场实测，**128 还有另一个完全不同的含义**：

```
$ taskkill /pid 6996 /T          # 不带 /F
错误: 无法终止 PID 24548 (属于 PID 6996 子进程)的进程。
原因: 只能强行终止这个进程(带 /F 选项)。
错误: 无法终止 PID 6996 (属于 PID 21456 子进程)的进程。
ExitCode = 128                    # ← 进程仍然 ALIVE
```

因为 `windowsHide` 进程没有窗口，`taskkill /T`（不带 `/F`）**根本没能力优雅关闭它们**，只能报错返回 128。而现有分类把 128 一律当作「进程已不存在」，于是控制台日志变成了：

```
taskkill /pid 6996 /T → code=128（进程已不存在）      ← 与事实相反：进程活得好好的
（5 秒后）优雅终止超时，改用 taskkill /T /F 强杀
```

**两个后果**：

1. **诊断误导（严重）**。排障时被告知「进程已不存在」，而真相是「进程顽固、必须强杀」——这是把最需要知道的信号说反了。对一个「以诊断为卖点」的工具，这属于核心价值受损。
2. **每次停止都白等满宽限期**。实测停掉一个活着的服务耗时 **5320ms**（`stopGraceTimeoutMs` 默认 5000）。既然优雅段对 `windowsHide` 进程注定失败，这 5 秒是纯粹的等待。

**建议**：区分 128 与文案——`只能强行终止|Unable to terminate|/F` 类文案应映射为「需强杀」而非「已退出」；或干脆对已知走 `windowsHide` 的进程直接跳过优雅段（配置化），把 5 秒省掉。

### D3（P0，即 10.0）`.gitignore` 吞源码目录，仓库开箱不可用

见 10.0，已修。

### D4（文档）README 的 Node 版本下限写错了

README 快速开始写 `node -v :: 需要 20 或更高`。实测：

- `vite@7.3.6` 声明 `engines: ^20.19.0 || >=22.12.0`，本机 Node v22.11.0 会**打印警告**（仍能构建）；
- `jsdom@30.1.0` 声明 `engines: ^22.22.2 || ^24.15.0 || >=26.0.0`，其依赖链在 CJS 里 `require()` ESM，需要 **Node ≥ 22.12（`require(esm)` 默认可用）**。

本机 v22.11.0 下 `npm run test:client` **11 个测试文件全部报 `ERR_REQUIRE_ESM`**（一行测试都没跑）。加 `NODE_OPTIONS=--experimental-require-module` 后 **107 个前端用例全绿**——证明这是**版本下限问题，不是代码问题**。

**建议**：README 改为「Node ≥ 22.22.2（或 20.19+ 但前端测试需要 22.12+）」，并在 `package.json` 的 `engines` 里反映真实下限。

## 10.3 测试用例自身的 Windows 可移植性缺陷（3 处，已修）

这三处都是**测试写了 macOS 专属假设**，在 Windows 上必然失败。修的是测试，不是产品代码；每处都加了注释说明原因。

| 文件 | 问题 | 处置 |
|------|------|------|
| `server/test/logTail.test.js` | 「无读取权限 → 明确提示」用 `chmod 0o000` 造 `EACCES`。**Windows 的 chmod 只切只读属性**：实测 `chmod 0o000` 后模式是 `444`，文件照样能读 | 加 `process.platform === 'win32'` 跳过，注明需 ACL 才能构造（属 M2） |
| `server/test/index.test.js` | 「收到 SIGTERM 优雅退出（退出码 0）」依赖 SIGTERM 投递。**Windows 上 `kill(pid,'SIGTERM')` 是无条件强杀**：实测退出码 `null`、处理器**根本不执行** | 保留跨平台成立的断言（起来了 + `/api/health` 200），优雅退出断言仅在非 Windows 执行 |
| `server/test/win32.test.js` | ① 用 `toString('utf8')` 解码 cmd 的 **GBK** stderr，再匹配 `/找不到/`——中文 Windows 下必然匹配不上（乱码）；② 正例用 `run.sh`（`#!/bin/sh`）却在 Windows 下经 cmd.exe 执行，注定失败 | ① 改用 `decodeAuto` 解码（顺带成了「真实 GBK 字节」的覆盖），并补上中文实际文案；② 按平台改用 `.bat` |

> 顺带证伪一条断言：中文 cmd.exe 的实际文案是 **「不是内部或外部命令」**，测试原本假设的「找不到」是**另一类错误**的措辞。

## 10.4 第 12 项为何在本环境无法验证（以及为什么不能记成「失败」）

第 12 项要求「控制台退出后子服务仍存活」。**首次实测结果为「子服务一起死了」**，但经查证这是**测试环境产物，不是产品缺陷**：

- Windows 上 `taskkill /F` **不带 `/T` 不会连坐子进程**，正常情况下子进程会被托管存活；
- 用 `IsProcessInJob` P/Invoke 实测：**调用方的父进程处于 Windows 作业对象中 = `True`**。Claude Code 的 shell 运行在带 `KILL_ON_JOB_CLOSE` 语义的作业对象里，作业关闭时**整组成员一并终止**，于是子服务被连带杀掉；
- 反向对照：把一个**从不写 stdout/stderr** 的服务（排除「父死→管道破裂→EPIPE 致死」这一假说）拿来重测，**同样一起死**——进一步坐实是作业对象而非管道。

**结论**：本环境的进程树语义被作业对象改写，**第 12 项在此不可靠验证**，既不能记「通过」也不能记「失败」。验法：在真实服务器上由 `start.bat`（资源管理器/登录自启）拉起控制台，再关掉控制台窗口，用 `tasklist` 看子服务是否残留。

## 10.5 未验证项的补齐做法

| 项 | 为什么没做 | 怎么补 |
|----|-----------|--------|
| 6 `schtasks` 注册/触发/失败重启 | 注册计划任务是**持久化系统改动**，且需管理员提权；本环境非管理员。**不应由我擅自注册** | 在目标服务器上以管理员跑 `install-autostart.bat`，再 `schtasks /query /tn "AI Service Console" /v /fo LIST` 核对 `Task To Run` / `Schedule Type = On Logon` / `RestartOnFailure`；完成后用 `uninstall-autostart.bat` 清理 |
| 7 剩下一半：`schtasks /create /xml` 实际接受 | 同上 | 同上，重点看有无「XML 格式无效」类报错 |
| 12 控制台重启生命周期 | 见 10.4 | 在真实服务器上按 10.4 的方法复测 |

## 10.6 本次验证后的测试基线（真 Windows）

```
server:  tests 152 | pass 151 | fail 0 | skipped 1   （1 处跳过 = 10.3 的 chmod/EACCES，不可在 Windows 构造）
client:  Test Files 11 passed | Tests 107 passed     （需 NODE_OPTIONS=--experimental-require-module，见 D4）
```

> 与第八章的「218」不同：那是 developer 交付时的口径且**在提交版上不可复现**（缺 `server/src/logs/`）。修好之后本机实测为 **258 通过**。

## 10.7 本章结论

**M1 不能判定为通过。** 现场验证抓到一个 **P0 功能缺陷（D1：含空格路径的服务完全无法启动）**，它与本工具的核心用途（在 Windows 上真的一键启停 `.bat` 服务）正面冲突；另有一个 **P0 可达性缺陷（D3：仓库开箱起不来）** 和一个 **P1 诊断/体验缺陷（D2）**。这三项修完并复验前，第 1、2、9、11 项都无法给出「通过」。

值得肯定的是：**第七章标注为「只能写不能验」的四件事，有三件在真机上是成立的**——树杀确实杀干净了整棵进程树（第 2 项）、`windowsHide` 确实不弹窗（第 3 项）、**真实 cmd.exe 的 GBK 中文诊断输出确实不乱码**（第 4 项）、阻塞式/启动即退出两种 `.bat` 的防御判定都正确（第 5 项）。这些是 macOS 上无论如何都证明不了的，现在有真机证据了。

**建议的下一步顺序**：

1. **修 D1**（含空格路径加引号，候选 B/E 已实测可行）→ 复验第 1、11 项；
2. **修 D3 的遗留**：请原作者从 macOS 工作区提交**原始的** `server/src/logs/`，替换重建版，复跑日志相关结论；
3. **修 D2**（128 的语义区分 + 优雅段是否跳过）→ 复验第 2、9 项；
4. **改 D4**（README 与 `engines` 的 Node 下限）；
5. 补验第 6、7、12 项（需管理员/真实服务器）。

**本次对仓库的改动**：`.gitignore`（锚定运行时目录）、`server/src/logs/`（重建 2 个文件，**含上述失真声明**）、3 个测试文件的 Windows 可移植性修正。**未改** `02-doc/02-design/` 下的 PRD 与 Task List，**未改** `server/src/proc/win32.js` 等任何产品代码——D1/D2 只做定位与修复候选实测，留给作者决定。

---
---

# 第十一章：接管（adopt）与启动前清理的现场验证（2026-09-18）

> 本轮验的是两个**新功能**（它们推翻了 PRD §9 原先「v1 不做接管」的结论）：
> **启动前清理**（点「启动」= 先杀掉占用者再起，确保系统里只有一个实例）与
> **真接管**（控制台重启后认领上个会话启动、仍在运行的进程，显示新状态「已接管」）。
>
> **执行环境**：Windows 10 Pro 1903（build 18363），中文代码页 936（GBK），Node v22.11.0，**非管理员**，
> 与第十章同一台机器。所有实验在**隔离的 scratch 环境**里跑（控制台端口 3097/3098/3099，服务端口 8097/8098/8099，
> 独立 `LSC_DATA_DIR`），**全程未触碰**线上控制台（3010）与其托管的 Calibre-Web（8083）。

## 11.0 结论摘要（先看这里）

| 功能 | 结论 | 依据 |
|------|------|------|
| 启动前清理（确保单实例）| ✅ **通过** | 见 11.2，含真机上「只能强杀」的进程被成功清掉 |
| 真接管（adopted）| ✅ **通过**（方案 A，见 11.8）| 11.3 定位的设计缺陷**已在 11.8 修复并真机验证**：锚点从「单个壳」改为「整棵后代树」，四步现场全部通过 |

本轮共修掉 **4 个产品缺陷 + 1 类测试自身缺陷**（11.1），在真机上验证通过清理链路（11.2）；
11.3 暴露的接管设计缺陷**未停留在「留待决策」，已于 11.8 按方案 A 实现并验证**。

## 11.1 本轮修掉的缺陷

### E1（P0）优雅终止失败被当成「杀不掉」——退出码 255 让「占用就杀」彻底落空

**真机现场**（`taskkill /PID 10824 /T`，10824 是占着 8098 的 python）：

```
错误: 无法终止 PID 10824 (属于 PID 1552 子进程)的进程。
原因: 只能强制终止此进程(带 /F 选项)。
```

退出码 **255**。`classifyTaskkillResult` 正确地判为「失败」（不是 128/not found），但
`cleanup.js:terminatePid` 与 `stop.js:terminate` 当时的写法都是：

```js
const graceful = await runtime.adapter.killTree(pid, { force: false });
if (!graceful.ok) return false;   // ← 就此放弃，永远走不到 /F
```

于是**恰恰因为杀不掉，反而不去强杀**。后果是用户选定的「占着端口就杀」完全落空：

```
start_failed - 启动前清理失败：无法结束占用端口 8098 的进程 python.exe（pid=10824）。
已中止启动，请手动处理该进程后重试。
```

启动被否，而占用者原样活着、还在占端口——卡片只丢给用户一句「请手动处理」。
python 这类**没有窗口消息循环**的进程全都命中这一类，而它们正是本工具最常见的托管对象。

**修法**：优雅失败不再当终点，降级 `/F` 重试；**强杀再失败才是真的杀不掉**（红线 2 保留）。
两个文件同一条政策，各自加注释说明缘由。

**修后真机复验**（同一个孤儿 python(10824)，其父进程已死）：

```
点「启动」→ 耗时 355ms | 状态 = starting | 新 pid = 21904
旧占用者 pid=10824 已不存在          ← /F 清掉了
端口 8098 占用: python.exe(pid=528, ppid=21904) → 监听者 1 个   ✅
```

### E2（P1）`startedAt` 跨持久化边界静默掉成 null

内存里 `startedAt` 是 **epoch 毫秒（number）**，而 `runtimeStore` 的规范化只认字符串
（`typeof raw.startedAt === 'string' ? raw.startedAt : null`）。于是**每次落盘都静默丢成 null**，
重启后「已接管」的卡片上永远看不到启动时刻——不报错、不崩溃，只是数据没了。

**修法**：`persistPid` 落盘时转 ISO 串（与 `savedAt` 一致，给人看），`adopt.js` 读回时 `Date.parse` 转回毫秒；
并在 `adopt.test.js` 加**往返断言**（`entry.startedAt === new Date(first.startedAt).toISOString()`）。

### E3（P1）终态监听器把 `starting` + `pid=null` 当成终态，删掉刚写的档案

终态清理的判据原本是 `PERSISTED_ALIVE_STATES.includes(status) && Number.isInteger(pid)`。
但 `start()` 的**首个 patch** 是 `STARTING` + `pid: null`（用来清掉展示用的旧 pid），
被这个条件判成「非存活」→ 立刻删档案。而 `start()` 后面才写档案，于是「写完即被删」。

表现为 `cleanup.test.js` 的「档案残留」用例失败：旧实例该被清理却没被清理。
**修法**：只看状态不看 pid（注释里写明了为什么不能看 pid）。

### E4（P1）`dispose()` 后代数复用，旧会话的迟到回调冒充当代

代数原本取 `latest.generation + 1`，而 `dispose()` 会清空状态表 → 代数从 1 重新开始。
「模拟控制台重启」恰好就是这个场景：旧会话里 `killTree` 触发的迟到 `onExit` 拿到与新会话**相同**的代数，
通过了 `handleExit` 的过期守卫，给新一代写了个终态。

表现为测试里 `'start_failed' !== 'running'`。**修法**：`runtime.nextGeneration()` 全局单调递增计数器，
`dispose()` 也不复位。

### E5（P1，测试自身）固定 `sleep` 抢在 `persistPid` 前面 —— 一次真实的随机失败

全量跑出现 **`# tests 224 | # pass 222 | # fail 1`**（未落盘输出），随后 5 轮全绿。
在 CPU 压力下反复重跑（**15 轮全量 + 8 轮聚焦**）均未复现，属于低概率抖动。

定位：`start()` 里 `void runtime.persistPid?.(id, pid)` 是 **fire-and-forget**，
要先跑一次 wmic 快照再落盘；而测试用 `await sleep(20~30)` 赌它写完，机器一忙就赌输——
于是在「档案还没写」时 `dispose()`/断言，表现为「状态不是 adopted」「档案为空」，
**看着像产品缺陷，其实是测试自己抢跑**。

**修法**：`testkit/harness.js` 新增 `waitForArchive` / `waitForArchiveGone`（轮询到出现/消失，超时 2s），
替换 `adopt.test.js`、`cleanup.test.js`、`api.test.js` 里全部 6 处固定 sleep。修后 10 轮压力全绿。

> ⚠️ 诚实记录：那次失败的具体用例**没有留下输出**，上述定位是从竞态结构反推的，
> 修掉之后未再复现。**不能据此宣称「已经修好了那一例」**——只能说这一类竞态已经被消除。

## 11.2 实测通过的部分：启动前清理

在隔离环境跑通完整链路（`e2e-live.mjs`，真实控制台 + 真实 `.bat` + 真实 python）：

| 场景 | 结果 |
|------|------|
| 端口被**孤儿**进程占用（父已死）| ✅ 清掉，新实例起来，端口上只剩 1 个监听者 |
| 占用者**只能强杀**（退出码 255）| ✅ 降级 `/F` 成功（E1 的现场） |
| 服务 `starting` 状态下去重、清理消息可见 | ✅ 说明栏出现「已清理 1 个旧进程」 |
| 接管态/停止时走 `/F` | ✅ 状态 `stopped`，说明「已强制终止（taskkill /T /F）」 |
| 停止后档案清空 | ✅ `runtime-3097.json` 的 `services` 回到 `{}` |
| 启动前清理不影响无关进程（pid 被复用）| ✅ 断言「无关进程毫发无损」 |

**顺带确认了一条设计上的错位**（不是缺陷，但决定了接管的难度）：

```
档案记的壳 : cmd.exe(30992)              ← 控制台记录的就是它
真实端口占用: python.exe(12936, ppid=30992) ← 真正 LISTEN 的是它的子进程
```

三轮实验都是这个形状：**记录的壳与真正持有端口/服务的进程差一层（都是 `.bat` 壳 → python 真身）。**

## 11.3 接管的身份锚点会随控制台一起死（P0，设计问题，**已在 11.8 按方案 A 修复并验证**）

> 本节保留当时的**诊断与证据**（它把问题定得准，是 11.8 的出发点），
> 但结尾的「未修」「留待决策」「文档与实现不一致」三处结论**均已作废**，以 11.8 为准。

### 现象

三轮独立实验，**3/3** 都是同一个结果（`tally.mjs` 直接查进程表）：

| 轮次 | 控制台端口/服务端口 | 档案记的壳 | 真身（端口持有者） |
|------|--------------------|-----------|-------------------|
| 第 1 轮 | 3099 / 8099 | `cmd.exe(11112)` ❌ **已死** | `python.exe(18888)` ✅ **活着** |
| 第 2 轮 | 3098 / 8098 | `cmd.exe(1552)` ❌ **已死** | python 10824（后被清理测试杀掉）|
| 第 3 轮 | 3097 / 8097 | `cmd.exe(30992)` ❌ **已死** | python 12936（后被「停止」杀掉）|

控制台日志（第 3 轮，脱壳启动的新控制台）：

```
[E2ESvc] 档案进程 30992 已不存在，不接管
```

→ 状态落回 `stopped`，pid 为 null。**产品这一步是对的**：锚点确实死了，不认领才是正确的。
**错的是设计假设**——「记录的壳会比控制台活得久」。

### 一个必须纠正的前置误判

本会话早前曾据第 1 轮实验得出「杀掉控制台后记录的 `cmd.exe` 存活 → 接管可行」。
**该结论是错的**：当时的探针 `kill-console.mjs` 只检查了**端口是否仍被监听**，
没有检查**档案里那个 pid 是否还活着**。我把「服务活着」误当成了「记录的壳活着」。
上表是直接查进程表得到的，与端口无关。

### 机制：未确定，只有假设

观察到的分工是「壳死、真身活」。假设（**未验证**）：`cmd.exe` 与创建它的控制台 node 进程共享同一个
（因 `windowsHide` 而隐藏的）console，node 退出时 conhost 被销毁，附着的 `cmd.exe` 收到
`CTRL_CLOSE_EVENT` 而终止；而 python 孙进程的处置不同，因而存活。

**必须按第十章 10.4 的口径对待**：本环境的进程树语义受作业对象影响，
**这类结论在被真实服务器（由 `start.bat` 从资源管理器/登录自启拉起）复核之前，不能当作定论。**
复核方法：在真实服务器上启动服务 → 关掉控制台 → `tasklist /FI "PID eq <档案里的 pid>"` 看壳是否残留。

### 影响与可选出路（**留待决策，本轮不实现**）

当前代码的行为是**诚实降级**：认不出就不认领，显示 `stopped`，并靠**启动前清理**兜住
（11.2 已证明清理这张网是可靠的）。也就是说「确保只有一个实例在跑」这个用户主诉**已经成立**，
不成立的是「重启后仍显示已接管」。

若要让接管真正可用，可选：

| 方案 | 说明 | 结局 |
|------|------|------|
| A. 记录整棵后代树 | spawn 后枚举子树（壳 + 后代）全部落盘，对账时认「仍在世且创建时间匹配的最深那个」 | ✅ **已采用**，见 11.8 |
| B. 记录端口持有者 | 落盘时同时解析端口占用者，把它作为第二身份锚点 | 不必再做：A 已覆盖该场景，且对**无端口服务**同样适用 |
| C. 放弃接管 | 保留现状（诚实降级 + 清理兜底），删掉 `adopted` 状态与 PRD §9.1 | 已无必要 |

> ⚠️ ~~**文档与实现此刻不一致**：PRD §9.1 与 README 已按「接管可用」的措辞写好，
> 而实测表明在当前启动方式下它接不上。**在方案选定之前，不宜按现状交付。**~~
>
> ✅ **该警告已解除（11.8）**：方案 A 落地并真机验证通过后，PRD §9.1/§9.2/§7.1/§7.2 与 README
> 的措辞与实现一致，且实现经过实测。

## 11.4 环境自身的坑（曾是误报来源，不是产品缺陷）

这两条各浪费了一轮验证，记下来供后来者绕开：

| 坑 | 表现 | 规避 |
|----|------|------|
| **`tasklist` 的输出是 GBK** | 按 `utf8` 解码得到乱码，`/没有/` 之类的**本地化文案正则永远匹配不上** → **把已死的 pid 报成「活着」**。本会话第一轮「接管被无故拒绝」的假象就是这么来的 | 判定存活用 `process.kill(pid,0)` 或 `wmic` + GBK 解码（`iconv-lite`），**别解析 `tasklist` 的自然语言输出** |
| **上一轮的控制台还占着端口** | 新控制台 bind 失败秒退，测试却继续打 API → **一直在跟上一轮（旧代码）的控制台说话**，整轮结论作废 | 起控制台后**先断言「监听该端口的 pid == 我刚起的 pid」**，不符就退出（`e2e-live.mjs` 已内置） |

另有一条**夹具**坑（不是产品问题）：`.bat` 文件必须是 **CRLF**。
用 LF 写时 `cmd.exe` 会把上一行的 `rem` 注释和下一行**并成一条命令**，报
`'8099' 不是内部或外部命令` 并以退出码 1 秒退。测试夹具用 Node 写 `.bat` 时要显式 `\r\n`。

## 11.5 本轮测试基线（真 Windows）

```
server:  tests 224 | pass 223 | fail 0 | skipped 1   （1 处跳过 = 10.3 的 chmod/EACCES，不可在 Windows 构造）
client:  Test Files 11 passed | Tests 111 passed     （需 NODE_OPTIONS=--experimental-require-module，见 D4）
e2e:     2 passed（Playwright + 系统 Chrome）
lint:    eslint . 干净
```

稳定性：全量套件在 CPU 压力下连跑 **10 轮**全绿（E5 修前 15 轮全量 + 8 轮聚焦亦全绿）。

## 11.6 对仓库的改动（本轮）

**产品代码**

| 文件 | 改动 |
|------|------|
| `server/src/db/runtimeStore.js` | **新增**：接管档案（每实例一文件 `runtime-<port>.json`） |
| `server/src/services/lifecycle/adopt.js` | **新增**：对账 + 认领 + 低频存活轮询 |
| `server/src/services/lifecycle/cleanup.js` | **新增**：启动前清理（两类占用者 + 两条红线）；**本轮修 E1** |
| `server/src/services/lifecycle/stop.js` | **本轮修 E1**（优雅失败降级 `/F`） |
| `server/src/services/lifecycle/runtime.js` | **本轮修 E4**（单调代数计数器） |
| `server/src/services/lifecycle/start.js` | 启动前清理接入 + 落档案；**本轮修 E4** |
| `server/src/services/lifecycle/constants.js` | 新状态 `ADOPTED`、新失败原因 `PRESTART_CLEANUP_FAILED` |
| `server/src/services/procManager.js` | `persistPid`、终态清档案；**本轮修 E2、E3** |
| `server/src/proc/win32.js` | `listProcesses`（wmic 批量快照）、`portOwners`（netstat）、`classifyTaskkillResult` |
| `server/src/config.js` 等 | `adoptedPollIntervalMs`（`LSC_ADOPTED_POLL_MS`，默认 5000） |
| `client/` | `StatusBadge` 新增 `adopted` 语气、`ServiceCard` 启停按钮判据、`ServiceList` 统计与免责声明移除 |

**测试**：新增 `adopt.test.js` / `cleanup.test.js` / `runtimeStore.test.js`；
`testkit/harness.js` 新增 `waitForArchive`/`waitForArchiveGone`（**修 E5**）；
`testkit/fakeAdapter.js` 新增 `seedProcess`/`seedPortOwner`；`api.test.js` 增加 HTTP 层接通用例。

**文档**：`02-doc/02-design/010-prd.md`（§6/§7.1/§7.2/§9.1/§9.2/§12）、`README.md`（模块表、环境变量、dev/prod 警告、验证清单）。

**11.8（方案 A）追加的改动**

| 文件 | 改动 |
|------|------|
| `server/src/proc/tree.js` | **新增**：`collectSubtree` / `proveMembers` / `representativePid` / `sameTree`（纯函数，无 OS 依赖） |
| `server/src/db/runtimeStore.js` | 档案升到 v2：每条记录带 `tree` 数组；v1 档案降级为单成员树，向前兼容 |
| `server/src/services/procManager.js` | `persistPid` 改存整棵树；新增 `refreshTree` / `aliveArchivePids` / `provenMembers` / `provenPids` |
| `server/src/services/lifecycle/{adopt,start,exit,stop,cleanup}.js` | 对账改按树判定；启动后 15s 树刷新；壳死子活→接管；停止/清理按**已证明成员**逐个杀 |
| `server/src/services/lifecycle/runtime.js` | 新增 adopt-pid 登记表（供接管后的存活轮询使用） |
| `server/src/config.js` | `treeRefreshIntervalMs`（`LSC_TREE_REFRESH_MS`）、`treeRefreshWindowMs`（`LSC_TREE_REFRESH_WINDOW_MS`） |

> 工作区里另有**本轮之外**的未提交改动（`desktop/` 打包、`server/src/profiles.js`、`server/src/lib/fileSink.js`、
> `server/src/logs/` 等），不属本次验证范围，未在其中做任何改动。

> **关于本章引用的探针脚本**：`e2e-live.mjs`、`tally.mjs`、`kill-console.mjs`、`alive-probe.mjs`、`flake-hunt*.mjs`
> 都是本轮临时写的验证夹具，放在 `tmp-verify/` 下（隔离的 `LSC_DATA_DIR` 与 3097–3099 端口），
> **验证完即随目录一并删除，未入库**。上文的数据是这些脚本在真机上跑出来的结果，脚本本身不随仓库交付。

## 11.7 本章结论（写于 11.3 之后；第 3 条已由 11.8 兑现，其余仍有效）

**「启动前清理」通过，可以交付**：E1 修掉之后，用户主诉「点启动就确保只有一个实例在跑」
在真机上端到端成立，包括最难的一类占用者（只能强杀、且父进程已死）。

~~**「真接管」不通过，不应按现状交付**~~ → **已推翻**：11.8 按方案 A（记录整棵后代树）实现了接管，
四步真机验证全部通过（壳死→接管、控制台重启→接管、停止→整树清干净），
新增 28 个用例后套件全绿（248 通过 / 0 失败）。PRD 与 README 的措辞现已与实现一致。

**建议的下一步顺序**：

1. **先复核 11.3 的机制**（在真实服务器上按 10.4 的方法确认「壳是否真的随控制台死」）——
   这条不确认，方案 A/B/C 都是在猜测上做选择；
2. 复核结论若支持，**通检所有 `if (!xxx.ok) return 失败` 的两段式模式**，确认没有 E1 的同类残留；
3. ~~**接管二选一**~~ → **已选定并完成**：方案 A，见 11.8；
4. 线上控制台（3010 / Calibre-Web 8083）的接管验证**需先取得用户同意**（会杀掉正在跑的服务），
   且线上控制台当前跑的是旧代码、尚无 `runtime-3010.json`，**必须先由新代码启动一次**才可能显示「已接管」。
   本轮验证走的是**隔离的 scratch 控制台（3097）+ 现场服务（8083）**，生产控制台未被触碰，
   这条注意事项**依然有效**。

## 11.8 方案 A 已实现并在真机验证通过（2026-09-18 补测，**取代 11.3 的「未修」结论**）

11.3 把问题定在「身份锚点选错了」：记录的 `.bat` 壳会随控制台一起死，真正持有端口的孙进程活着，
于是对账时「壳已不存在 → 不接管 → 落回 `stopped`、`pid=null`」。补测实现了 11.3 表格里的
**方案 A：记录整棵后代树**，并在真 Windows 上端到端验证通过。

### 实现：从「记一个 pid」改成「记一棵树」

核心变化是**身份不再锚定在单个进程上**，而是锚定在「spawn 那一刻壳及其全部后代」构成的集合：

| 环节 | 做法 |
|------|------|
| **落盘**（spawn 成功后） | 用一次 `wmic` 全量快照（`listProcesses`）枚举壳的整个后代子树，每个成员记 `pid` + `depth` + `name` + OS `CreationDate`，整棵树写进档案（`runtime-<port>.json`，`RUNTIME_STORE_VERSION = 2`）|
| **刷新**（启动后 15s 内） | 每秒重采一次树（`treeRefreshIntervalMs` / `treeRefreshWindowMs`），把晚出生的后代补进档案——`pyp` 这类延迟 fork 的真身就是这样被逮到的 |
| **对账**（控制台启动时） | 对树里**每个**成员查「活着 **且** 创建时间精确相等」，命中集合为空才放弃；**最深**的命中者作为展示用 pid |
| **运行中壳死** | 壳退出时若树里还有存活成员，**不改判失败**，而是走接管：`启动壳已退出（退出码 X），但其子进程仍在运行，已接管` |
| **停止 / 清理** | 目标集 = `[当前 pid, ...已证明的成员]`，逐个 `taskkill /T`（含优雅失败降级 `/F`）；红线不变：**证明不了的一律不杀**，宁可漏杀不可错杀 |

纯函数放在 `server/src/proc/tree.js`（`collectSubtree` / `proveMembers` / `representativePid` / `sameTree`），
有 15 个独立单测（`server/test/tree.test.js`），与 OS 交互完全解耦：环检测、深度上限 16、
成员上限 64、pid 复用（创建时间不等即淘汰）都覆盖到了。

**档案版本兼容**：v1 的老档案（只有 `pid`，没有 `tree`）读取时降级为「单成员树」，
不会因为升级而丢弃已有接管能力，也不会误判。

### 真机验证：四步全部通过

现场就是**线上那对**（Calibre-Web，8083），但用隔离的 scratch 控制台（3097）跑新代码，
生产控制台（3010）全程未动。

**① 档案记的是整棵树（而不只是壳）**

```
pid=16968 树=16968@0,21040@1,26704@1,31048@2
```

`16968` 是 `.bat` 的 `cmd.exe`，`31048`（depth 2）正是**真正 LISTEN 8083 的 python**，
`26704` 是 conhost。11.3 里「锚点与真身差三层」的缺口，被这张表填上了。

**② 只杀壳（不杀树）→ 自动接管，而不是报错**

```
taskkill /F /PID 16968          ← 故意不带 /T，模拟「壳没了、真身还在」
```

这正是线上控制台每天在犯的那个错（旧代码此时会显示 `error` / `pid=null` / 「服务异常退出（退出码 1）」）。
新代码的结果：

```
状态 = adopted   pid = 31048
message: 启动壳已退出（退出码 1），但其子进程仍在运行，已接管（pid=31048，python.exe，共 3 个存活成员）。
```

**③ 杀控制台再重启 → 对账后仍显示「已接管」**

```
状态 = adopted   pid = 31048
message: 控制台重启前已启动，已接管（pid=31048，python.exe）。原启动壳（pid=16968）已退出，服务本体仍在运行。
```

11.3 里「3/3 轮都接不上」的场景，现在是 **1/1 轮接上**，并且**把「壳已死」这个事实如实写进提示**，
而不是假装无事发生。

**④ 停止 → 树里每个成员都被清掉，端口释放**

```
停止返回: forced: true
8083 监听者: （无）
```

三个成员（`21040` / `26704` / `31048`）逐一验证已死。**「确保只有一个实例在跑」这条主诉，
在「壳活着」和「壳已死」两种现场下都成立。**

### 新增测试与基线

新增 4 个 adopt 用例（树落盘、壳死子活→接管、运行中壳退→接管、无端口服务的重启唯一性）、
1 个 cleanup 用例（残留只在后代里时也能清）、4 个 `runtimeStore` 用例（v1 兼容、树往返、坏成员容错、64 上限）、
15 个 `tree.js` 用例，另加 `testkit` 的 `seedChild` / `waitForTreeSize` / `waitForStatus`。

```
server:  tests 248 | pass 247 | fail 0 | skipped 1   （1 处跳过 = 10.3 的 chmod/EACCES，不可在 Windows 构造）
lint:    eslint . 干净
```

### 对 11.3 「留待决策」的交代

11.3 列出的三个方案里，**A 已被采用并验证**；B（记录端口持有者）不必再做——A 已经覆盖了它要解决的
场景，且不需要在落盘时额外解析端口（无端口服务同样适用）；C（放弃接管）已无必要。

11.3 结尾那条 ⚠️「文档与实现此刻不一致」**同时解除**：PRD §9.1/§9.2/§7.1/§7.2 与 README 的措辞
已与实现对齐，且实现经过真机验证。

### 仍未覆盖的边界（诚实记录）

- **线上控制台（3010）此刻跑的仍是旧代码**：它的档案还是 v1（只有 `pid`），
  在它自己被新代码重启一次之前，「壳死 → 报错」的行为不会消失。**这是已知的、有意的状态**，
  不是缺陷；上线方式即平时那条启动脚本。
- **验证只在「非管理员 + 同一台机器 + 作业对象语义」下做过**（见 10.4 的口径）。
  跨用户、跨会话、真服务器自启场景未复核。
- **树是「采样」而非「订阅」**：刷新窗口只有启动后 15 秒。若某个真身在 15 秒之后才出生，
  它不会进档案。停止时仍会被 `taskkill /T` 顺带带走（父在树里），但**控制台重启后**它就认不出来了。
  当前托管对象里没有这种形态，故按已知边界记录，不做过度工程。
