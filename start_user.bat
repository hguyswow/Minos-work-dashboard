@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem 포트 결정: WD_PORT 우선, 없으면 config.json
set "PORT="
if defined WD_PORT set "PORT=%WD_PORT%"
if not defined PORT for /f "usebackq delims=" %%P in (`node -p "(()=>{try{return require('./config.json').port||3000}catch(e){return 3000}})()"`) do set "PORT=%%P"
rem 서버 실행 여부 확인
set "SRV_START=1"
netstat -ano | findstr LISTENING | findstr ":%PORT% " >nul 2>&1
if not errorlevel 1 set "SRV_START=0"
if "%WD_DRY_RUN%"=="1" goto DRYRUN
if "%SRV_START%"=="0" goto OPEN
start "WorkDashboard Server" /min cmd /c node server.js
call :WAITPORT
goto OPEN
:DRYRUN
if "%SRV_START%"=="0" goto DRYOPEN
echo node server.js
:DRYOPEN
echo start "" "http://localhost:%PORT%/"
goto END
:OPEN
start "" "http://localhost:%PORT%/"
goto END
:END
exit /b 0
:WAITPORT
rem 포트가 열릴 때까지 최대 10초 대기
set "WCOUNT=0"
:WAITLOOP
netstat -ano | findstr LISTENING | findstr ":%PORT% " >nul 2>&1
if not errorlevel 1 goto WAITDONE
set /a WCOUNT+=1
if %WCOUNT% GEQ 10 goto WAITDONE
timeout /t 1 /nobreak >nul 2>&1
goto WAITLOOP
:WAITDONE
goto :EOF
