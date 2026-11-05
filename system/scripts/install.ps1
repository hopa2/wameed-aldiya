# ============================================================
# تثبيت منظومة وميض الضياء (لوحة التحكم + الوكلاء) على اللابتوب
# يفترض وجود C:\wameed\docker-compose.yml (n8n + postgres) من تثبيت وكيل الإعلانات.
#
# الاستخدام (PowerShell عادي، لا يحتاج صلاحية مسؤول):
#   cd C:\wameed
#   git clone https://github.com/hopa2/wameed-aldiya.git     (أول مرة فقط؛ بعدها: git -C wameed-aldiya pull)
#   powershell -ExecutionPolicy Bypass -File .\wameed-aldiya\system\scripts\install.ps1
#
# آمن للتكرار: لا يكتب فوق أسرارك ولا إعداداتك، ويحدّث الـ workflows فقط.
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
if (-not (Test-Path $envFile)) { Fail 'لا يوجد C:\wameed\.env (فيه PG_PASSWORD وN8N_ENCRYPTION_KEY).' }
$envText = Get-Content $envFile -Raw
if ($envText -notmatch '(?m)^PG_PASSWORD=.+') { Fail 'PG_PASSWORD غير موجود في .env' }
$add = @()
if ($envText -notmatch '(?m)^COMPOSE_FILE=') { $add += 'COMPOSE_FILE=docker-compose.yml;wameed-aldiya/system/docker-compose.wameed.yml' }
if ($envText -notmatch '(?m)^WAMEED_HOOK_TOKEN=.+') { $add += "WAMEED_HOOK_TOKEN=$(NewSecret 40)" }
$newPass = $null
if ($envText -notmatch '(?m)^DASHBOARD_PASSWORD=.+') { $newPass = NewSecret 14; $add += "DASHBOARD_PASSWORD=$newPass" }
if ($envText -notmatch '(?m)^TELEGRAM_BOT_TOKEN=') { $add += 'TELEGRAM_BOT_TOKEN=' }
if ($envText -notmatch '(?m)^WAHA_API_KEY=') { $add += 'WAHA_API_KEY=' }
if ($add.Count) { Add-Content -Path $envFile -Value ("`n# wameed system`n" + ($add -join "`n")) -Encoding UTF8 }
if ((Get-Content $envFile -Raw) -match '(?m)^TELEGRAM_BOT_TOKEN=\s*$') {
  Write-Host '⚠ TELEGRAM_BOT_TOKEN فارغ في .env: الإشعارات لن تصل حتى تضعه (افتح .env بالمفكرة، ولا تلصقه في أي محادثة).' -ForegroundColor Yellow
}

Say 'تشغيل الخدمات (أول مرة تبني صورة لوحة التحكم، دقيقة أو اثنتان)'
docker compose up -d --build
if ($LASTEXITCODE -ne 0) { Fail 'فشل docker compose up' }

Say 'تطبيق مخطط قاعدة البيانات'
$ok = $false
for ($i = 0; $i -lt 60; $i++) {
  $logs = docker compose logs wameed-migrate 2>&1 | Out-String
  if ($logs -match 'wameed schema OK') { $ok = $true; break }
  if ($logs -match 'ERROR') { Write-Host $logs; Fail 'فشل تطبيق المخطط (التفاصيل أعلاه)' }
  Start-Sleep -Seconds 2
}
if (-not $ok) { Fail 'لم يكتمل تطبيق المخطط خلال دقيقتين: docker compose logs wameed-migrate' }

Say 'استيراد الـ workflows والـ Credentials إلى n8n'
docker compose exec -T n8n sh /wameed/n8n/import.sh
if ($LASTEXITCODE -ne 0) { Fail 'فشل الاستيراد إلى n8n' }
docker compose restart n8n | Out-Null

Say 'فحص لوحة التحكم'
Start-Sleep -Seconds 8
try { Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8080/healthz | Out-Null; Write-Host '✔ لوحة التحكم تعمل: http://127.0.0.1:8080' -ForegroundColor Green }
catch { Write-Host '⚠ اللوحة لم ترد بعد: docker compose logs wameed-dashboard' -ForegroundColor Yellow }

if ($newPass) { Write-Host "`n🔑 كلمة سر لوحة التحكم (محفوظة أيضًا في C:\wameed\.env): $newPass" -ForegroundColor Green }
Write-Host @'

الخطوات التالية (مرة واحدة):
 1) افتح http://127.0.0.1:8080 ← الإعدادات: ضع owner_chat_id و waha_url، واضغط حفظ لكل واحد.
 2) للجوال: tailscale serve --bg --https=8443 http://127.0.0.1:8080
    ثم ضع الرابط https://<اسم-اللابتوب>.<tailnet>.ts.net:8443/ في dashboard_url.
 3) أضف مورديك المعتمدين من الإعدادات ← الموردون.
'@
