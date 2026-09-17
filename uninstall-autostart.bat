@echo off
REM 取消「控制台开机自启」注册。不会删除任何配置或日志。
setlocal EnableExtensions
chcp 65001 >nul

set "TASK_NAME=AI Service Console"

net session >nul 2>nul
if errorlevel 1 (
  echo [!] 删除计划任务通常需要管理员权限，正在尝试以管理员身份重新运行...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

schtasks /delete /tn "%TASK_NAME%" /f
if errorlevel 1 (
  echo.
  echo [x] 删除失败：任务可能本来就不存在，或权限不足。
  pause
  exit /b 1
)

echo.
echo 已取消开机自启（任务「%TASK_NAME%」已删除）。
pause
exit /b 0
