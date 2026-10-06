@echo off
cd /d "%~dp0"
title PGSAO API (Docker) - Uninstall

echo ============================================
echo  PGSAO API - Docker Uninstall
echo ============================================
echo.
echo This removes the pgsao-api Docker container and image only.
echo Your .env (API key/settings) and data\ folder are left untouched.
echo.

docker info >nul 2>&1
if errorlevel 1 (
  echo Docker Desktop doesn't seem to be running. Start it, then re-run this.
  pause
  exit /b 1
)

echo Stopping container (if running)...
docker stop pgsao-api >nul 2>&1

echo Removing container (if it exists)...
docker rm pgsao-api >nul 2>&1

echo Removing image (if it exists)...
docker rmi pgsao-api >nul 2>&1

echo.
echo Done. Container and image removed.
echo .env and data\ were kept - re-run docker-start.bat (or docker-reinstall.bat) to bring it back.
pause
