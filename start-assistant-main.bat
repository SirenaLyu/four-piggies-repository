@echo off
setlocal
chcp 65001 >nul
setlocal EnableDelayedExpansion

rem ============================================================
rem  校园AI助手「科大精灵」一键启动脚本
rem  双击 start-assistant.bat 即可运行
rem ============================================================

cd /d "%~dp0"
title 科大精灵 · 校园AI助手启动器

echo.
echo  ============================================
echo   校园AI助手 · 科大精灵  一键启动
echo  ============================================
echo.

echo  [1/4] 检查 Node.js ...
where node >nul 2>nul
if errorlevel 1 (
  echo  [错误] 未检测到 Node.js，请先安装：https://nodejs.org/
  echo.
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node -v') do set NODEVER=%%v
echo        已找到 Node.js 版本: !NODEVER!

echo.
echo  [2/4] 检查依赖 (node_modules) ...
if exist node_modules (
  echo        依赖已存在，跳过安装
) else (
  echo        首次运行，正在安装依赖，请稍候（可能需要几分钟）...
  call npm install --registry=https://registry.npmmirror.com
  if errorlevel 1 (
    echo  [错误] 依赖安装失败，请检查网络后重试
    echo.
    pause
    exit /b 1
  )
  echo        依赖安装完成
)

echo.
echo  [3/4] 检查环境变量配置 (.env.local) ...
if not exist .env.local (
  echo.
  echo  [警告] 未找到 .env.local 文件！
  echo        没有真实密钥时，聊天与检索会失败（构建能过但跑不起来）。
  echo.
  echo        请复制 .env.local.example 为 .env.local 并填入：
  echo          - OPENAI_API_KEY   （科大 LLM 代理）
  echo          - EMBEDDING_API_KEY（硅基流动 embedding）
  echo          - SUPABASE_URL / SUPABASE_ANON_KEY（主检索库）
  echo.
  echo        DIFY_API_KEY 与 TAVILY_API_KEY 可留空。
  echo.
  echo        详细说明见 README.md
  echo.
)

echo  [4/4] 启动开发服务器 ...
echo       将在该窗口后台运行，并自动打开浏览器 http://localhost:3000
echo       关闭本窗口即可停止服务。
echo.

rem 延迟自动打开浏览器（给服务器 3 秒启动时间）
start "" /b cmd /c "timeout /t 3 /nobreak >nul & start http://localhost:3000"

call npm run dev

echo.
echo  服务已停止。
pause
