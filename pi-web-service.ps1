# pi-web 백그라운드 실행 관리 (창 없이 실행, 로그온 시 자동 시작)
#
#   .\pi-web-service.ps1 install     로그온할 때 자동 시작하도록 등록하고 지금 바로 시작
#   .\pi-web-service.ps1 uninstall   자동 시작 해제하고 서버 중지
#   .\pi-web-service.ps1 start       서버를 창 없이 시작
#   .\pi-web-service.ps1 stop        서버 중지
#   .\pi-web-service.ps1 restart     다시 시작 (코드를 고친 뒤)
#   .\pi-web-service.ps1 status      실행 여부와 접속 주소
#   .\pi-web-service.ps1 log         최근 로그 보기
#
# 원격 접속(--remote) 모드로 실행합니다. 로그인이 없으므로 Tailscale 같은 비공개 네트워크에서만 쓰세요.
# 다른 옵션이 필요하면 환경 변수 PI_WEB_ARGS 또는 아래 $ServerArgs 를 바꾸세요.
param([Parameter(Position = 0)][ValidateSet("help", "install", "uninstall", "start", "stop", "restart", "status", "log", "open", "setup", "unsetup")][string]$Action = "help")

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$TaskName = "pi-web"
$Port = if ($env:PI_WEB_PORT) { $env:PI_WEB_PORT } else { "8787" }
$ServerArgs = @("server.mjs", "--remote", "--port", $Port) + @($env:PI_WEB_ARGS -split "\s+" | Where-Object { $_ })
$LogDir = Join-Path $Root "logs"
$PidFile = Join-Path $LogDir "pi-web.pid"
$OutLog = Join-Path $LogDir "pi-web.log"
$ErrLog = Join-Path $LogDir "pi-web.err.log"

function Get-ServerProcess {
    # pid 파일에 적힌 프로세스가 정말 이 서버인지 확인한다 (다른 프로그램이 같은 pid를 쓰는 경우 방지)
    if (-not (Test-Path $PidFile)) { return $null }
    $id = [int](Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue
    # 명령줄을 못 읽는 경우(권한 등)에는 node.exe 이면 이 서버로 본다
    if ($p -and $p.Name -eq "node.exe" -and (-not $p.CommandLine -or $p.CommandLine -match "server\.mjs")) { return $p }
    return $null
}

function Test-PortBusy { [bool](Get-NetTCPConnection -State Listen -LocalPort ([int]$Port) -ErrorAction SilentlyContinue) }

function Start-Server {
    if (Get-ServerProcess) { Write-Host "이미 실행 중입니다."; return }
    if (Test-PortBusy) {
        Write-Warning "포트 $Port 를 다른 프로그램이 쓰고 있습니다. 직접 켜 둔 pi-web(cmd 창)이 있다면 먼저 닫으세요."
        return
    }
    $node = (Get-Command node -ErrorAction Stop).Source
    New-Item -ItemType Directory -Force $LogDir | Out-Null
    if (Test-Path $OutLog) { Move-Item $OutLog "$OutLog.old" -Force }
    if (Test-Path $ErrLog) { Move-Item $ErrLog "$ErrLog.old" -Force }
    $proc = Start-Process -FilePath $node -ArgumentList $ServerArgs -WorkingDirectory $Root -WindowStyle Hidden -PassThru -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog
    Set-Content $PidFile $proc.Id
    Start-Sleep -Seconds 2
    if ($proc.HasExited) { Write-Warning "서버가 바로 종료되었습니다. 로그를 확인하세요: $ErrLog"; Get-Content $ErrLog -Tail 10 -ErrorAction SilentlyContinue; return }
    Write-Host "시작했습니다 (pid $($proc.Id))."
}

function Stop-Server {
    $p = Get-ServerProcess
    if (-not $p) { Write-Host "실행 중인 서버가 없습니다."; return }
    Stop-Process -Id $p.ProcessId -Force
    Remove-Item $PidFile -ErrorAction SilentlyContinue
    Write-Host "중지했습니다."
}

function Show-Status {
    $p = Get-ServerProcess
    if ($p) { Write-Host "서버: 실행 중 (pid $($p.ProcessId))" } elseif (Test-PortBusy) { Write-Host "서버: 이 스크립트가 아닌 다른 방법으로 포트 $Port 에서 실행 중" } else { Write-Host "서버: 꺼져 있음" }
    $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Write-Host ("자동 시작: " + $(if ($t) { "등록됨 (로그온할 때)" } else { "등록 안 됨" }))
    Write-Host "이 PC: http://localhost:$Port"
    $ts = Get-Command tailscale -ErrorAction SilentlyContinue
    if ($ts) {
        $ip = (& tailscale ip -4 2>$null | Select-Object -First 1)
        if ($ip) { Write-Host "Tailscale: http://${ip}:$Port" }
    }
}

function Show-Help {
    Write-Host ""
    Write-Host "pi-web 관리 명령   (사용법: piweb <명령>)"
    Write-Host ""
    Write-Host "  status      실행 여부와 접속 주소 보기"
    Write-Host "  open        브라우저로 열기"
    Write-Host "  start       서버 시작 (창 없이)"
    Write-Host "  stop        서버 중지"
    Write-Host "  restart     다시 시작 (코드를 고친 뒤)"
    Write-Host "  log         최근 로그 보기"
    Write-Host "  install     로그온할 때 자동 시작 등록 + 시작"
    Write-Host "  uninstall   자동 시작 해제 + 중지"
    Write-Host "  setup       어느 폴더에서든 piweb 을 쓸 수 있게 PATH 에 등록 (한 번만)"
    Write-Host "  unsetup     PATH 등록 해제"
    Write-Host ""
    Show-Status
}

switch ($Action) {
    "help" { Show-Help }
    "setup" {
        $user = [Environment]::GetEnvironmentVariable("Path", "User")
        $parts = @($user -split ";" | Where-Object { $_ })
        if ($parts -contains $Root) { Write-Host "이미 등록되어 있습니다." } else {
            [Environment]::SetEnvironmentVariable("Path", (($parts + $Root) -join ";"), "User")
            Write-Host "PATH 에 등록했습니다: $Root"
        }
        Write-Host "이미 열려 있는 cmd/PowerShell 창은 닫고 새로 연 뒤 'piweb' 을 입력하세요."
    }
    "unsetup" {
        $user = [Environment]::GetEnvironmentVariable("Path", "User")
        $parts = @($user -split ";" | Where-Object { $_ -and $_ -ne $Root })
        [Environment]::SetEnvironmentVariable("Path", ($parts -join ";"), "User")
        Write-Host "PATH 등록을 해제했습니다."
    }
    "open" { Start-Process "http://localhost:$Port" }
    "install" {
        $script = Join-Path $Root "pi-web-service.ps1"
        $arg = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`" start"
        $act = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arg -WorkingDirectory $Root
        $trg = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
        $set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
        Register-ScheduledTask -TaskName $TaskName -Action $act -Trigger $trg -Settings $set -Description "pi-web 서버를 로그온할 때 창 없이 시작" -Force | Out-Null
        Write-Host "자동 시작을 등록했습니다."
        Start-Server
        Show-Status
    }
    "uninstall" {
        if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false; Write-Host "자동 시작을 해제했습니다." }
        Stop-Server
    }
    "start" { Start-Server }
    "stop" { Stop-Server }
    "restart" { Stop-Server; Start-Sleep -Seconds 1; Start-Server }
    "status" { Show-Status }
    "log" { if (Test-Path $OutLog) { Get-Content $OutLog -Tail 40 }; if (Test-Path $ErrLog) { Get-Content $ErrLog -Tail 20 } }
}
