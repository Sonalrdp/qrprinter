@echo off
setlocal
title PrintQR Agent
cd /d "%~dp0"
echo ============================================
echo   PrintQR Agent - install and run
echo ============================================
call :check_node
if errorlevel 1 (
    echo Node.js not found. Installing...
    call :install_node
    call :check_node
    if errorlevel 1 (
        echo Close this window and run install-and-run.bat again.
        pause
        exit /b 1
    )
)
call :install_deps
if errorlevel 1 (
    echo Install failed. Check your internet connection.
    pause
    exit /b 1
)
echo.
echo Starting PrintQR Agent. Keep this window open while your shop is open.
node agent.js
pause
exit /b 0

:check_node
where node >nul 2>nul && exit /b 0
if exist "%ProgramFiles%\nodejs\node.exe" (
    set "PATH=%ProgramFiles%\nodejs;%PATH%"
    exit /b 0
)
exit /b 1

:install_node
where winget >nul 2>nul
if errorlevel 1 (
    echo Install Node.js LTS from https://nodejs.org then run this file again.
    start "" https://nodejs.org/en/download
    pause
    exit /b 1
)
winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
exit /b 0

:install_deps
if exist node_modules\pdf-to-printer exit /b 0
echo Installing packages...
call npm install --no-audit --no-fund
exit /b %errorlevel%
