@echo off
cd /d "%~dp0"
title PGSAO API (Docker)

docker info >nul 2>&1
if errorlevel 1 (
  echo Docker Desktop doesn't seem to be running. Start it, then re-run this.
  pause
  exit /b 1
)

if not exist "%~dp0.env" (
  echo No .env found in this folder. Run start.bat once first to generate it, or copy one in.
  pause
  exit /b 1
)

set "CLAUDE_DIR=%CLAUDE_CONFIG_DIR%"
if "%CLAUDE_DIR%"=="" set "CLAUDE_DIR=%USERPROFILE%\.claude"

docker image inspect pgsao-api >nul 2>&1
if errorlevel 1 (
  echo Building pgsao-api image - this only happens once, or after code changes...
  docker build -t pgsao-api .
  if errorlevel 1 (
    echo Build failed. Press any key to close.
    pause >nul
    exit /b 1
  )
  echo.
)

docker inspect pgsao-api >nul 2>&1
if not errorlevel 1 (
  echo Container already exists - starting it...
  docker start pgsao-api >nul
  if errorlevel 1 (
    echo.
    echo Couldn't start it. If another "pgsao-api" container is running elsewhere
    echo ^(different folder, e.g. via docker compose^), stop that one first:
    echo   docker stop pgsao-api ^&^& docker rm pgsao-api
    pause
    exit /b 1
  )
  goto :open
)

echo Starting PGSAO API container...
docker run -d ^
  --name pgsao-api ^
  --restart unless-stopped ^
  --env-file "%~dp0.env" ^
  -e HOST=0.0.0.0 ^
  -p 127.0.0.1:8787:8787 ^
  -v "%~dp0data:/app/data" ^
  -v "%CLAUDE_DIR%:/root/.claude:ro" ^
  pgsao-api
if errorlevel 1 (
  echo.
  echo Couldn't start the container - see the error above.
  echo If a "pgsao-api" container from a different folder is already running
  echo ^(e.g. started via docker compose^), stop it first:
  echo   docker stop pgsao-api ^&^& docker rm pgsao-api
  pause
  exit /b 1
)

:open
timeout /t 3 /nobreak >nul
start "" http://localhost:8787/dashboard
echo.
echo Done. Dashboard: http://localhost:8787/dashboard
pause
