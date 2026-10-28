@echo off
setlocal
title PrintQR Server
cd /d "%~dp0server"
call :check_node
if errorlevel 1 (
    echo Node.js not found. Installing...
    call :install_node
    call :check_node
    if errorlevel 1 (
        echo Close this window and run run.bat again.
        pause
        exit /b 1
    )
)
rem === Set your admin login here BEFORE first start ===
set ADMIN_EMAIL=admin@printqr.local
set ADMIN_PASSWORD=admin123
echo Starting PrintQR website at http://localhost:3000
start "" cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:3000"
node server.js
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
