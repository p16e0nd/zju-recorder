@echo off
setlocal
chcp 65001 >nul

set "PORT=8787"
set "URL=http://127.0.0.1:%PORT%"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "try { Invoke-WebRequest -UseBasicParsing -Method POST '%URL%/api/shutdown' -TimeoutSec 3 | Out-Null; exit 0 } catch { exit 1 }"

if errorlevel 1 (
  echo Server is not running, or shutdown request failed.
) else (
  echo Stop request sent. Active ffmpeg recordings will be asked to finish cleanly.
)
timeout /t 2 /nobreak >nul

