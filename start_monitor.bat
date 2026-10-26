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
if "%SRV_START%"=="0" goto FIND
start "WorkDashboard Server" /min cmd /c node server.js
call :WAITPORT
goto FIND
:DRYRUN
if "%SRV_START%"=="0" goto FIND
echo node server.js
goto FIND
:FIND
rem 브라우저 찾기: Chrome 우선, 다음 Edge
set "BRW="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "BRW=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined BRW if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "BRW=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined BRW if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "BRW=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if not defined BRW if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "BRW=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not defined BRW if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "BRW=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if "%WD_DRY_RUN%"=="1" goto DRYBROWSER
if defined BRW goto RUNBROWSER
echo 브라우저를 찾지 못했습니다. 서버만 실행합니다.
goto BROWSEREND
:RUNBROWSER
start "" "%BRW%" --app=http://localhost:%PORT%/tv --start-fullscreen --window-size=1920,1080 --user-data-dir="%TEMP%\wd_monitor_profile" --disable-pinch --overscroll-history-navigation=0 --noerrdialogs --disable-infobars
goto BROWSEREND
:DRYBROWSER
if not defined BRW echo "chrome.exe" --app=http://localhost:%PORT%/tv --start-fullscreen --window-size=1920,1080 --user-data-dir="%TEMP%\wd_monitor_profile" --disable-pinch --overscroll-history-navigation=0 --noerrdialogs --disable-infobars
if not defined BRW goto BROWSEREND
echo "%BRW%" --app=http://localhost:%PORT%/tv --start-fullscreen --window-size=1920,1080 --user-data-dir="%TEMP%\wd_monitor_profile" --disable-pinch --overscroll-history-navigation=0 --noerrdialogs --disable-infobars
goto BROWSEREND
:BROWSEREND
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
