@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0.."

echo ===================================================
echo   Minos Work Dashboard - Installer Build Script
echo ===================================================
echo.

echo [1/4] Building icon...
node installer\make-icon.js
if errorlevel 1 goto ERR_ICON

echo.
echo [2/4] Checking Node.js runtime binary...
if not exist "installer\runtime" mkdir "installer\runtime"
if exist "installer\runtime\node.exe" goto RUNTIME_READY
if exist "C:\Program Files\nodejs\node.exe" (
    copy /y "C:\Program Files\nodejs\node.exe" "installer\runtime\node.exe" >nul
)
if exist "installer\runtime\node.exe" goto RUNTIME_READY

:ERR_RUNTIME
echo [ERROR] Node.js binary not found.
exit /b 1

:RUNTIME_READY
echo   -^> Node.js runtime prepared.

echo.
echo [3/4] Searching for Inno Setup compiler (iscc.exe)...
set "ISCC="
if exist "%LOCALAPPDATA%\Programs\Inno Setup 6\iscc.exe" set "ISCC=%LOCALAPPDATA%\Programs\Inno Setup 6\iscc.exe"
if not "%ISCC%"=="" goto FOUND_ISCC
if exist "C:\Program Files (x86)\Inno Setup 6\iscc.exe" set "ISCC=C:\Program Files (x86)\Inno Setup 6\iscc.exe"
if not "%ISCC%"=="" goto FOUND_ISCC
if exist "C:\Program Files\Inno Setup 6\iscc.exe" set "ISCC=C:\Program Files\Inno Setup 6\iscc.exe"
if not "%ISCC%"=="" goto FOUND_ISCC

where.exe iscc.exe >nul 2>&1
if errorlevel 1 goto NO_ISCC
for /f "delims=" %%I in ('where.exe iscc.exe') do set "ISCC=%%I"
if not "%ISCC%"=="" goto FOUND_ISCC

:NO_ISCC
echo.
echo ==============================================================
echo [NOTICE] Inno Setup compiler (iscc.exe) is not installed.
echo ==============================================================
echo Inno Setup 6 is required to build the setup executable.
echo Install with: winget install JRSoftware.InnoSetup
echo.
echo [REPORT] iscc 필요
exit /b 2

:FOUND_ISCC
echo   -^> Found Inno Setup: "%ISCC%"

echo.
echo [4/4] Compiling WorkDashboard-Setup-1.0.0.exe...
if not exist "installer\Output" mkdir "installer\Output"

"%ISCC%" installer\WorkDashboard.iss
if errorlevel 1 goto ERR_COMPILE

echo.
echo ===================================================
echo [SUCCESS] Setup package created:
dir /b "installer\Output\WorkDashboard-Setup-*.exe"
echo ===================================================
exit /b 0

:ERR_ICON
echo [ERROR] Failed to build icon.
exit /b 1

:ERR_COMPILE
echo [ERROR] Inno Setup compilation failed.
exit /b 1
