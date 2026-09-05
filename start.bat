@echo off
setlocal
title Campus AI Assistant - One-Click Launcher
cd /d "%~dp0"

echo ============================================================
echo    Campus AI Assistant (Keda Spirit / KeDa JingLing)
echo ============================================================
echo.

rem ---- 1. Check Node.js ----
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js is not installed or not in PATH.
    echo         Please install Node.js 20+ from https://nodejs.org/
    echo.
    pause
    exit /b 1
)
echo [1/4] Node.js found:
node --version
echo.

rem ---- 2. Check npm ----
where npm >nul 2>nul
if errorlevel 1 (
    echo [ERROR] npm is not found. Please reinstall Node.js.
    echo.
    pause
    exit /b 1
)

rem ---- 3. Install dependencies ----
if exist "node_modules" (
    echo [2/4] Dependencies already installed, skipping npm install.
) else (
    echo [2/4] First run: installing dependencies, this may take a few minutes...
    call npm install
    if errorlevel 1 (
        echo [ERROR] npm install failed. Check your network and retry.
        echo.
        pause
        exit /b 1
    )
)
echo.

rem ---- 4. Check .env.local ----
if not exist ".env.local" (
    if exist ".env.local.example" (
        copy ".env.local.example" ".env.local" >nul
        echo [3/4] .env.local was not found. Copied from .env.local.example.
        echo        Please fill in the API keys in .env.local, then run this script again.
    ) else (
        echo [3/4] .env.local was not found and .env.local.example is missing.
        echo        Please create .env.local manually.
    )
    echo.
    pause
    exit /b 1
) else (
    echo [3/4] .env.local found.
)
echo.

echo [4/4] Starting the development server...
echo       The browser will open http://localhost:3000 in a few seconds.
echo       If port 3000 is busy, Next.js may use 3001 instead.
echo       Press Ctrl+C to stop the server.
echo.
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 8; Start-Process 'http://localhost:3000'"

call npm run dev

echo.
echo Server stopped.
pause
