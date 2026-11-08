<#
.SYNOPSIS
    Shows whether Ollama runs your local models on the RTX 4060.

.DESCRIPTION
    Loads a model with a short test question (or uses the one you just chatted
    with), then shows where Ollama put it (GPU or CPU) and the GPU's memory use.

.PARAMETER Model
    Model to test. Default: the first one already loaded, otherwise qwen2.5:7b.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Check-GPU.ps1
    powershell -ExecutionPolicy Bypass -File .\Check-GPU.ps1 -Model llama3.1:8b
#>
param([string]$Model)

$ErrorActionPreference = 'Continue'
$ProgressPreference    = 'SilentlyContinue'
$OllamaUrl = 'http://127.0.0.1:11434'

$ollama = (Get-Command ollama -ErrorAction SilentlyContinue).Source
if (-not $ollama) { $ollama = "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe" }
$smi = (Get-Command nvidia-smi -ErrorAction SilentlyContinue).Source
if (-not $smi) { $smi = "$env:SystemRoot\System32\nvidia-smi.exe" }

try { $null = Invoke-RestMethod "$OllamaUrl/api/version" -TimeoutSec 5 -ErrorAction Stop }
catch { Write-Host "Ollama is not running. Open Ollama from the Start menu and try again." -ForegroundColor Red; exit 1 }

if (-not $Model) {
    $loaded = @((Invoke-RestMethod "$OllamaUrl/api/ps").models)
    $Model  = if ($loaded.Count -gt 0) { $loaded[0].name } else { 'qwen2.5:7b' }
}

Write-Host "`nTesting $Model with a short question (the first load takes 5-30 seconds)..." -ForegroundColor Cyan
$body = @{ model = $Model; prompt = 'Say OK.'; stream = $false; keep_alive = '5m' } | ConvertTo-Json
try {
    $r = Invoke-RestMethod "$OllamaUrl/api/generate" -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 300 -ErrorAction Stop
    if ($r.eval_duration -gt 0) {
        $tps = [math]::Round($r.eval_count / ($r.eval_duration / 1e9), 1)
        Write-Host "Speed: $tps tokens/second  (a 7B/8B model fully on the RTX 4060 usually gives 30+; under 10 means CPU)"
    }
} catch {
    Write-Host "Could not run $Model. Is it downloaded? Try:  ollama pull $Model" -ForegroundColor Red
    exit 1
}

Write-Host "`n--- Models loaded by Ollama ---" -ForegroundColor Cyan
& $ollama ps
Write-Host "PROCESSOR column:"
Write-Host "  100% GPU         = fully on the RTX 4060 (best)." -ForegroundColor Green
Write-Host "  xx%/yy% CPU/GPU  = too big for 8 GB VRAM, partly on the CPU (slower). Use a smaller model." -ForegroundColor Yellow
Write-Host "  100% CPU         = GPU not used. Update the NVIDIA driver, then quit and reopen Ollama." -ForegroundColor Red

if (Test-Path $smi) {
    Write-Host "`n--- NVIDIA GPU status ---" -ForegroundColor Cyan
    & $smi --query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv
    Write-Host "`nProgrammes using the GPU (look for ollama):"
    & $smi --query-compute-apps=process_name,used_memory --format=csv
} else {
    Write-Host "`nnvidia-smi not found: install the latest NVIDIA driver." -ForegroundColor Red
}
Write-Host ""
