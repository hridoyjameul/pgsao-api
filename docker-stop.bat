@echo off
title PGSAO API (Docker) - Stop
echo Stopping the pgsao-api container...
docker stop pgsao-api
if errorlevel 1 (
  echo.
  echo Nothing to stop, or it failed - see the error above.
  pause
  exit /b 1
)
echo.
echo Stopped. Data is kept - run docker-start.bat to start it again without rebuilding.
pause
