' Minos Work Dashboard - Silent Launcher Wrapper
' 콘솔 창 깜빡임 0으로 launcher.ps1을 완전 백그라운드 기동
Set WshShell = CreateObject("WScript.Shell")
Set FSO = CreateObject("Scripting.FileSystemObject")
ScriptDir = FSO.GetParentFolderName(WScript.ScriptFullName)
PsCmd = "powershell.exe -WindowStyle Hidden -ExecutionPolicy Bypass -NoProfile -File """ & ScriptDir & "\launcher.ps1"""
WshShell.Run PsCmd, 0, False
