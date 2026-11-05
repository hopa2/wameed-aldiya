# لوحة تحكم وميض الضياء: طبقة فوق منظومتك الحالية

اللوحة **لا تضيف وكلاء ولا بوابة جديدة**. تعرض ما يعمل أصلًا على اللابتوب وتتحكم به من مكان واحد، على الجوال والكمبيوتر، بلا أي خدمة مدفوعة.

| ما تقرؤه أو تكتبه | أين | كيف |
|---|---|---|
| طلبات الموافقة والحواجز والإيقاف والسجل | `biz_approvals`, `biz_guardrails`, `biz_state`, `biz_audit_log`, `biz_manager_snapshots` في قاعدة `wameed_ads` | بنفس استعلامات SYS - Approval Gate حرفيًا |
| وكيل الإعلانات | `ads_runs`, `ads_actions`, `ads_state` في `wameed_ads` | قراءة، وإيقاف/استئناف (`system_paused`) فقط |
| كل الـ workflows (SYS/BIZ/ADS/GBP/JOB/ME) | `workflow_entity`, `execution_entity` في قاعدة `n8n` | قراءة فقط: مفعّل؟ آخر تشغيل؟ كم فشل؟ |
| صحة الأجهزة | n8n، Ollama، WAHA (`http://waha:3000`)، Manager.io على جهاز المحل (`100.95.125.96:55668`) | فحص حي كل 20 ثانية |

```
 الجوال/الكمبيوتر ─(Tailscale)─► اللوحة :8080 ─┬─ قراءة ─► wameed_ads (biz_* + ads_*) و n8n (حالة الـ workflows)
                                               ├─ رفض / إيقاف / حواجز ─► نفس الجداول، بنفس صيغة /stop و Save Decision
                                               └─ موافقة ─► webhook «SYS - Dashboard Approve» ─► SYS - Approval Gate (كما هي)
                                                                                                  ├─ نفس الحواجز (السقف، المهلة، الإيقاف)
                                                                                                  ├─ نفس التنفيذ في Manager.io
                                                                                                  └─ نفس رسالة التأكيد في تيليجرام
```

## لماذا الموافقة تمر عبر البوابة نفسها؟

اللوحة لا تنفّذ أي شيء في Manager.io. زر «موافقة» يرسل إلى workflow صغير اسمه **SYS - Dashboard Approve** (في `n8n/60-dashboard-approve/`)، وهو يصنع ضغطة زر مكافئة لـ `apv:<id>:y` من حسابك ويمررها إلى **SYS - Approval Gate**. فتبقى قاعدة واحدة تقرر: البوابة تعيد فحص الحالة والمهلة والإيقاف وسقف الأمر الواحد والسقف اليومي، ثم تنفّذ أو تحجب، وترسل لك النتيجة في تيليجرام. لو ضغطت الزر في تيليجرام بعدها، تقول البوابة «سبق التعامل معه».

الـ webhook محمي بسر `WAMEED_DASH_TOKEN` (40 حرفًا في `.env`)، وn8n لا يُفتح للإنترنت (`WEBHOOK_URL` محلي ولا Funnel).

الرفض والإيقاف يكتبان مباشرة بنفس استعلامات البوابة وأمر `/stop`، ويُسجلان في `biz_audit_log` بـ `via: dashboard`.

## ما لا تفعله اللوحة (عمدًا)

- لا تفعّل ولا تعدّل workflows: هذا من n8n أو من `deploy_workflows.py` حتى لا يتعارضا.
- لا تلمس وكيل الإعلانات إلا مفتاح الإيقاف. أوامره الكاملة تبقى في بوته.
- لا تعرض أي سر، ولا ترسل مفتاح Manager.io (فحصه مجرد «هل يرد الجهاز؟»).

## التثبيت (مرة واحدة، حوالي 5 دقائق)

```powershell
cd C:\wameed
git -C wameed-aldiya pull            # أو أول مرة: git clone https://github.com/hopa2/wameed-aldiya.git
powershell -ExecutionPolicy Bypass -File .\wameed-aldiya\system\scripts\install.ps1
```

السكربت:
1. يضيف إلى `.env` ما ينقص فقط: `COMPOSE_FILE` و`DASHBOARD_PASSWORD` و`WAMEED_DASH_TOKEN` (يُولّدان عشوائيًا، ولا يكتب فوق شيء موجود).
2. `docker compose up -d --build`: يبني اللوحة، ويعيد تشغيل n8n مرة واحدة ليقرأ `WAMEED_DASH_TOKEN` (ثوانٍ).
3. ينسخ `SYS - Dashboard Approve` إلى `workflows-src\60-dashboard-approve` وينشره بأداتك `deploy_workflows.py`.
4. يفحص اللوحة ويطبع كلمة السر مرة واحدة.

للجوال: `tailscale serve --bg --https=8443 http://127.0.0.1:8080` ثم افتح `https://<اسم-اللابتوب>.<tailnet>.ts.net:8443/`.

## الإزالة

احذف سطر `COMPOSE_FILE` من `.env`، ثم `docker compose up -d --remove-orphans`، واحذف (أو عطّل) `SYS - Dashboard Approve` من n8n. لا شيء آخر تغيّر.

## الملفات

- `dashboard/server.js`: خادم Node بلا إطار (مكتبة `pg` فقط). دخول بكلمة سر وكوكي موقّع، ورأس `x-requested-with` ضد CSRF، وحد 5 محاولات خاطئة كل 10 دقائق.
- `dashboard/public/`: الواجهة العربية (RTL، وضع داكن، تعمل كتطبيق على الجوال).
- `n8n/60-dashboard-approve/`: الـ workflow الوحيد المضاف، بصيغة `workflows-src` نفسها.
- `docker-compose.wameed.yml`: يضيف خدمة اللوحة ومتغيرًا واحدًا لـ n8n.
