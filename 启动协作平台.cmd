@echo off
cd /d "%~dp0"
if exist "dist\Agent-Studio\Agent Studio.exe" (
  start "" "dist\Agent-Studio\Agent Studio.exe"
) else (
  start "" "node_modules\electron\dist\electron.exe" .
)
