# Task List：本地服务统一管理控制台

- 关联 PRD：`02-doc/02-design/010-prd.md`（v3.0）
- 日期：2026-09-17
- 目标平台：**M1 = Windows**；M2 = macOS/Linux（增量，暂不做）；M3 = 增强项（可选）
- 实时性方案：**HTTP 轮询**（日志 1s / 状态 1–2s），无 WebSocket
- 验证方式标注：
  - `[Mac 可验]` = 纯逻辑/前端，可在 macOS 上运行并验证。
  - `[需 Windows 验证]` = Windows 特定行为，macOS 上只能写不能验，正确性必须在 Windows 机器验证。
  - `[Mac 可验 + Windows 验证]` = 逻辑可 Mac 验，集成行为需 Windows 验。

---

## 里程碑总览

| 里程碑 | 内容 | 交付标志 | 验证环境 |
|--------|------|---------|---------|
| M0 | 项目脚手架 | 空前后端能启动，Vite 代理打通 | macOS |
| M1 | Windows MVP（Must-have 全部，含日志 tail、启动诊断、开机自启） | 能登记/启停/看日志（1s 刷新），`start.bat` + 自启注册 | macOS（逻辑）+ Windows（集成验收） |
| M2 | macOS/Linux 增量（未来按需） | POSIX 进程抽象 | macOS/Linux |
| M3 | 增强项（Nice-to-have） | 按需排期 | 视项而定 |

**执行策略建议**：先并行完成所有 `[Mac 可验]` 任务（逻辑层可在 macOS 打通），把 `[需 Windows 验证]` 任务集中到 Windows 测试会话批量验收。

---

## M0：项目脚手架（全部 Mac 可验）

| 编号 | 任务 | 交付物 | 验证 | 依赖 |
|------|------|--------|------|------|
| T0.1 | 初始化 monorepo：根 `package.json`（workspaces/脚本）、`.gitignore`（排除 `node_modules`、`dist`、`data/`）、`README.md` | 根工程配置 | Mac 可验 | — |
| T0.2 | 搭建后端骨架：`server/package.json`（express + cors + uuid + iconv-lite）、`server/src/index.js`（HTTP 起 3010 + 静态托管占位）、`server/src/config.js`（端口/绑定地址/tail 行数/日志编码策略） | server 可启动 | Mac 可验 | T0.1 |
| T0.3 | 搭建前端骨架：`client/`（Vite + React）、`vite.config.js`（`/api` 代理到 3010）、`client/src/main.jsx`、`App.jsx` 占位页 | client dev 可启动 | Mac 可验 | T0.1 |
| T0.4 | 联调验证：前端访问后端健康检查 `GET /api/health` | 前后端打通 | Mac 可验 | T0.2, T0.3 |

---

## M1：Windows MVP

### 数据层与日志读取

| 编号 | 任务 | 交付物 | 验证 | 依赖 |
|------|------|--------|------|------|
| T1.1 | 实现 `server/src/db/configStore.js`：`data/services.json` 读写（原子写）、CRUD、启动加载、损坏备份降级 | 配置持久化模块 | Mac 可验 | T0.2 |
| T1.2 | 实现 `server/src/logs/logTail.js`：文件尾部反向读 N 行（`fs.open`+`fstat`+分块反读，凑够 N 行即停）、单行超长截断、UTF-8→GBK 回退解码（iconv-lite）、文件不存在/目录/无权限降级 | 日志 tail 读取模块 | Mac 可验 | T0.2 |

### 进程层（Windows 实现 + 编排）

| 编号 | 任务 | 交付物 | 验证 | 依赖 |
|------|------|--------|------|------|
| T1.3 | 实现 `server/src/proc/win32.js`：`spawn(startScript,{shell:'cmd.exe /c', cwd:path.resolve(workDir), windowsHide:true})`、stdout/stderr Buffer 读取 + 启动诊断缓冲（环形 200 行）+ UTF-8→GBK 回退、`taskkill /pid /T`（优雅）与 `/T /F`（强杀）、`exit` 回调。导出 `spawnService/stopService/isAlive` 签名 | Windows 进程实现 | 需 Windows 验证 | T0.2 |
| T1.4 | 实现 `server/src/services/procManager.js`（平台无关逻辑）：服务状态机（stopped/starting/running/stopping/error/start_failed）、启动/停止/重启编排、5s 超时强杀、启动诊断判定（短窗口退出→start_failed）、防重入、状态变更回调 | 生命周期编排 | Mac 可验（逻辑） | T1.1 |
| T1.5 | `procManager` × `win32` 启停集成联调：真实 `.bat` 启动、树杀无孤儿、启动失败诊断输出 | 启停集成 | 需 Windows 验证 | T1.3, T1.4 |

### API 层

| 编号 | 任务 | 交付物 | 验证 | 依赖 |
|------|------|--------|------|------|
| T1.6 | 实现 `server/src/routes/services.js`：服务 CRUD（GET/POST/PUT/DELETE `/api/services`），列表返回含 `status/pid/exitCode` | 服务 API | Mac 可验 | T1.1 |
| T1.7 | 实现 `server/src/routes/actions.js`：`POST /api/services/:id/start|stop|restart` | 操作 API | Mac 可验（接口逻辑） | T1.5 |
| T1.8 | 实现 `server/src/routes/logs.js`：`GET /api/services/:id/logs?tail=500`（调用 logTail 读文件 + 返回 + 降级状态） | 日志 API | Mac 可验 | T1.2 |
| T1.9 | `index.js` 集成：挂载路由 + 数据目录初始化 + 生产模式托管前端静态资源 | 后端集成 | Mac 可验 | T1.6, T1.7, T1.8 |

### 前端

| 编号 | 任务 | 交付物 | 验证 | 依赖 |
|------|------|--------|------|------|
| T1.10 | `client/src/api/client.js`：REST 封装（services CRUD、actions、logs） | API 客户端 | Mac 可验 | T0.3 |
| T1.11 | `client/src/hooks/usePolling.js`：轮询 hook（日志 1s、状态 1–2s；间隔可配、组件卸载清理、防重叠） | 轮询 hook | Mac 可验 | T1.10 |
| T1.12 | `client/src/store/servicesStore.js`：前端状态管理（服务列表 + 运行时状态） | 前端状态 | Mac 可验 | T1.10, T1.11 |
| T1.13 | `client/src/components/StatusBadge.jsx`：状态徽标（运行中/已停止/异常/启动失败/启动中/停止中） | 状态组件 | Mac 可验 | T1.12 |
| T1.14 | `client/src/components/ServiceCard.jsx` + `ServiceList.jsx`：列表布局 + 操作按钮 + 空状态引导 + 「状态可能不准确」提示（§9 边界） | 列表页 | Mac 可验 | T1.12, T1.13 |
| T1.15 | `client/src/components/ServiceForm.jsx`：新增/编辑表单（名称/工作目录/启动脚本 .bat/日志文件路径/端口） | 表单 | Mac 可验 | T1.10 |
| T1.16 | `client/src/components/LogViewer.jsx`：日志查看器（1s 轮询 tail、关键字过滤、空状态/「日志文件尚未生成」降级、编码乱码正常显示） | 日志页 | Mac 可验 | T1.10, T1.11 |
| T1.17 | `client/src/App.jsx` 组装视图（列表 + 详情日志视图切换） | 应用组装 | Mac 可验 | T1.14, T1.15, T1.16 |

### 一键启动、开机自启与 Windows 验收

| 编号 | 任务 | 交付物 | 验证 | 依赖 |
|------|------|--------|------|------|
| T1.18 | `start.bat`：装依赖（server + client）→ 构建前端 → 启动后端 → `start http://127.0.0.1:3010` | Windows 一键启动脚本 | 需 Windows 验证 | T1.9, T1.17 |
| T1.19 | `install-autostart.bat`：用 `schtasks /create` 注册开机自启（触发「ONLOGON」+ 失败重启） | 自启注册脚本 | 需 Windows 验证 | T1.18 |
| T1.20 | Windows 全链路手测：登记 `.bat` 服务 → 启动 → 日志 1s 刷新 → 中文无乱码 → 停止树杀无孤儿 → 启动失败诊断 → 重启控制台后配置/日志恢复 | 全链路验证 | 需 Windows 验证 | T1.19 |
| T1.21 | 按 PRD §12 边界条件逐项验收（重点：GBK 乱码、树杀、5s 超时强杀、日志文件不存在降级、假死显示运行中、配置损坏降级）+ 修复 | 验收通过 | 需 Windows 验证 | T1.20 |

---

## M2：macOS/Linux 增量（未来按需，暂不做）

| 编号 | 任务 | 交付物 | 验证 | 依赖 |
|------|------|--------|------|------|
| T2.1 | 实现 `server/src/proc/posix.js`（同签名）：`spawn(script,{shell:'/bin/sh -c',detached:true,cwd})` 建进程组、`kill(-pid,SIGTERM/SIGKILL)` | POSIX 实现 | 需 macOS/Linux 验证 | M1 |
| T2.2 | 平台选择器：`process.platform === 'win32'` 分流 win32/posix | 工厂接线 | Mac 可验（逻辑） | T2.1 |
| T2.3 | `start.sh`：装依赖 → 构建 → 启动 → 打开浏览器 | macOS 一键脚本 | 需 macOS 验证 | T2.2 |

---

## M3：增强项（Nice-to-have，按需）

| 编号 | 任务 | 交付物 | 依赖 |
|------|------|--------|------|
| T3.1 | 日志「加载更早」分页（读更早历史，`before` 游标） | 存储增强 | M1 |
| T3.2 | 日志增量 seek 优化（大文件场景可选，替换全量 tail） | 性能增强 | M1 |
| T3.3 | 服务搜索 / 分组（若服务数量多） | UI 增强 | M1 |
| T3.4 | 局域网其他设备访问 + token 鉴权（若未来需要） | 安全增强 | M1 |
| T3.5 | 异常退出自动重启 | 可靠性增强 | M1 |

---

## 依赖关系图

```text
后端主线：
T0.1 → T0.2 → T1.1 → T1.4 → T1.5 → T1.7 → T1.9 → T1.18 → T1.19 → T1.20 → T1.21
                     ↗               ↗
              T1.2 ─┘        T1.3 ─┘
                              T1.6 ─→ T1.9
                              T1.8 ─→ T1.9

前端支线：
T0.3 → T1.10 ─→ T1.11 → T1.12 → T1.13 → T1.14 ─→ T1.17 → T1.18
                               T1.15 ─┘
                               T1.16 ─┘
```

**关键路径**：`T0.1 → T0.2 → T1.1 → T1.4 → T1.5 → T1.7 → T1.9 → T1.18 → T1.19 → T1.20 → T1.21`

**瓶颈提示**：M1 共 21 个任务，其中「需 Windows 验证」的有 6 个（T1.3、T1.5、T1.18、T1.19、T1.20、T1.21），其余 15 个全部 Mac 可验。建议 Mac 可验任务先行并行推进，6 个 Windows 任务集中成一次 Windows 测试会话批量验收。
