@echo off
REM ============================================================================
REM  注册「控制台开机自启」（T1.19）
REM
REM  用任务计划程序（PRD §10 选定方案）：登录时触发 + 崩溃后自动重启。
REM
REM  注意一处与 PRD 字面写法的偏差，这是刻意的：
REM  PRD §10 写的是「schtasks /create 注册」，但 schtasks 的**命令行参数**表达不了
REM  「失败自动重启」（那属于 XML 里的 <RestartOnFailure>）。所以这里走的是
REM  `schtasks /create /xml`：仍然是 schtasks /create，只是定义来自 XML。
REM
REM  本文件必须保存为 UTF-8（无 BOM）。
REM ============================================================================
setlocal EnableExtensions
chcp 65001 >nul
pushd "%~dp0"

set "TASK_NAME=AI Service Console"
set "PROJECT_DIR=%~dp0"
if "%PROJECT_DIR:~-1%"=="\" set "PROJECT_DIR=%PROJECT_DIR:~0,-1%"
set "RUNNER=%PROJECT_DIR%\scripts\console-run.bat"
set "TEMPLATE=%PROJECT_DIR%\scripts\autostart-task.xml"
set "RENDERER=%PROJECT_DIR%\scripts\render-autostart-xml.ps1"
set "TEMP_XML=%TEMP%\ai-service-console-task.xml"

echo.
echo ============================================================
echo   注册开机自启：%TASK_NAME%
echo ============================================================
echo.

if not exist "client\dist\index.html" (
  echo [!] 还没构建前端。自启任务只负责「启动」，不会装依赖/构建。
  echo     请先双击运行一次 start.bat，确认控制台能正常打开，再回来注册自启。
  echo.
  pause
  popd
  exit /b 1
)

net session >nul 2>nul
if errorlevel 1 (
  echo [!] schtasks 注册任务通常需要管理员权限，正在尝试以管理员身份重新运行...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  popd
  exit /b
)

echo [1/3] 渲染任务定义 ...
powershell -NoProfile -ExecutionPolicy Bypass -File "%RENDERER%" ^
  -Template "%TEMPLATE%" ^
  -Destination "%TEMP_XML%" ^
  -User "%USERDOMAIN%\%USERNAME%" ^
  -Runner "%RUNNER%" ^
  -ProjectDir "%PROJECT_DIR%"
if errorlevel 1 goto :failed

echo [2/3] 注册任务 ...
schtasks /create /tn "%TASK_NAME%" /xml "%TEMP_XML%" /f
if errorlevel 1 goto :failed

del "%TEMP_XML%" >nul 2>nul

echo [3/3] 校验 ...
schtasks /query /tn "%TASK_NAME%" /fo LIST | findstr /i "TaskName Status"
if errorlevel 1 goto :failed

echo.
echo 完成。自启任务已注册：
echo   - 触发：当前用户登录后 20 秒
echo   - 崩溃后 1 分钟重试，最多 3 次；运行时长不设上限
echo   - 控制台日志：%PROJECT_DIR%\logs\console.log
echo.
echo 想立刻试一次（不必重启）：
echo   schtasks /run /tn "%TASK_NAME%"
echo 想取消自启：
echo   uninstall-autostart.bat
echo.
pause
popd
exit /b 0

:failed
echo.
echo [x] 注册失败。常见原因：
echo     - 没有以管理员身份运行
echo     - 任务名已存在（本脚本用 /f 覆盖，若仍失败请先 schtasks /delete）
echo     - 组策略禁止当前用户创建任务
echo.
pause
popd
exit /b 1
