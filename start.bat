@echo off
REM ============================================================================
REM  AI Service Console —— 一键启动（T1.18）
REM
REM  做四件事：装依赖 → 构建前端 → 打开浏览器 → 前台运行控制台。
REM  前台运行是刻意的：关掉这个窗口就等于停掉控制台（已启动的子服务不受影响）。
REM  开机自启请用 install-autostart.bat，它走另一个入口（scripts\console-run.bat）。
REM
REM  本文件必须保存为 UTF-8（无 BOM）；下面的 chcp 65001 负责让中文正常显示。
REM ============================================================================
setlocal EnableExtensions
chcp 65001 >nul
pushd "%~dp0"

echo.
echo ============================================================
echo   AI Service Console —— 本机服务启停与日志控制台
echo ============================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [x] 没有找到 Node.js。请先安装 Node 20 或更高版本：https://nodejs.org/
  echo.
  pause
  popd
  exit /b 1
)
for /f "delims=" %%v in ('node -v') do set "NODE_VERSION=%%v"
echo [1/4] Node 版本 %NODE_VERSION%

if not exist "node_modules\express" (
  echo [2/4] 首次运行，安装依赖（可能要几分钟）...
  call npm install
  if errorlevel 1 goto :failed
) else (
  echo [2/4] 依赖已就绪
)

if not exist "client\dist\index.html" (
  echo [3/4] 构建前端 ...
  call npm run build
  if errorlevel 1 goto :failed
) else (
  echo [3/4] 前端已构建（改了前端代码后请删掉 client\dist 再运行本脚本）
)

if not defined LSC_PORT set "LSC_PORT=3010"
if not defined LSC_SERVE_CLIENT set "LSC_SERVE_CLIENT=1"

echo [4/4] 启动控制台：http://127.0.0.1:%LSC_PORT%
echo       浏览器将在 3 秒后自动打开；关闭本窗口即停止控制台。
echo.

REM ping 只是拿来当「等 3 秒」用（timeout 在无控制台环境下会失败）
start "打开控制台页面" cmd /c "ping -n 4 127.0.0.1 >nul && start http://127.0.0.1:%LSC_PORT%"

call npm start
set "EXIT_CODE=%ERRORLEVEL%"

echo.
echo 控制台已退出（退出码 %EXIT_CODE%）。注意：已启动的子服务仍在运行。
popd
exit /b %EXIT_CODE%

:failed
echo.
echo [x] 启动失败，请查看上面的错误信息。
popd
exit /b 1
