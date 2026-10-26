@echo off
chcp 65001 >nul
rem Windows 로그인 시 서버(run_forever.bat)를 자동 실행하도록 작업 스케줄러에 등록합니다.
rem 해제: uninstall_autostart.bat
schtasks /Create /TN "WorkDashboardServer" /TR "cmd /c start \"WorkDashboard Server\" /min \"%~dp0run_forever.bat\"" /SC ONLOGON /RL LIMITED /F
if errorlevel 1 (
  echo 등록에 실패했습니다. 관리자 권한으로 다시 실행해 보세요.
) else (
  echo 등록 완료: 다음 로그인부터 서버가 자동으로 실행됩니다.
)
pause
