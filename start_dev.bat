@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo [개발 모드] 작업현황 대시보드 개발 서버를 시작합니다 (자동 재시작 및 브라우저 자동 새로고침)...
set "WD_DEV=1"
node --watch "%~dp0server.js"
