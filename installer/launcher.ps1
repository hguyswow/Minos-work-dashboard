# Minos Work Dashboard - Tray Launcher
# WinForms NotifyIcon 기반 백그라운드 트레이 런처

[CmdletBinding()]
param(
    [switch]$Stop
)

# 제거(Uninstall) 또는 관리자에 의한 프로세스 종료 요청 처리
if ($Stop) {
    $myPid = $PID
    $targetDir = $PSScriptRoot
    Get-CimInstance Win32_Process | Where-Object {
        ($_.ProcessId -ne $myPid) -and (
            ($_.CommandLine -like "*$targetDir*launcher.ps1*") -or
            ($_.CommandLine -like "*$targetDir*node.exe*") -or
            ($_.Name -eq "node.exe" -and $_.CommandLine -like "*$targetDir*server.js*")
        )
    } | ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
    exit 0
}

# WinForms 및 Drawing 어셈블리 로드
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# 1. 앱 기본 디렉터리 및 데이터 디렉터리 설정
# 배포 구조(app 루트에 배치되거나 installer 서브폴더에 배치되는 경우 모두 대응)
$appDir = $PSScriptRoot
if (-not (Test-Path (Join-Path $appDir "server.js"))) {
    $parent = Split-Path -Parent $appDir
    if (Test-Path (Join-Path $parent "server.js")) {
        $appDir = $parent
    }
}

if ($env:WD_DATA_DIR -and (Test-Path $env:WD_DATA_DIR)) {
    $dataDir = $env:WD_DATA_DIR
} else {
    $dataDir = [System.IO.Path]::Combine($env:LOCALAPPDATA, 'WorkDashboard')
    if (-not (Test-Path $dataDir)) {
        [System.IO.Directory]::CreateDirectory($dataDir) | Out-Null
    }
    $env:WD_DATA_DIR = $dataDir
}

# 2. 포트 결정 (WD-36 규칙: WD_PORT 우선, 없으면 config.json, 없으면 3000)
$port = 3000
if ($env:WD_PORT -match '^\d+$') {
    $port = [int]$env:WD_PORT
} elseif ($env:PORT -match '^\d+$') {
    $port = [int]$env:PORT
} else {
    $confFile = Join-Path $dataDir "config.json"
    if (Test-Path $confFile) {
        try {
            $confContent = Get-Content -LiteralPath $confFile -Raw -Encoding UTF8 -ErrorAction Stop
            $json = ConvertFrom-Json $confContent -ErrorAction Stop
            if ($json.port -and [string]$json.port -match '^\d+$') {
                $port = [int]$json.port
            }
        } catch {
            $port = 3000
        }
    }
}
$urlDashboard = "http://localhost:$port/"
$urlTv = "http://localhost:$port/tv"

# 3. 단일 인스턴스 뮤텍스 (중복 실행 방지)
$mutexName = "Global\MinosWorkDashboardLauncherMutex_$port"
$createdNew = $false
$mutex = [System.Threading.Mutex]::new($true, $mutexName, [ref]$createdNew)

if (-not $createdNew) {
    # 이미 다른 런처가 실행 중이면 브라우저로 대시보드 창만 띄우고 종료
    Start-Process $urlDashboard
    exit 0
}

# 4. 포트 리슨 여부 확인 및 Node 서버 자식 프로세스 기동
function Test-PortListening([int]$p) {
    try {
        $tcp = [System.Net.Sockets.TcpClient]::new()
        $ar = $tcp.BeginConnect("127.0.0.1", $p, $null, $null)
        $success = $ar.AsyncWaitHandle.WaitOne(400, $false)
        if ($success -and $tcp.Connected) {
            $tcp.EndConnect($ar)
            $tcp.Close()
            return $true
        }
        $tcp.Close()
    } catch {}
    return $false
}

$script:serverProcess = $null
$script:startedByMe = $false
$script:isExiting = $false
$script:consecutivePortFailures = 0
$script:restartHistory = [System.Collections.Generic.List[datetime]]::new()
$script:circuitBroken = $false

# Node.js 실행 바이너리 탐색 (동봉 runtime/node.exe 또는 appDir/node.exe 우선, 없으면 시스템 node)
$nodeCandidates = @(
    (Join-Path $appDir "node.exe"),
    (Join-Path $appDir "runtime\node.exe"),
    (Join-Path $PSScriptRoot "runtime\node.exe"),
    "C:\Program Files\nodejs\node.exe"
)
$script:nodeExe = $null
foreach ($c in $nodeCandidates) {
    if ($c -and (Test-Path -LiteralPath $c)) {
        $script:nodeExe = $c
        break
    }
}
if (-not $script:nodeExe) {
    $nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($nodeCmd) { $script:nodeExe = $nodeCmd.Source }
}

function Start-DashboardServer([bool]$isRestart = $false) {
    $targetNode = $script:nodeExe
    if (-not $targetNode) {
        if (-not $isRestart) {
            [System.Windows.Forms.MessageBox]::Show(
                "Node.js 런타임을 찾을 수 없습니다.`n프로그램을 다시 설치하거나 Node.js 22 이상을 설치해 주세요.",
                "Minos Work Dashboard - 오류",
                [System.Windows.Forms.MessageBoxButtons]::OK,
                [System.Windows.Forms.MessageBoxIcon]::Error
            ) | Out-Null
            exit 1
        }
        return $false
    }

    $targetAppDir = if ($script:appDir) { $script:appDir } else { $appDir }
    $targetDataDir = if ($script:dataDir) { $script:dataDir } else { $dataDir }
    $targetPort = if ($script:port) { $script:port } else { $port }

    # 창 없이 백그라운드 프로세스로 server.js 기동
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $targetNode
    $psi.Arguments = "server.js"
    $psi.WorkingDirectory = $targetAppDir
    $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
    $psi.CreateNoWindow = $true
    $psi.UseShellExecute = $false
    $psi.EnvironmentVariables['WD_DATA_DIR'] = $targetDataDir
    $psi.EnvironmentVariables['PORT'] = [string]$targetPort
    $psi.EnvironmentVariables['WD_PORT'] = [string]$targetPort

    try {
        $script:serverProcess = [System.Diagnostics.Process]::Start($psi)
        $script:startedByMe = $true
        # 서버 기동 대기 (최대 3초)
        for ($i = 0; $i -lt 15; $i++) {
            Start-Sleep -Milliseconds 200
            if (Test-PortListening $targetPort) { break }
        }
        return $true
    } catch {
        if (-not $isRestart) {
            [System.Windows.Forms.MessageBox]::Show(
                "대시보드 서버를 시작하지 못했습니다:`n" + $_.Exception.Message,
                "Minos Work Dashboard - 오류",
                [System.Windows.Forms.MessageBoxButtons]::OK,
                [System.Windows.Forms.MessageBoxIcon]::Error
            ) | Out-Null
        }
        return $false
    }
}

if (-not (Test-PortListening $port)) {
    Start-DashboardServer -isRestart $false | Out-Null
}

# 5. 트레이 아이콘 및 메뉴 생성
[System.Windows.Forms.Application]::EnableVisualStyles()

$notifyIcon = [System.Windows.Forms.NotifyIcon]::new()
$notifyIcon.Text = "Minos Work Dashboard ($port)"

# 아이콘 로드 (동봉 icon.ico 탐색)
$icoCandidates = @(
    (Join-Path $appDir "icon.ico"),
    (Join-Path $PSScriptRoot "icon.ico")
)
$iconLoaded = $false
foreach ($icoPath in $icoCandidates) {
    if (Test-Path -LiteralPath $icoPath) {
        try {
            $notifyIcon.Icon = [System.Drawing.Icon]::new($icoPath)
            $iconLoaded = $true
            break
        } catch {}
    }
}
if (-not $iconLoaded) {
    $notifyIcon.Icon = [System.Drawing.SystemIcons]::Application
}

# 자동 실행 레지스트리 헬퍼
$runRegPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$runRegName = "MinosWorkDashboard"

function Test-AutoRunEnabled {
    $val = Get-ItemProperty -Path $runRegPath -Name $runRegName -ErrorAction SilentlyContinue
    return ($null -ne $val -and $null -ne $val.$runRegName)
}

function Set-AutoRunState([bool]$enable) {
    if ($enable) {
        # vbs 래퍼가 있으면 vbs, 없으면 powershell 명령
        $vbsPath = Join-Path $appDir "run-launcher.vbs"
        if (-not (Test-Path -LiteralPath $vbsPath)) {
            $vbsPath = Join-Path $PSScriptRoot "run-launcher.vbs"
        }
        if (Test-Path -LiteralPath $vbsPath) {
            $cmd = "wscript.exe `"$vbsPath`""
        } else {
            $scriptPath = $PSCommandPath
            $cmd = "powershell.exe -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$scriptPath`""
        }
        Set-ItemProperty -Path $runRegPath -Name $runRegName -Value $cmd
    } else {
        Remove-ItemProperty -Path $runRegPath -Name $runRegName -ErrorAction SilentlyContinue
    }
}

# 브라우저 실행 헬퍼
function Open-BrowserUrl([string]$targetUrl, [bool]$asAppMode) {
    if ($asAppMode) {
        $chromePaths = @(
            "C:\Program Files\Google\Chrome\Application\chrome.exe",
            "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
            (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe"),
            "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
            "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
        )
        $browser = $null
        foreach ($b in $chromePaths) {
            if (Test-Path -LiteralPath $b) { $browser = $b; break }
        }
        if ($browser) {
            Start-Process $browser -ArgumentList "--app=$targetUrl"
            return
        }
    }
    Start-Process $targetUrl
}

# 컨텍스트 메뉴 조립
$contextMenu = [System.Windows.Forms.ContextMenuStrip]::new()

# 메뉴 1: 열기
$itemOpen = $contextMenu.Items.Add("열기 (대시보드)")
$itemOpen.Font = [System.Drawing.Font]::new($contextMenu.Font, [System.Drawing.FontStyle]::Bold)
$itemOpen.add_Click({ Open-BrowserUrl $urlDashboard $false })

# 메뉴 2: 모니터용 전체화면
$itemTv = $contextMenu.Items.Add("모니터용 전체화면 열기 (/tv)")
$itemTv.add_Click({ Open-BrowserUrl $urlTv $true })

# 메뉴 3: 데이터 폴더 열기 (편의 기능)
$itemData = $contextMenu.Items.Add("데이터 폴더 열기")
$itemData.add_Click({ Start-Process "explorer.exe" -ArgumentList "`"$dataDir`"" })

$contextMenu.Items.Add("-") | Out-Null

# 메뉴 4: 윈도우 시작 시 자동 실행 (체크박스 토글)
$itemAuto = $contextMenu.Items.Add("윈도우 시작 시 자동 실행")
$itemAuto.CheckOnClick = $true
$itemAuto.Checked = Test-AutoRunEnabled
$itemAuto.add_Click({
    Set-AutoRunState $itemAuto.Checked
})

$contextMenu.Items.Add("-") | Out-Null

# 메뉴 5: 종료
$itemExit = $contextMenu.Items.Add("종료")
$itemExit.add_Click({
    $script:isExiting = $true
    if ($watchTimer) {
        try { $watchTimer.Stop() } catch {}
        try { $watchTimer.Dispose() } catch {}
    }

    # 트레이 아이콘 숨김 및 정리
    $notifyIcon.Visible = $false
    $notifyIcon.Dispose()

    # launcher가 실행한 서버 자식 프로세스 정리
    if ($startedByMe -and $serverProcess -and (-not $serverProcess.HasExited)) {
        try {
            $serverProcess.Kill()
            $serverProcess.WaitForExit(1000)
        } catch {}
    }

    if ($mutex) {
        try { $mutex.ReleaseMutex() } catch {}
        $mutex.Dispose()
    }

    [System.Windows.Forms.Application]::ExitThread()
})

$notifyIcon.ContextMenuStrip = $contextMenu

# 더블클릭 = 기본 대시보드 열기
$notifyIcon.add_DoubleClick({ Open-BrowserUrl $urlDashboard $false })

# 트레이 표시 시작
$notifyIcon.Visible = $true

# 시작 안내 풍선 알림 (3초간 가볍게 표시)
$notifyIcon.ShowBalloonTip(3000, "Minos Work Dashboard 실행 중", "트레이 아이콘에서 대시보드를 열거나 설정을 관리할 수 있습니다.", [System.Windows.Forms.ToolTipIcon]::Info)

# 6. 서버 자동 재기동 감시 타이머 (WD-64: $startedByMe일 때만 10초 주기 감시)
$watchTimer = $null
if ($startedByMe) {
    $watchTimer = [System.Windows.Forms.Timer]::new()
    $watchTimer.Interval = 10000
    $watchTimer.add_Tick({
        if ($script:isExiting -or (-not $script:startedByMe)) { return }

        $now = [datetime]::Now
        # 10분 이전 재기동 이력 정리 (성공 후 10분 지나면 카운터 초기화)
        while ($script:restartHistory.Count -gt 0 -and ($now - $script:restartHistory[0]).TotalMinutes -gt 10) {
            $script:restartHistory.RemoveAt(0)
        }

        if ($script:circuitBroken) {
            if ($script:restartHistory.Count -lt 5) {
                $script:circuitBroken = $false
            } else {
                return
            }
        }

        # Case A: 프로세스 종료 감지
        $isDead = $false
        if ($null -eq $script:serverProcess) {
            $isDead = $true
        } else {
            try {
                $isDead = $script:serverProcess.HasExited
            } catch {
                $isDead = $true
            }
        }

        if ($isDead) {
            if ($script:restartHistory.Count -ge 5) {
                $script:circuitBroken = $true
                if ($notifyIcon) {
                    $notifyIcon.ShowBalloonTip(5000, "Minos Work Dashboard - 오류", "서버가 반복 중단되어 자동 재시작을 중단했습니다. 로그를 확인해 주세요.", [System.Windows.Forms.ToolTipIcon]::Error)
                }
                return
            }

            $script:restartHistory.Add($now)
            $script:consecutivePortFailures = 0
            Start-DashboardServer -isRestart $true | Out-Null
            if ($notifyIcon) {
                $notifyIcon.ShowBalloonTip(3000, "Minos Work Dashboard", "서버가 중단되어 다시 시작했습니다.", [System.Windows.Forms.ToolTipIcon]::Warning)
            }
            return
        }

        # Case B: 프로세스는 살아 있으나 포트 응답 여부 확인 (행 감시)
        $targetPort = if ($script:port) { $script:port } else { $port }
        if (Test-PortListening $targetPort) {
            $script:consecutivePortFailures = 0
        } else {
            $script:consecutivePortFailures++
            if ($script:consecutivePortFailures -ge 3) {
                try {
                    if ($script:serverProcess -and (-not $script:serverProcess.HasExited)) {
                        $script:serverProcess.Kill()
                        $script:serverProcess.WaitForExit(1000)
                    }
                } catch {}

                $script:consecutivePortFailures = 0
                if ($script:restartHistory.Count -ge 5) {
                    $script:circuitBroken = $true
                    if ($notifyIcon) {
                        $notifyIcon.ShowBalloonTip(5000, "Minos Work Dashboard - 오류", "서버가 반복 중단되어 자동 재시작을 중단했습니다. 로그를 확인해 주세요.", [System.Windows.Forms.ToolTipIcon]::Error)
                    }
                    return
                }

                $script:restartHistory.Add($now)
                Start-DashboardServer -isRestart $true | Out-Null
                if ($notifyIcon) {
                    $notifyIcon.ShowBalloonTip(3000, "Minos Work Dashboard", "서버가 응답하지 않아 다시 시작했습니다.", [System.Windows.Forms.ToolTipIcon]::Warning)
                }
            }
        }
    })
    $watchTimer.Start()
}

# WinForms 메시지 루프 기동
try {
    [System.Windows.Forms.Application]::Run()
} finally {
    $script:isExiting = $true
    if ($watchTimer) {
        try { $watchTimer.Stop() } catch {}
        try { $watchTimer.Dispose() } catch {}
    }
    if ($notifyIcon) {
        $notifyIcon.Visible = $false
        $notifyIcon.Dispose()
    }
    if ($startedByMe -and $serverProcess -and (-not $serverProcess.HasExited)) {
        try { $serverProcess.Kill() } catch {}
    }
    if ($mutex) {
        try { $mutex.ReleaseMutex() } catch {}
        $mutex.Dispose()
    }
}
