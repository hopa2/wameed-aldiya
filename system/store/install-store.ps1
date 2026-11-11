# تثبيت وكيل المتجر (سلة) على اللابتوب. شغّله من PowerShell:
#   powershell -ExecutionPolicy Bypass -File C:\wameed\store\install-store.ps1
# آمن لإعادة التشغيل: يسأل فقط عن القيم الناقصة.
$ErrorActionPreference = 'Stop'
Set-Location C:\wameed
$envPath = 'C:\wameed\.env'
$envText = Get-Content $envPath -Raw -Encoding UTF8

function Has($k) { return $envText -match "(?m)^$k=.+" }
$add = @()

# 1) ربط ملف المتجر بـ COMPOSE_FILE
if ($envText -match '(?m)^COMPOSE_FILE=(.*)$') {
  if ($Matches[1] -notmatch 'docker-compose\.store\.yml') {
    $envText = $envText -replace '(?m)^(COMPOSE_FILE=.*?)\s*$', '$1;store/docker-compose.store.yml'
  }
} else { $add += 'COMPOSE_FILE=docker-compose.yml;store/docker-compose.store.yml' }

# 2) بيانات تطبيق سلة ورقم جوال الموظف
if (-not (Has 'SALLA_CLIENT_ID')) { $v = Read-Host 'Client ID من بوابة شركاء سلة (اتركه فارغًا إن لم يجهز بعد)'; if ($v) { $add += "SALLA_CLIENT_ID=$v" } }
if (-not (Has 'SALLA_CLIENT_SECRET')) { $v = Read-Host 'Client Secret من بوابة شركاء سلة (اتركه فارغًا إن لم يجهز بعد)'; if ($v) { $add += "SALLA_CLIENT_SECRET=$v" } }
if (-not (Has 'SALLA_OAUTH_STATE')) { $st = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ }); $add += "SALLA_OAUTH_STATE=$st" }
if (-not (Has 'STORE_EMPLOYEE_WA')) { $v = Read-Host 'رقم واتساب الموظف بصيغة 9665xxxxxxxx'; if ($v) { $add += "STORE_EMPLOYEE_WA=$v" } }

if ($add.Count) { $envText = $envText.TrimEnd() + "`r`n# store agent (salla)`r`n" + ($add -join "`r`n") + "`r`n" }
[IO.File]::WriteAllText($envPath, $envText, (New-Object Text.UTF8Encoding $false))
Write-Host 'تم تحديث .env' -ForegroundColor Green

# 3) بناء خدمة الصور وإعادة تشغيل n8n بالمتغيرات الجديدة
docker compose up -d --build imgproc
docker compose up -d n8n
Start-Sleep -Seconds 8
try { $h = Invoke-RestMethod http://127.0.0.1:7000/health; Write-Host "خدمة الصور تعمل: $($h | ConvertTo-Json -Compress)" -ForegroundColor Green } catch { Write-Host 'خدمة الصور لم ترد بعد، انتظر دقيقة ثم افتح http://127.0.0.1:7000/health' -ForegroundColor Yellow }

# 4) نموذج الرؤية المحلي المجاني لقراءة صور المنتجات
ollama pull qwen2.5vl:7b

Write-Host ''
Write-Host 'التالي: افتح هذا الرابط على اللابتوب لربط سلة:' -ForegroundColor Cyan
Write-Host 'http://localhost:5678/webhook/salla-connect' -ForegroundColor Cyan
