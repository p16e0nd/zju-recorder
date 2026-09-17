@echo off
setlocal
chcp 65001 >nul

set "ROOT=%~dp0"
set "APP_DIR=%ROOT%app"
set "PORT=8787"
set "URL=http://127.0.0.1:%PORT%"
set "LOG=%ROOT%zju-recorder.log"

if exist "%ROOT%runtime\node\node.exe" (
  set "NODE=%ROOT%runtime\node\node.exe"
) else (
  where node >nul 2>nul
  if errorlevel 1 (
    echo [ERROR] Cannot find node.exe.
    echo Put portable Node.js into runtime\node, or install Node.js 18+ on this Windows system.
    pause
    exit /b 1
  )
  set "NODE=node"
)

if exist "%ROOT%runtime\ffmpeg\bin\ffmpeg.exe" (
  set "PATH=%ROOT%runtime\ffmpeg\bin;%PATH%"
)

where ffmpeg >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Cannot find ffmpeg.exe.
  echo Put ffmpeg.exe into runtime\ffmpeg\bin, or install ffmpeg and add it to PATH.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "try { $r = Invoke-WebRequest -UseBasicParsing '%URL%/api/status' -TimeoutSec 2; exit 0 } catch { exit 1 }" >nul 2>nul
if errorlevel 1 (
  start "ZJU Recorder Server" /min cmd /c "cd /d ""%APP_DIR%"" && set PORT=%PORT%&& ""%NODE%"" server.js >> ""%LOG%"" 2>>&1"
  for /l %%i in (1,1,50) do (
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
      "try { $r = Invoke-WebRequest -UseBasicParsing '%URL%/api/status' -TimeoutSec 1; exit 0 } catch { exit 1 }" >nul 2>nul
    if not errorlevel 1 goto ready
    timeout /t 1 /nobreak >nul
  )
  echo [ERROR] Server did not become ready in time.
  echo Log: %LOG%
  pause
  exit /b 1
) else (
  echo Server is already running: %URL%
)

:ready
start "" "%URL%"
echo Opened %URL%
echo Recordings are saved under %%USERPROFILE%%\ZJU-Recordings
timeout /t 2 /nobreak >nul
