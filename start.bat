@echo off
cd /d "%~dp0"
title PGSAO API

if not exist node_modules (
  echo ============================================
  echo  First-time setup - this only happens once.
  echo ============================================
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo Setup failed. Press any key to close.
    pause >nul
    exit /b 1
  )
  echo.
)

echo Starting PGSAO API...
echo (a second window will open with the server - keep it open while you use the app)
echo.

start "PGSAO API Server" cmd /k npm run dev
timeout /t 6 /nobreak >nul
start "" http://localhost:8787/dashboard

echo Done. Your dashboard should now be open in your browser.
echo If it didn't open, go to: http://localhost:8787/dashboard
echo.
pause
