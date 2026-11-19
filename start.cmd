@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem Keep this file ASCII-only: cmd.exe mis-parses multi-byte UTF-8 lines in batch files.
rem Chinese messages are printed by scripts/ensure-build.mjs and the server instead.
where node >nul 2>nul
if errorlevel 1 (
  echo [ACM Helper] Node.js 22 or newer is required: https://nodejs.org/
  pause
  exit /b 1
)
if not exist node_modules (
  call npm install
  if errorlevel 1 goto failed
)
node scripts/ensure-build.mjs
if errorlevel 1 goto failed
call npm start
pause
exit /b 0
:failed
pause
exit /b 1
