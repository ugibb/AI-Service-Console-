@echo off
REM ============================================================================
REM  控制台「无人值守」入口 —— 供任务计划程序（开机自启）调用，不适合手动双击。
REM
REM  与 start.bat 的区别：
REM    - 不装依赖、不构建前端（自启场景下这两件事必须已经做过）
REM    - 输出写进 logs\console.log，不占一个前台窗口
REM    - 退出时返回真实退出码，任务计划程序据此触发「失败后重启」
REM
REM  关掉自动打开浏览器：启动任务前设置 LSC_AUTOSTART_OPEN_BROWSER=0
REM ============================================================================
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0.."

if not exist "logs" mkdir "logs"
set "LOG_FILE=logs\console.log"

if not exist "client\dist\index.html" (
  >>"%LOG_FILE%" echo [%date% %time%] [x] 缺少 client\dist，请先手动运行一次 start.bat
  exit /b 1
)

set "LSC_SERVE_CLIENT=1"
if not defined LSC_PORT set "LSC_PORT=3010"

>>"%LOG_FILE%" echo.
>>"%LOG_FILE%" echo ============================================================
>>"%LOG_FILE%" echo [%date% %time%] 控制台启动中（端口 %LSC_PORT%）

if not "%LSC_AUTOSTART_OPEN_BROWSER%"=="0" (
  start "打开控制台页面" cmd /c "ping -n 6 127.0.0.1 >nul && start http://127.0.0.1:%LSC_PORT%"
)

call npm start >>"%LOG_FILE%" 2>&1
set "EXIT_CODE=%ERRORLEVEL%"

>>"%LOG_FILE%" echo [%date% %time%] 控制台退出，退出码 %EXIT_CODE%
exit /b %EXIT_CODE%
