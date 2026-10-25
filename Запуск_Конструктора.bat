@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Install Node.js and try again.
  pause
  exit /b 1
)

netstat -ano | findstr ":3000" | findstr "LISTENING" >nul
if errorlevel 1 (
  start "Physics KIM Server" cmd /k "node server.js"
  timeout /t 2 /nobreak >nul
) else (
  echo Server is already running on port 3000.
)

start "" "http://localhost:3000/admin"
endlocal
