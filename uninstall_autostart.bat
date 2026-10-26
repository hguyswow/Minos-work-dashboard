@echo off
chcp 65001 >nul
schtasks /Delete /TN "WorkDashboardServer" /F
pause
