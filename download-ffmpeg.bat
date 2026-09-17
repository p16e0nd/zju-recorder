@echo off
setlocal
chcp 65001 >nul

set "ROOT=%~dp0"
set "ZIP=%ROOT%runtime\ffmpeg\ffmpeg-release-essentials.zip"
set "DEST=%ROOT%runtime\ffmpeg"
set "BIN=%DEST%\bin"
set "URL=https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"

if exist "%BIN%\ffmpeg.exe" (
  echo ffmpeg already exists: %BIN%\ffmpeg.exe
  pause
  exit /b 0
)

mkdir "%DEST%" >nul 2>nul
echo Downloading ffmpeg. This file is about 100 MB.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri '%URL%' -OutFile '%ZIP%'"
if errorlevel 1 (
  echo [ERROR] ffmpeg download failed.
  pause
  exit /b 1
)

set "TMP=%DEST%\_extract"
if exist "%TMP%" rmdir /s /q "%TMP%"
mkdir "%TMP%" >nul 2>nul
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Expand-Archive -Force '%ZIP%' '%TMP%'"
if errorlevel 1 (
  echo [ERROR] ffmpeg unzip failed.
  pause
  exit /b 1
)

for /d %%D in ("%TMP%\ffmpeg-*") do (
  if exist "%%D\bin\ffmpeg.exe" (
    xcopy /e /i /y "%%D\bin" "%BIN%" >nul
  )
)

if exist "%BIN%\ffmpeg.exe" (
  rmdir /s /q "%TMP%"
  echo ffmpeg is ready: %BIN%\ffmpeg.exe
) else (
  echo [ERROR] ffmpeg.exe was not found after unzip.
)
pause
