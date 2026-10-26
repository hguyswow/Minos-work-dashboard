; Minos Work Dashboard - Inno Setup Script
; 버전: 1.1.0
; 특징: 관리자 권한 불필요(PrivilegesRequired=lowest), Node 24 내장 동봉, 데이터는 %LOCALAPPDATA%\WorkDashboard에 영구 보존

#define MyAppName "Minos Work Dashboard"
#define MyAppVersion "1.1.0"
#define MyAppPublisher "Minos"
#define MyAppURL "https://github.com/minos"
#define MyAppExeName "run-launcher.vbs"

[Setup]
AppId={{8F3C2B1A-6D4E-4A7B-9C15-2E0D7A41B6F3}}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={localappdata}\Programs\WorkDashboard
DisableDirPage=no
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputBaseFilename=WorkDashboard-Setup-{#MyAppVersion}
OutputDir=Output
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
SetupIconFile=icon.ico
UninstallDisplayIcon={app}\icon.ico
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "korean"; MessagesFile: "compiler:Languages\Korean.isl,compiler:Default.isl"

[Tasks]
Name: "autorun"; Description: "윈도우 시작 시 자동 실행"; GroupDescription: "추가 설정:"
Name: "desktopicon"; Description: "바탕화면에 바로가기 만들기"; GroupDescription: "추가 아이콘:"; Flags: unchecked

[Files]
; 1. 런타임 및 핵심 스크립트
Source: "runtime\node.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\server.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "icon.ico"; DestDir: "{app}"; Flags: ignoreversion
Source: "launcher.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "run-launcher.vbs"; DestDir: "{app}"; Flags: ignoreversion

; 2. 웹 프론트엔드 에셋 (public/ 전체)
Source: "..\public\*"; DestDir: "{app}\public"; Flags: ignoreversion recursesubdirs createallsubdirs

; 주의: data.json, config.json, work.db, files/, backup/, _verify_tools 등 개발 및 실데이터 파일은 절대 동봉하지 않음

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\{#MyAppExeName}"""; WorkingDir: "{app}"; IconFilename: "{app}\icon.ico"; Comment: "작업현황 대시보드"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\{#MyAppExeName}"""; WorkingDir: "{app}"; IconFilename: "{app}\icon.ico"; Comment: "작업현황 대시보드"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "MinosWorkDashboard"; ValueData: """{sys}\wscript.exe"" ""{app}\{#MyAppExeName}"""; Flags: uninsdeletevalue; Tasks: autorun

[Run]
Filename: "{sys}\wscript.exe"; Parameters: """{app}\{#MyAppExeName}"""; Description: "{#MyAppName} 지금 실행"; Flags: nowait postinstall skipifsilent

[UninstallRun]
; 제거 시 실행 중인 launcher(powershell) 및 node 프로세스 안전 종료 (supervisor 지시 4단계: 런처 PID 확인 -> 자식 node.exe 종료 -> 8.3/정규화 경로 기준 node.exe 종료 -> 런처 powershell 종료)
Filename: "powershell.exe"; Parameters: "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -Command ""& {{ $a = '{app}'; $lp = @(Get-CimInstance Win32_Process | Where-Object {{ ($_.ProcessId -ne $PID) -and ($_.CommandLine -match 'launcher\.ps1') } | Select-Object -ExpandProperty ProcessId); if ($lp.Count -gt 0) {{ Get-CimInstance Win32_Process | Where-Object {{ ($_.Name -eq 'node.exe') -and ($lp -contains $_.ParentProcessId) } | Stop-Process -Force -ErrorAction SilentlyContinue }; $dirs = @($a); try {{ $dirs += (Get-Item -LiteralPath $a -ErrorAction SilentlyContinue).FullName } catch {{}; try {{ $fso = New-Object -ComObject Scripting.FileSystemObject; if ($fso.FolderExists($a)) {{ $dirs += $fso.GetFolder($a).ShortPath } } catch {{}; $dirs = @($dirs | Where-Object {{ $_ } | ForEach-Object {{ $_.TrimEnd('\') } | Select-Object -Unique); Get-CimInstance Win32_Process | Where-Object {{ ($_.Name -eq 'node.exe') -and ($_.CommandLine -match 'server\.js') } | ForEach-Object {{ $p = $_; $m = $false; if ($p.ExecutablePath) {{ $pd = [System.IO.Path]::GetDirectoryName($p.ExecutablePath).TrimEnd('\'); if ($dirs -contains $pd) {{ $m = $true } }; foreach ($d in $dirs) {{ if ($p.CommandLine -like ('*' + $d + '*')) {{ $m = $true; break } }; if ($m) {{ Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue } }; if ($lp.Count -gt 0) {{ Get-Process -Id $lp -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue }; exit 0 }"""; Flags: runhidden; RunOnceId: "StopProcesses"
; 자동실행 레지스트리 제거 확인
Filename: "powershell.exe"; Parameters: "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -Command ""Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'MinosWorkDashboard' -ErrorAction SilentlyContinue; exit 0"""; Flags: runhidden; RunOnceId: "RemoveAutoRun"

[UninstallDelete]
; 설치 디렉터리 내 생성물 정리 (데이터 디렉터리 %LOCALAPPDATA%\WorkDashboard는 영구 보존)
Type: files; Name: "{app}\*.*"
