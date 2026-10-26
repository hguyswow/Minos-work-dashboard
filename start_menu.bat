@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo(1) 모니터용(전체화면)  2) 사용자용(일반 창)  3) 서버만
echo.
set "TRIES=0"
:MENULOOP
if %TRIES% GEQ 3 echo 3회 입력 실패로 종료합니다.
if %TRIES% GEQ 3 exit /b 1
set "SEL="
set /p "SEL=선택(1-3): "
set /a TRIES+=1
if "%SEL%"=="1" call "%~dp0start_monitor.bat"
if "%SEL%"=="1" goto MENUEND
if "%SEL%"=="2" call "%~dp0start_user.bat"
if "%SEL%"=="2" goto MENUEND
if "%SEL%"=="3" goto SERVERONLY
echo 잘못된 입력입니다. 다시 입력해 주세요.
goto MENULOOP
:SERVERONLY
rem 포트 결정: WD_PORT 우선, 없으면 config.json
set "PORT="
if defined WD_PORT set "PORT=%WD_PORT%"
if not defined PORT for /f "usebackq delims=" %%P in (`node -p "(()=>{try{return require('./config.json').port||3000}catch(e){return 3000}})()"`) do set "PORT=%%P"
rem 서버 실행 여부 확인
set "SRV_START=1"
netstat -ano | findstr LISTENING | findstr ":%PORT% " >nul 2>&1
if not errorlevel 1 set "SRV_START=0"
if "%WD_DRY_RUN%"=="1" goto MENUSERVERDRY
if "%SRV_START%"=="0" goto MENUEND
start "WorkDashboard Server" /min cmd /c node server.js
call :WAITPORT
goto MENUEND
:MENUSERVERDRY
if "%SRV_START%"=="0" goto MENUEND
echo node server.js
goto MENUEND
:MENUEND
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
