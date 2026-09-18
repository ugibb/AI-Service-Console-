# 打包方案：AI Service Console 桌面版（单 exe）

- 文档版本：v1.0
- 日期：2026-09-18
- 状态：**已确认，待执行**（决策见 §10）
- 关联：`02-doc/02-design/010-prd.md`（v3.1）、`02-doc/02-design/020-tasks.md`、`02-doc/03-test/020-test-report.md`

> **本方案要解决的问题**：目标 Windows 服务器**不能访问外网**，装不了 Node.js、也不该依赖浏览器。
> 现有形态是「`start.bat` 起 Express → RDP 里开浏览器访问 `127.0.0.1:3010`」，
> 首次运行还要 `npm install` + `npm run build`——在离线机器上这两步直接做不了。
>
> **方案结论**：不重写、不搬架构，**只在外面加一层 Electron 外壳**，产出单个 `.exe`，
> 目标机双击即用，零运行时依赖。
>
> 之所以能做到「几乎不改代码」，是因为两个既有设计正好契合：
> 客户端 API 层用的是相对路径 `/api`（`client/src/api/client.js:9`），
> 后端 `bootstrap()` 已经把「依赖装配」与「监听端口」分离（`server/src/index.js:33`）。

---

## 1. 目标与约束

### 1.1 目标

| 编号 | 目标 | 判定标准 |
|------|------|---------|
| G1 | **离线可用** | 目标机无外网、无 Node.js、无浏览器要求，双击 exe 即出界面 |
| G2 | **启动方便** | 不需要命令行、不需要 `npm install`、不需要记路径 |
| G3 | **功能不缩水** | 现有全部能力（登记/启停/重启/日志 tail）一个不少 |
| G4 | **配置可搬移** | 拷走整个目录 = 带走全部服务登记，不写注册表、不写 `%APPDATA%` |

### 1.2 硬约束

- **目标机永久离线**：不能有任何「运行时下载」「首次联网激活」的设计。
- **打包机有网**：可在当前开发机完成全部下载与打包，产物离线拷贝即可。
- **不改变产品定位**：PRD §1 定义的「Windows 服务器本机控制台」不变，仍然**只绑 `127.0.0.1`**，不对外提供服务。
- **保持 PRD §9 语义**：控制台退出后，已启动的子服务继续存活。

---

## 2. 选型

| 项 | 选择 | 理由 |
|---|---|---|
| 运行时外壳 | **Electron** | 自带 Chromium + Node 运行时 → G1 直接成立（不装 Node、不装浏览器） |
| 打包工具 | **electron-builder** | 一条命令出 `portable` 单 exe；`nsis` / `dir` 只是改一个字段 |
| 界面 | **现有 React 前端原样装进 `BrowserWindow`** | 前端零改动 |

### 2.1 为什么不用别的

| 候选 | 否决理由 |
|---|---|
| **Tauri** | 依赖目标机预装 WebView2 运行时。Win10 1909 不保证有，且离线机器补装 WebView2 又是一个联网动作 → 直接违反 G1 |
| **Node SEA**（单文件可执行） | 现有后端是纯 ESM，SEA 对 ESM 的支持有限；且仍要求把 Express 的依赖树塞进 blob，改造成本远大于收益 |
| **`pkg`** | 已停止维护，不支持 Node 20+ |
| **保留 B/S，只做托盘启动器** | 仍然要求目标机有浏览器，且满足不了 G2 的「桌面程序」预期 |

---

## 3. 产物形态

```
D:\AI-Console\                     ← 目标机上一个可写目录
├── AI-Service-Console.exe         ← 唯一交付物，约 100–150MB
├── data\                          ← 首次运行自动创建
│   ├── services.json              ← 服务登记表（沿用现有格式，不迁移）
│   ├── corrupt\                   ← 损坏配置备份（现有逻辑）
│   └── logs\console.log           ← 【新增】控制台自身日志
└── （可选）.env / 环境变量          ← 覆盖端口等，见 §5.5
```

- **整个 `D:\AI-Console\` 拷走 = 迁移完成**，满足 G4。
- `data/` 必须在 exe 同级、**不能在 asar 内**——asar 是只读归档，`services.json` 写不进去。
  实现上通过 `LSC_DATA_DIR` 环境变量注入（`server/src/config.js:57` 已支持）。
- portable 目标需要取 exe 真实所在目录：electron-builder 会注入 `PORTABLE_EXECUTABLE_DIR`，
  否则回退到 `path.dirname(app.getPath('exe'))`。

---

## 4. 架构：改造前 vs 改造后

**改造前（B/S，依赖 Node + 浏览器 + 两条命令）**

```text
RDP 进服务器
  → cd 到项目目录
  → start.bat（内部 npm install → npm run build → npm start）
  → 浏览器打开 http://127.0.0.1:3010
  → 操作
```

**改造后（单机一体化 C/S，双击即用）**

```text
┌─ Windows 服务器 ────────────────────────────┐
│                                             │
│   AI-Service-Console.exe                    │
│   ├─ BrowserWindow  ← 装的是现有 React UI    │
│   ├─ Express 服务   ← 127.0.0.1:<随机端口>   │
│   │    └─ bootstrap() 原样复用              │
│   └─ 进程管理 → 启停本机 .bat / tail 日志     │
│                                             │
│   窗口内部仍是 HTTP，只是对外不可见           │
└─────────────────────────────────────────────┘
```

**注意**：这**不是**真·C/S 分离（那需要鉴权 + 防火墙放行 + 服务端无窗口常驻，见 §10-D1）。
窗口和 HTTP 服务在同一台机器、同一个进程里，HTTP 只是内部实现细节。

---

## 5. 改动清单

共计 **4 处**，其中 2 处是新增文件。

### 5.1 新增 `desktop/main.js`（约 150 行）

Electron 主进程，做五件事：

```js
// ① 单实例锁：双击两次不会起两个控制台
if (!app.requestSingleInstanceLock()) app.quit()
//    第二个实例的启动事件里，把已有窗口唤到前台

// ② 数据目录外置到 exe 同级（不能留在 asar 里）
const dataDir = path.join(path.dirname(app.getPath('exe')), 'data')

// ③ 复用现有 bootstrap，端口用 0 让系统分配
const cfg = loadConfig({ ...process.env, LSC_DATA_DIR: dataDir, LSC_PORT: '0', LSC_HOST: '127.0.0.1' })
const { app: expressApp, procManager } = await bootstrap({ cfg })
const server = expressApp.listen(0, '127.0.0.1')   // 拿到真实端口

// ④ 开窗口，加载本地 HTTP（前端零改动）
win.loadURL(`http://127.0.0.1:${server.address().port}`)

// ⑤ 退出：procManager.dispose()；绝不杀子服务（PRD §9）
```

**端口用 `0` 是个白捡的收益**：README「已知问题」里那条「3010 被占用则控制台启动失败」
从此不可能发生。想固定端口的用户仍可用 `LSC_PORT` 覆盖（§5.5）。

### 5.2 日志改为落文件（改 `server/src/lib/logger.js`）

现状：`server/src/lib/logger.js:7` 默认 sink 是 `process.stdout`。
桌面版**没有控制台窗口**，stdout 直接进黑洞，出问题无从查起。

改为：默认 sink 写 `data/logs/console.log`（单文件满 2MB 轮转，保留 3 份），同时保留 stdout 输出。
**这是现场排障的唯一途径，属必做项。**

### 5.3 新增 `electron-builder.yml`

关键配置项：

| 字段 | 作用 |
|---|---|
| `files` | 收入 `server/src/**`、`client/dist/**`，以及 `express` / `iconv-lite` 两个运行时依赖 |
| `asarUnpack` | 无需配置（两个依赖都是纯 JS，无原生模块） |
| `portable.artifactName` | 固定产物名，便于交付 |
| `extraMetadata` | 产品名、版本、图标 |
| 环境变量 | 打包时注入 `LSC_SERVE_CLIENT=1`、`LSC_CLIENT_DIST` 指向 asar 内 `client/dist` |

### 5.4 修 D1 缺陷（P0，**必做**）

`02-doc/03-test/020-test-report.md:341` 记录的 **P0 缺陷**：
`shell: true` 在 Windows 上并**不**给命令路径加引号，**含空格的 `.bat` 路径完全无法启动**
（`server/src/proc/win32.js:85`）。

不修的话交付出去的 exe 会带着这个毛病，而目标机的服务大概率装在
`C:\Program Files\...` 这类带空格的路径下——直接违背 G3。
报告里已给出实测可行的修复候选。

### 5.5 环境变量（保持现有约定，不新增机制）

桌面版仍读 `LSC_*` 全套环境变量（`server/src/config.js`），
其中对桌面场景最有意义的是：

| 变量 | 桌面版默认 | 用途 |
|---|---|---|
| `LSC_PORT` | `0`（系统分配） | 想固定端口便于他处访问时设为 `3010` |
| `LSC_HOST` | `127.0.0.1` | **不建议改**（改 `0.0.0.0` 等于把无鉴权的控制台暴露到局域网） |
| `LSC_DATA_DIR` | `<exe目录>/data` | 想把配置放到别处时覆盖 |

---

## 6. 打包流程（在**有网**的开发机上执行）

```bash
# 一次性
npm i -D electron electron-builder --workspace desktop

# 每次出包
npm run build      # 构建前端到 client/dist
npm run dist       # 产出 release/AI-Service-Console.exe
```

**国内网络注意**：electron-builder 拉 Electron 二进制和 winCodeSign 会走 GitHub，建议加镜像，
否则首次打包可能长时间卡住：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
```

产物落在 `release/`，拷贝到目标机即可。**目标机全程不需要网络。**

---

## 7. 离线交付与首次运行

1. 把 `AI-Service-Console.exe` 拷到目标机一个**有写权限**的目录（如 `D:\AI-Console\`）。
2. 双击。首次运行会自动创建 `data\`（含空 `services.json`）。
3. **SmartScreen 会拦一次**：exe 未做代码签名，会报「Windows 已保护你的电脑」。
   点「更多信息」→「仍要运行」即可。想彻底消除需代码签名证书（见 §8）。
4. 之后在界面里「新增服务」，登记名称、工作目录、启动脚本、日志路径、端口。

---

## 8. 风险与对策

| 编号 | 风险 | 影响 | 对策 |
|---|---|---|---|
| R1 | **npm workspaces 依赖提升 + electron-builder 组合**是已知摩擦点 | 可能打包后缺 `express`，运行即崩 | 在 `desktop` workspace 里显式声明 `express`/`iconv-lite`；若仍漏包，兜底用 esbuild 把后端打成单文件（esbuild 已随 vite 存在于 node_modules） |
| R2 | exe 未签名，首次运行 SmartScreen 报「未知发布者」 | 目标机需手动点一次「仍要运行」 | 内网机器可加 Defender 白名单；彻底消除需代码签名证书（另议） |
| R3 | portable exe 每次运行解压到 `%TEMP%` | 首次启动约 3–5 秒 | 若嫌慢，改出 `nsis` 安装版或 zip 免安装目录版，只是打包配置一个字段 |
| R4 | Electron 主进程内跑 Express，后端崩溃会连窗口一起挂 | 可用性下降 | 现有后端已有完整错误信封与日志；要求更高时可改为 `utilityProcess` 独立进程（**现有后端代码同样不用改**） |
| R5 | 端口用 `0` 后，外部工具（脚本/书签）无法预知端口 | 少数场景不便 | 需要固定端口时设 `LSC_PORT` 环境变量 |

---

## 9. 分期与验收

| 阶段 | 内容 | 交付物 | 验收标准 |
|---|---|---|---|
| **P0** ✅ | 修 D1 + 日志落文件 | 两处代码修改 | 现有 `npm test` 全绿；**新增**用例覆盖「含空格路径的 `.bat` 能启动」；控制台日志确实落到文件 |
| **P1** | `desktop/main.js` + 打包配置，出第一个 exe | `release/AI-Service-Console.exe` | 目标机双击出窗口，能增/删/改服务、启停、看日志 |
| **P2** | 托盘、开机自启、图标、单实例 | 完整版 exe | 关窗口不退出（进托盘）；重启机器控制台自动拉起；双击两次只有一个实例 |
| **P3** | 打包流程文档 + 离线交付说明 | README 章节 | 照文档能独立出一个 exe |

### 9.1 P0 完成情况（2026-09-18）

| 项 | 结果 | 证据 |
|---|---|---|
| D1 修复 | ✅ | 新增纯函数 `buildSpawnCommand`（`server/src/proc/win32.js`），命令串自带引号 |
| D1 回归用例 | ✅ | `server/test/win32.test.js` 新增**真起进程**用例。修复前实测 `exit=1` + `'C:\...\Temp\lsc' 不是内部或外部命令`；修复后 `exit=0` + `SPACED-OK` |
| 日志落盘 | ✅ | 新增 `server/src/lib/fileSink.js`（轮转 2MB×3 份）+ `createConsoleLogger()`（`server/src/index.js`） |
| 测试 | ✅ | 后端 179 项：**178 通过 / 0 失败 / 1 跳过**（跳过项是既有的 Windows chmod 限制，与本次无关） |
| 端到端 | ✅ | 真起一次控制台（临时数据目录 + `LSC_PORT=3099`），`/api/health` 正常，`logs/console.log` 内容完整 |

**遗留未修**：测试报告里的 **D2**（`taskkill` 退出码 128 被误判为「进程已不存在」，
导致日志把「进程顽固、必须强杀」说成「进程已不存在」，且每次停止白等满 5 秒宽限期）。
它不影响 P1 出 exe，但会直接影响桌面版的诊断可信度，**建议排在 P1 之后、P2 之前**。

**执行顺序**：P0 → P1 → P2 → P3，**每阶段跑完测试再进下一阶段**。
P1 结束时即可在目标机实机验证一轮；P2 的托盘与自启可在验证反馈后补。

**顺带解决的两件事**（P2）：

| 原来的痛点 | 桌面版 |
|---|---|
| `install-autostart.bat` 要管理员开 `schtasks` | 应用内勾选「开机自启」（`app.setLoginItemSettings`），**无需管理员** |
| 关掉 cmd 窗口 = 停掉控制台，容易误操作 | 关闭窗口默认**最小化到托盘**，托盘菜单里才是「退出」 |

---

## 10. 决策记录

| 编号 | 决策项 | 结论 | 依据 |
|---|---|---|---|
| D1 | 部署形态 | **单机一体化**（不做真·C/S 分离） | 控制台只在被管理的这台服务器上使用（PRD §3「唯一用户：工具作者本人」）。真·C/S 需额外做鉴权、防火墙放行、服务端无窗口常驻，收益不足以支撑 |
| D2 | 打包环境 | 打包机有网、目标机离线 | 现状确认 |
| D3 | 运行时 | **把 Node 运行时打进 exe** | 目标机未装 Node 且装不了 → 这是 Electron 相对 Node SEA 的决定性优势 |
| D4 | 产物形态 | **portable 单 exe** 为主 | 满足 G2「方便启动」；代价是启动慢 3–5 秒，可用 `nsis`/`dir` 换取（R3） |
| D5 | D1 缺陷是否纳入 | **纳入，列为 P0** | 不修则含空格的 `.bat` 无法启动，直接违背 G3 |
| D6 | 是否对外网暴露 | **否**，仍绑 `127.0.0.1` | 控制台无鉴权，暴露到局域网等于开了一个任意启停进程的接口 |

---

## 11. 不在本次范围

- POSIX（macOS/Linux）进程适配——仍是 PRD 里的 M2。
- 代码签名证书与自动更新（`autoUpdater`）——离线环境用不上自动更新。
- 局域网多操作员访问与配套鉴权——对应 D1 否决的「真·C/S 分离」。
