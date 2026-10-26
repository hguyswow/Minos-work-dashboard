@echo off
chcp 65001 >nul
cd /d "%~dp0"
title WorkDashboard Server (자동 재시작)
rem 운영 포트 (WD_PORT 환경변수가 있으면 그 값을 우선)
if not defined WD_PORT set "WD_PORT=3001"
rem 서버가 종료되면 5초 뒤 자동으로 다시 실행합니다. 창을 닫으면 완전히 중지됩니다.
:LOOP
echo [%date% %time%] 서버 시작
node server.js
echo [%date% %time%] 서버 종료됨. 5초 후 재시작합니다...
timeout /t 5 /nobreak >nul
goto LOOP
