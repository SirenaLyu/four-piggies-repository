@echo off
chcp 65001 >nul
cd /d "%~dp0"
taskkill /f /im node.exe >nul 2>nul
echo 已请求停止所有 node.exe 进程。
echo 注意：这会停止本机所有 Node 进程，如必要请改用任务管理器逐个结束。
pause
