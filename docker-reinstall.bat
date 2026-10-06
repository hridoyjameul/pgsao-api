@echo off
cd /d "%~dp0"
title PGSAO API (Docker) - Reinstall

echo ============================================
echo  PGSAO API - Docker Reinstall
echo  (remove old container/image, then fresh build + start)
echo ============================================
echo.
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
echo Old container and image removed. Reinstalling now...
echo.

call "%~dp0docker-start.bat"
