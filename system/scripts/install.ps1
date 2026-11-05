# ============================================================
# تثبيت لوحة تحكم وميض الضياء فوق المنظومة الموجودة على اللابتوب
# يفترض وجود C:\wameed\docker-compose.yml (postgres + n8n + waha) وأداة scripts\deploy_workflows.py.
#
# الاستخدام (PowerShell عادي، لا يحتاج صلاحية مسؤول):
#   cd C:\wameed
#   git clone https://github.com/hopa2/wameed-aldiya.git     (أول مرة فقط؛ بعدها: git -C wameed-aldiya pull)
#   powershell -ExecutionPolicy Bypass -File .\wameed-aldiya\system\scripts\install.ps1
#
# آمن للتكرار: لا يكتب فوق أسرارك، ولا يغيّر أي workflow موجود.
# ============================================================
$ErrorActionPreference = 'Continue'   # نفحص $LASTEXITCODE بأنفسنا (stderr من docker ليس خطأ)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$Root = 'C:\wameed'
Set-Location $Root

function Say($msg) { Write-Host "`n▶ $msg" -ForegroundColor Cyan }
function Fail($msg) { Write-Host "✖ $msg" -ForegroundColor Red; exit 1 }
function NewSecret($n) { -join ((48..57) + (65..90) + (97..122) | Get-Random -Count $n | ForEach-Object { [char]$_ }) }

Say 'فحص المتطلبات'
if (-not (Test-Path "$Root\docker-compose.yml")) { Fail 'لا يوجد C:\wameed\docker-compose.yml. ثبّت n8n وpostgres أولًا (أمر تثبيت وكيل الإعلانات، المرحلة 4).' }
if (-not (Test-Path "$Root\wameed-aldiya\system\docker-compose.wameed.yml")) { Fail 'المستودع غير موجود في C:\wameed\wameed-aldiya' }
docker info *> $null; if ($LASTEXITCODE -ne 0) { Fail 'Docker Desktop لا يعمل. شغّله ثم أعد المحاولة.' }
$base = Get-Content "$Root\docker-compose.yml" -Raw
if ($base -notmatch '(?m)^\s{2}postgres:' -or $base -notmatch '(?m)^\s{2}n8n:') { Fail 'docker-compose.yml لا يحتوي خدمتي postgres وn8n بهذين الاسمين.' }

Say 'تجهيز .env (الأسرار تُولد مرة واحدة ولا تُعرض)'
$envFile = "$Root\.env"
if (-not (Test-Path $envFile)) { Fail 'لا يوجد C:\wameed\.env' }
$envText = Get-Content $envFile -Raw
if ($envText -notmatch '(?m)^PG_PASSWORD=.+') { Fail 'PG_PASSWORD غير موجود في .env' }
if ($envText -match '(?m)^COMPOSE_FILE=' -and $envText -notmatch 'docker-compose\.wameed\.yml') { Fail 'يوجد COMPOSE_FILE آخر في .env. أضف إليه ;wameed-aldiya/system/docker-compose.wameed.yml يدويًا ثم أعد التشغيل.' }
$add = @()
if ($envText -notmatch '(?m)^COMPOSE_FILE=') { $add += 'COMPOSE_FILE=docker-compose.yml;wameed-aldiya/system/docker-compose.wameed.yml' }
if ($envText -notmatch '(?m)^WAMEED_DASH_TOKEN=.{20,}') { $add += "WAMEED_DASH_TOKEN=$(NewSecret 40)" }
$newPass = $null
if ($envText -notmatch '(?m)^DASHBOARD_PASSWORD=.+') { $newPass = NewSecret 14; $add += "DASHBOARD_PASSWORD=$newPass" }
if ($add.Count) { Add-Content -Path $envFile -Value ("`n# wameed dashboard`n" + ($add -join "`n")) -Encoding UTF8 }

Say 'تشغيل اللوحة (أول مرة تُبنى الصورة في دقيقة أو اثنتين، وn8n يُعاد تشغيله مرة واحدة)'
docker compose up -d --build
if ($LASTEXITCODE -ne 0) { Fail 'فشل docker compose up' }

Say 'نشر SYS - Dashboard Approve بأداة النشر الموجودة'
$src = "$Root\wameed-aldiya\system\n8n\60-dashboard-approve"
$dst = "$Root\workflows-src\60-dashboard-approve"
if (-not (Test-Path "$Root\scripts\deploy_workflows.py")) { Fail 'لا يوجد C:\wameed\scripts\deploy_workflows.py' }
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item "$src\*" $dst -Force
$ok = $false
for ($i = 0; $i -lt 30; $i++) {   # ننتظر n8n بعد إعادة التشغيل
  try { Invoke-WebRequest -UseBasicParsing http://localhost:5678/healthz -TimeoutSec 3 | Out-Null; $ok = $true; break } catch { Start-Sleep -Seconds 2 }
}
if (-not $ok) { Fail 'n8n لم يرد خلال دقيقة: docker compose logs n8n' }
python -I "$Root\scripts\deploy_workflows.py" 60-dashboard-approve
if ($LASTEXITCODE -ne 0) { Fail 'فشل نشر SYS - Dashboard Approve (اللوحة تعمل، لكن الموافقة ستبقى من تيليجرام)' }

Say 'فحص لوحة التحكم'
Start-Sleep -Seconds 3
try { Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8080/healthz | Out-Null; Write-Host '✔ لوحة التحكم تعمل: http://127.0.0.1:8080' -ForegroundColor Green }
catch { Write-Host '⚠ اللوحة لم ترد بعد: docker compose logs wameed-dashboard' -ForegroundColor Yellow }

if ($newPass) { Write-Host "`n🔑 كلمة سر لوحة التحكم (محفوظة أيضًا في C:\wameed\.env): $newPass" -ForegroundColor Green }
Write-Host @'

للجوال (مرة واحدة):
  tailscale serve --bg --https=8443 http://127.0.0.1:8080
  ثم افتح https://<اسم-اللابتوب>.<tailnet>.ts.net:8443/
'@
