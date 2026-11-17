@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 没有找到 Node.js。请先到 https://nodejs.org/ 安装 Node.js。
  pause
  exit /b 1
)
node server.mjs --provider demo
pause
