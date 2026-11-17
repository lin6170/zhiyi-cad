@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 没有找到 Node.js。请先到 https://nodejs.org/ 安装 Node.js 20 或更新的版本。
  pause
  exit /b 1
)
if not exist ".env" (
  echo 还没有 .env 文件。请把 .env.example 复制一份，改名为 .env，填上模型密钥。
  pause
  exit /b 1
)
if not exist "node_modules" (
  echo 第一次运行，正在安装依赖，请稍等。
  call npm install
  if errorlevel 1 (
    echo 安装依赖失败，请检查网络后再试。
    pause
    exit /b 1
  )
)
node server.mjs
pause
