@echo off
cd /d "%~dp0"
if exist "dist\Agent-Studio-0.2.0-win-x64\Agent Studio.exe" (
  start "" "dist\Agent-Studio-0.2.0-win-x64\Agent Studio.exe"
  exit /b
)
if exist "dist\Agent-Studio\Agent Studio.exe" (
  start "" "dist\Agent-Studio\Agent Studio.exe"
) else (
  if exist "node_modules\electron\dist\electron.exe" (
    start "" "node_modules\electron\dist\electron.exe" .
  ) else (
    echo Source checkout: run npm ci and npm start, or download the portable ZIP:
    echo https://github.com/zhangsiyu1266/agent-studio/releases/latest
    pause
  )
)
