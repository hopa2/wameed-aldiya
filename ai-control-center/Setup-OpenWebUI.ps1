<#
.SYNOPSIS
    One-shot setup of Open WebUI as a single-page AI control center on Windows 11.
    Built for: i7-13650HX, 32 GB RAM, NVIDIA RTX 4060 Laptop (8 GB VRAM).

.DESCRIPTION
    1. Checks the NVIDIA GPU/driver, Docker Desktop, Python and Ollama.
    2. Downloads local models that fit in 8 GB of VRAM (optional) and warns
       about any installed model that is too big for the GPU.
    3. Runs Open WebUI (Docker preferred, Python/pip fallback), connected to
       the Ollama instance running natively on Windows (so Ollama uses the GPU).
    4. Keeps data persistent (Docker volume "open-webui", or the folder
       %LOCALAPPDATA%\OpenWebUI\data for the pip install) and makes Open WebUI
       start by itself after a reboot.
    5. Listens on all interfaces (0.0.0.0) and adds a Windows Firewall rule that
       only allows the Tailscale address range (100.64.0.0/10).
    6. Verifies everything and prints the URLs to open.

    No API keys are stored by this script. You enter them in the web page.
    Safe to run again at any time: it updates Open WebUI and keeps your data.

.PARAMETER Port
    Port to open in the browser. Default 3000 (or the port used last time).
    8080 is left free for the Wameed business dashboard (system/dashboard).
    If 3000 is busy, 3100 is tried.

.PARAMETER PullModels
    Download the models listed in -Models into Ollama.

.PARAMETER Models
    Models to download with -PullModels. Default: qwen2.5:7b,llama3.1:8b
    (about 5 GB each; both fit fully in 8 GB of VRAM).

.PARAMETER OptimizeOllama
    Set Ollama options that save VRAM on an 8 GB card (flash attention and an
    8-bit context cache), so longer chats stay on the GPU. Restarts Ollama.

.PARAMETER AllowDockerToOllama
    Make Ollama listen on all interfaces (OLLAMA_HOST=0.0.0.0) so the Docker
    container can reach it. Only needed if the script reports that the
    container cannot reach Ollama. Restarts Ollama.

.PARAMETER ForcePip
    Skip Docker and use the Python/pip install even if Docker is available.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Setup-OpenWebUI.ps1 -PullModels -OptimizeOllama
#>
[CmdletBinding()]
param(
    [int]$Port = 3000,
    [switch]$PullModels,
    [string[]]$Models = @('qwen2.5:7b', 'llama3.1:8b'),
    [switch]$OptimizeOllama,
    [switch]$AllowDockerToOllama,
    [switch]$ForcePip
)

# 'Continue' on purpose: in Windows PowerShell 5.1, 'Stop' turns any text a
# program writes to stderr (docker, py, tailscale...) into a crash. Every
# step below checks its own result instead.
$ErrorActionPreference = 'Continue'
$ProgressPreference    = 'SilentlyContinue'   # makes Invoke-WebRequest much faster on 5.1

$ContainerName = 'open-webui'
$Image         = 'ghcr.io/open-webui/open-webui:main'
$AppDir        = Join-Path $env:LOCALAPPDATA 'OpenWebUI'
$SecretFile    = Join-Path $AppDir 'webui_secret.key'
$PortFile      = Join-Path $AppDir 'port.txt'
$TaskName      = 'OpenWebUI'
$FirewallRule  = 'Open WebUI (Tailscale only)'
$TailscaleCidr = '100.64.0.0/10'
$OllamaUrl     = 'http://127.0.0.1:11434'

function Step($msg) { Write-Host ""; Write-Host "==> $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "    [OK]   $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "    [WARN] $msg" -ForegroundColor Yellow }
function Info($msg) { Write-Host "    $msg" }
function Fail($msg) {
    Write-Host ""
    Write-Host "    [ERROR] $msg" -ForegroundColor Red
    Write-Host ""
    exit 1
}

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    (New-Object Security.Principal.WindowsPrincipal $id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Test-PortBusy([int]$p) {
    $null -ne (Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue)
}

function Test-Url([string]$url) {
    try { $null = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop; return $true }
    catch { return $false }
}

function Find-Exe([string]$name, [string[]]$extraPaths) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    foreach ($p in $extraPaths) { if ($p -and (Test-Path $p)) { return $p } }
    return $null
}

function Get-OrCreateSecret {
    # A fixed secret key keeps you logged in when the container is recreated/updated.
    if (Test-Path $SecretFile) {
        $k = (Get-Content $SecretFile -Raw).Trim()
        if ($k) { return $k }
    }
    $bytes = New-Object byte[] 32
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $key = [Convert]::ToBase64String($bytes)
    Set-Content -Path $SecretFile -Value $key -NoNewline -Encoding ASCII
    # Only the current user may read it.
    & icacls $SecretFile /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null
    return $key
}

function Set-UserEnv([string]$name, [string]$value) {
    [Environment]::SetEnvironmentVariable($name, $value, 'User')
    Set-Item -Path "Env:$name" -Value $value      # so the Ollama we start now sees it too
}

function Start-Ollama([string]$exe) {
    $app = Join-Path (Split-Path $exe) 'ollama app.exe'
    if (Test-Path $app) { Start-Process $app } else { Start-Process $exe -ArgumentList 'serve' -WindowStyle Hidden }
    for ($i = 0; $i -lt 20 -and -not (Test-Url "$OllamaUrl/api/version"); $i++) { Start-Sleep 2 }
    return (Test-Url "$OllamaUrl/api/version")
}

function Restart-Ollama([string]$exe) {
    Info "Restarting Ollama so the new settings take effect..."
    Get-Process -Name 'ollama app', 'ollama' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep 3
    return (Start-Ollama $exe)
}

function Stop-PipOpenWebUI {
    # Stop a previous pip install of ours, so its port is free again.
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    # The open-webui.exe launcher and the python.exe it starts both live in our venv.
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.ExecutablePath -and $_.ExecutablePath -like "$AppDir\venv\*" } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep 2
}

if (-not (Test-Path $AppDir)) { New-Item -ItemType Directory -Path $AppDir | Out-Null }

# Reuse last time's port unless -Port was given, so your bookmarks keep working.
if (-not $PSBoundParameters.ContainsKey('Port') -and (Test-Path $PortFile)) {
    $saved = 0
    if ([int]::TryParse((Get-Content $PortFile -Raw).Trim(), [ref]$saved) -and $saved -gt 0) { $Port = $saved }
}
# "-Models a,b" passed through the .cmd file arrives as one string.
$Models = @($Models | ForEach-Object { $_ -split '[,\s]+' } | Where-Object { $_ })

# ---------------------------------------------------------------------------
Step "1/6  Checking your PC"
# ---------------------------------------------------------------------------
$isAdmin = Test-Admin
if ($isAdmin) { Ok "Running as Administrator" }
else { Warn "Not Administrator: the Tailscale firewall rule will be skipped. Double-click Setup-OpenWebUI.cmd instead." }

$power = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue
if ($power -and $power.BatteryStatus -eq 1) { Warn "The laptop is on battery. Plug it in: the RTX 4060 is much slower on battery." }

# --- NVIDIA GPU ---
$vramMiB = 0
$smi = Find-Exe 'nvidia-smi' @("$env:SystemRoot\System32\nvidia-smi.exe")
if ($smi) {
    $gpuLine = (& $smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits 2>$null | Select-Object -First 1)
    if ($gpuLine) {
        $parts   = $gpuLine -split ',\s*'
        $vramMiB = [int]$parts[1]
        Ok ("NVIDIA GPU: {0}, {1:N1} GB VRAM, driver {2}" -f $parts[0], ($vramMiB / 1024), $parts[2])
    } else {
        Warn "nvidia-smi is installed but found no GPU. Update the NVIDIA driver and reboot."
    }
} else {
    Warn "nvidia-smi not found. Install the latest NVIDIA driver (nvidia.com/drivers) so Ollama can use the RTX 4060."
}

# --- Docker ---
$useDocker = $false
$docker = Find-Exe 'docker' @("$env:ProgramFiles\Docker\Docker\resources\bin\docker.exe")
if ($ForcePip) {
    Info "-ForcePip given: skipping Docker."
} elseif ($docker) {
    Ok "Docker CLI found: $docker"
    & $docker info *> $null
    if ($LASTEXITCODE -ne 0) {
        $dd = "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe"
        if (Test-Path $dd) {
            Info "Docker Desktop is not running. Starting it (this can take 1-2 minutes)..."
            Start-Process $dd
            for ($i = 0; $i -lt 40; $i++) {
                Start-Sleep -Seconds 5
                & $docker info *> $null
                if ($LASTEXITCODE -eq 0) { break }
            }
        }
    }
    & $docker info *> $null
    if ($LASTEXITCODE -eq 0) { Ok "Docker engine is running"; $useDocker = $true }
    else { Warn "Docker is installed but the engine did not start. Falling back to Python." }
} else {
    Info "Docker not found. The Python method will be used instead."
}

# --- Python (only needed for the fallback) ---
$pyExe = $null; $pyArgs = @()
if (-not $useDocker) {
    # Open WebUI's pip package supports Python 3.11 (recommended) and 3.12.
    if (Get-Command py -ErrorAction SilentlyContinue) {
        foreach ($v in @('3.11', '3.12')) {
            & py "-$v" --version *> $null
            if ($LASTEXITCODE -eq 0) { $pyExe = 'py'; $pyArgs = @("-$v"); break }
        }
    }
    if (-not $pyExe -and (Get-Command python -ErrorAction SilentlyContinue)) {
        $ver = ((& python --version 2>&1) | Out-String).Trim() -replace 'Python ', ''
        if ($ver -match '^3\.(11|12)\.') { $pyExe = 'python' }
    }
    if ($pyExe) {
        $pyVer = ((& $pyExe @pyArgs --version 2>&1) | Out-String).Trim()
        Ok "Python found: $pyVer"
    }
    else {
        Write-Host ""
        Write-Host "Neither Docker nor Python 3.11/3.12 is available." -ForegroundColor Red
        Write-Host "Install ONE of these, then run this setup again:"
        Write-Host "  Recommended: winget install Docker.DockerDesktop   (then reboot and open Docker Desktop once)"
        Write-Host "  Alternative: winget install Python.Python.3.11"
        exit 1
    }
}

# --- Ollama ---
$ollama = Find-Exe 'ollama' @("$env:LOCALAPPDATA\Programs\Ollama\ollama.exe")
if (-not $ollama) { Fail "Ollama is not installed. Install it with:  winget install Ollama.Ollama   then run this setup again." }
Ok "Ollama found: $ollama"
if (-not (Test-Url "$OllamaUrl/api/version")) {
    Info "Ollama is not running. Starting it..."
    if (-not (Start-Ollama $ollama)) { Fail "Ollama did not start. Open Ollama from the Start menu and run this setup again." }
}

$needRestart = $false
if ($OptimizeOllama) {
    Set-UserEnv 'OLLAMA_FLASH_ATTENTION' '1'
    Set-UserEnv 'OLLAMA_KV_CACHE_TYPE'   'q8_0'
    Ok "Ollama VRAM savings on: OLLAMA_FLASH_ATTENTION=1, OLLAMA_KV_CACHE_TYPE=q8_0"
    $needRestart = $true
}
if ($AllowDockerToOllama) {
    Set-UserEnv 'OLLAMA_HOST' '0.0.0.0'
    Ok "OLLAMA_HOST=0.0.0.0 (Windows Firewall still blocks port 11434 from other devices unless you allow it)"
    $needRestart = $true
}
if ($needRestart -and -not (Restart-Ollama $ollama)) { Fail "Ollama did not come back after the restart. Open it from the Start menu and run this setup again." }

$ov = (Invoke-RestMethod "$OllamaUrl/api/version" -ErrorAction SilentlyContinue).version
Ok "Ollama is running (version $ov) on $OllamaUrl"

# ---------------------------------------------------------------------------
Step "2/6  Local models for an 8 GB GPU"
# ---------------------------------------------------------------------------
if ($PullModels) {
    foreach ($m in $Models) {
        Info "Downloading $m (several GB, please wait)..."
        & $ollama pull $m
        if ($LASTEXITCODE -eq 0) { Ok "Downloaded $m" } else { Warn "Could not download $m. Check the name on ollama.com/library." }
    }
}

$installed = @((Invoke-RestMethod "$OllamaUrl/api/tags" -ErrorAction SilentlyContinue).models)
if ($installed.Count -eq 0) {
    Warn "No local models yet. Run this setup again with -PullModels, or:  ollama pull qwen2.5:7b"
} else {
    # A model runs fully on the GPU only if its file plus ~1.5 GB (context cache + overhead) fits in VRAM.
    $budgetGB = if ($vramMiB -gt 0) { ($vramMiB / 1024) - 1.5 } else { 6.5 }
    foreach ($m in $installed) {
        $gb = [math]::Round($m.size / 1GB, 1)
        if ($gb -le $budgetGB) { Ok "$($m.name)  ($gb GB)  fits on the GPU" }
        else { Warn "$($m.name)  ($gb GB)  is too big for 8 GB VRAM: it will run partly on the CPU and be slow" }
    }
}

# ---------------------------------------------------------------------------
Step "3/6  Deploying Open WebUI"
# ---------------------------------------------------------------------------
$secret = Get-OrCreateSecret

# Free our own old instance first, so a re-run keeps the same port.
if ($docker) {
    & $docker info *> $null
    if ($LASTEXITCODE -eq 0) {
        $existing = & $docker ps -a --filter "name=^/$ContainerName$" --format '{{.Names}}' 2>$null
        if ($existing) {
            Info "Replacing the existing '$ContainerName' container (your chats and settings are kept)..."
            & $docker rm -f $ContainerName *> $null
        }
    }
}
Stop-PipOpenWebUI
if ($useDocker) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue }

if (Test-PortBusy $Port) {
    $old = $Port
    $Port = if ($old -eq 3100) { 3200 } else { 3100 }
    Warn "Port $old is already used by another program. Switching to $Port."
    if (Test-PortBusy $Port) { Fail "Port $Port is also busy. Run again with another port, e.g.  Setup-OpenWebUI.cmd -Port 3300" }
}

if ($useDocker) {
    Info "Downloading the latest Open WebUI image (first time about 2-4 GB)..."
    & $docker pull $Image
    if ($LASTEXITCODE -ne 0) { Fail "docker pull failed. Check your internet connection and try again." }

    # -p 0.0.0.0:PORT:8080             listen on every interface (the firewall rule limits who gets in)
    # host.docker.internal             how the container reaches Ollama running on Windows
    # -v open-webui:/app/backend/data  persistent Docker volume (safer than an NTFS folder for SQLite)
    # --restart always                 comes back by itself after a reboot / Docker restart
    & $docker run -d `
        --name $ContainerName `
        --restart always `
        -p "0.0.0.0:${Port}:8080" `
        --add-host=host.docker.internal:host-gateway `
        -e OLLAMA_BASE_URL=http://host.docker.internal:11434 `
        -e "WEBUI_SECRET_KEY=$secret" `
        -v open-webui:/app/backend/data `
        $Image | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "docker run failed. See the message above." }
    Ok "Container '$ContainerName' started (data volume: open-webui)"
}
else {
    $venv = Join-Path $AppDir 'venv'
    $data = Join-Path $AppDir 'data'
    $log  = Join-Path $AppDir 'openwebui.log'
    New-Item -ItemType Directory -Force -Path $data | Out-Null
    $vpy = Join-Path $venv 'Scripts\python.exe'
    if (-not (Test-Path $vpy)) {
        Info "Creating a private Python environment in $venv ..."
        & $pyExe @pyArgs -m venv $venv
        if (-not (Test-Path $vpy)) { Fail "Could not create the Python environment." }
    }
    Info "Installing/updating Open WebUI with pip (5-10 minutes the first time)..."
    & $vpy -m pip install --upgrade pip *> $null
    & $vpy -m pip install --upgrade open-webui
    if ($LASTEXITCODE -ne 0) { Fail "pip install open-webui failed. See the message above." }

    # Launcher with persistent settings. Single quotes are doubled so paths with ' still work.
    $q = { param($s) "'" + ($s -replace "'", "''") + "'" }
    $launcher = Join-Path $AppDir 'Start-OpenWebUI.ps1'
    @(
        "`$env:DATA_DIR         = $(& $q $data)"
        "`$env:OLLAMA_BASE_URL  = '$OllamaUrl'"
        "`$env:WEBUI_SECRET_KEY = (Get-Content $(& $q $SecretFile) -Raw).Trim()"
        "& $(& $q (Join-Path $venv 'Scripts\open-webui.exe')) serve --host 0.0.0.0 --port $Port *>> $(& $q $log)"
    ) | Set-Content -Path $launcher -Encoding ASCII

    # Start hidden at every logon.
    $action   = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launcher`""
    $trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
    try {
        Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Force -ErrorAction Stop | Out-Null
        Start-ScheduledTask -TaskName $TaskName
        Ok "Installed as scheduled task '$TaskName' (starts by itself when you log in)"
    } catch {
        Warn "Could not register the auto-start task ($($_.Exception.Message)). Starting it for this session only."
        Start-Process powershell.exe -ArgumentList "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launcher`""
    }
}
Set-Content -Path $PortFile -Value $Port -Encoding ASCII

# ---------------------------------------------------------------------------
Step "4/6  Waiting for Open WebUI to start"
# ---------------------------------------------------------------------------
$healthy = $false
for ($i = 0; $i -lt 60; $i++) {          # up to 5 minutes: the first start downloads extra files
    if (Test-Url "http://127.0.0.1:$Port/health") { $healthy = $true; break }
    Start-Sleep -Seconds 5
}
if ($healthy) { Ok "Open WebUI is answering on port $Port" }
else {
    Warn "Open WebUI is not answering yet (the first start can take several minutes)."
    if ($useDocker) { Info "Watch progress with:  docker logs -f $ContainerName" } else { Info "Watch progress in:  $AppDir\openwebui.log" }
}

if ($useDocker) {
    # Python is always inside the image (curl may not be).
    $probe = "import urllib.request; urllib.request.urlopen('http://host.docker.internal:11434/api/version', timeout=5)"
    & $docker exec $ContainerName python -c $probe *> $null
    if ($LASTEXITCODE -eq 0) { Ok "Open WebUI can reach Ollama on Windows" }
    else {
        Warn "The container cannot reach Ollama at host.docker.internal:11434, so local models will not show."
        Info "Fix: run this setup again with  -AllowDockerToOllama"
    }
}

# ---------------------------------------------------------------------------
Step "5/6  Network access over Tailscale"
# ---------------------------------------------------------------------------
if ($isAdmin) {
    Get-NetFirewallRule -DisplayName $FirewallRule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule -DisplayName $FirewallRule -Direction Inbound -Action Allow -Protocol TCP `
        -LocalPort $Port -RemoteAddress $TailscaleCidr -Profile Any | Out-Null
    Ok "Firewall: port $Port allowed ONLY from Tailscale devices ($TailscaleCidr)"
} else {
    Warn "Skipped the firewall rule (needs Administrator)."
}

$tsExe = Find-Exe 'tailscale' @("$env:ProgramFiles\Tailscale\tailscale.exe")
$tsIp = $null
if ($tsExe) {
    $tsIp = (& $tsExe ip -4 2>$null | Select-Object -First 1)
    if ($tsIp) { $tsIp = "$tsIp".Trim(); Ok "Tailscale is connected. This laptop's Tailscale IP: $tsIp" }
    else { Warn "Tailscale is installed but not connected. Open Tailscale and sign in." }
} else {
    Warn "Tailscale not found. Install it with:  winget install tailscale.tailscale"
}

# ---------------------------------------------------------------------------
Step "6/6  Done"
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "  On this laptop   :  http://localhost:$Port" -ForegroundColor Green
if ($tsIp) { Write-Host "  From your phone  :  http://${tsIp}:$Port   (Tailscale must be on)" -ForegroundColor Green }
else       { Write-Host "  From your phone  :  http://<Tailscale-IP>:$Port   (Tailscale must be on)" -ForegroundColor Green }
Write-Host ""
Write-Host "  IMPORTANT: the FIRST account you create becomes the administrator. Create it now." -ForegroundColor Yellow
Write-Host "  Then: Admin Panel > Settings > General > turn OFF 'Enable New Sign Ups'."
Write-Host "  Cloud API keys go in: Admin Panel > Settings > Connections (see README.md)."
Write-Host "  To check the GPU later:  .\Check-GPU.ps1"
Write-Host ""
Start-Process "http://localhost:$Port"
