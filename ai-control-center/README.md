<div dir="rtl">

# مركز التحكم بالذكاء الاصطناعي (Open WebUI) على ويندوز 11

صفحة ويب واحدة تكلّم منها:

- **نماذج محلية** تعمل على كرت الشاشة RTX 4060 بدون إنترنت وبدون تكلفة (مثل Qwen 2.5 7B وLlama 3.1 8B).
- **نماذج سحابية** مثل Claude وGPT، ومعها أي نموذج على OpenRouter.

وتفتحها من الجوال من أي مكان عبر Tailscale.

الجهاز المستهدف: Windows 11 Pro، معالج i7-13650HX، ذاكرة 32GB، كرت RTX 4060 بذاكرة 8GB.

## كيف تعمل المنظومة

</div>

```
الجوال / التابلت ──Tailscale──┐
                              ▼
المتصفح ──► Open WebUI (المنفذ 8080) ──► Ollama على ويندوز (المنفذ 11434) ──► RTX 4060
                              └────────► OpenRouter / OpenAI / Anthropic (عبر الإنترنت)
```

<div dir="rtl">

- **Ollama** يعمل مباشرة على ويندوز، فيستخدم كرت الشاشة بنفسه.
- **Open WebUI** هو الصفحة فقط، ولا يحتاج كرت الشاشة.

## الملفات في هذا المجلد

| الملف | وظيفته |
|---|---|
| `Setup-OpenWebUI.cmd` | **هذا الذي تضغطه.** يطلب صلاحية المسؤول ثم يشغّل سكربت التثبيت. |
| `Setup-OpenWebUI.ps1` | سكربت التثبيت نفسه: يفحص الجهاز، يثبّت، يربط، يفتح الصفحة. |
| `Check-GPU.ps1` | يتأكد أن النموذج المحلي يعمل على كرت الشاشة وليس على المعالج. |

---

## الخطوة 1: ثبّت البرامج المطلوبة (مرة واحدة)

افتح **Terminal** (اضغط زر ويندوز واكتب Terminal)، والصق كل سطر وحده واضغط Enter:

| البرنامج | الأمر | هل هو ضروري؟ |
|---|---|---|
| تعريف NVIDIA | من تطبيق NVIDIA أو من nvidia.com/drivers | نعم، ويُفضّل أحدث إصدار |
| Ollama | `winget install Ollama.Ollama` | نعم |
| Docker Desktop | `winget install Docker.DockerDesktop` | مُوصى به (أعد تشغيل الجهاز بعده وافتحه مرة) |
| Python 3.11 | `winget install Python.Python.3.11` | فقط إذا لم تثبّت Docker |
| Tailscale | `winget install tailscale.tailscale` | للدخول من الجوال (سجّل الدخول بعده) |

> في Docker Desktop: افتح **Settings → General** وتأكد أن خيار **Start Docker Desktop when you sign in** مُفعّل، حتى تعمل الصفحة تلقائيًا بعد إعادة التشغيل.

## الخطوة 2: انسخ المجلد إلى اللابتوب

انسخ مجلد `ai-control-center` كاملًا إلى مكان ثابت، مثلًا `C:\AI\ai-control-center`.

## الخطوة 3: شغّل التثبيت

**الطريقة الموصى بها في أول مرة** (تنزّل النماذج المحلية وتضبط Ollama لكرت 8GB):

1. افتح المجلد في مستكشف الملفات.
2. اضغط في شريط العنوان واكتب `cmd` ثم Enter.
3. الصق هذا الأمر واضغط Enter:

</div>

```bat
Setup-OpenWebUI.cmd -PullModels -OptimizeOllama
```

<div dir="rtl">

4. اضغط **Yes / نعم** عندما يطلب ويندوز الصلاحية.

**أو ببساطة:** اضغط مرتين على `Setup-OpenWebUI.cmd` (بدون تنزيل نماذج).

التنزيل الأول يأخذ وقتًا (حوالي 10GB للنموذجين، و2-4GB لـ Open WebUI). النافذة تبقى مفتوحة في النهاية لتقرأ النتيجة.

### ماذا يفعل السكربت بالترتيب (6 مراحل)

1. **يفحص الجهاز:** كرت NVIDIA وحجم ذاكرته، Docker، Python، Ollama. يشغّل Docker وOllama إن كانا مغلقين، وينبّهك إن كان اللابتوب على البطارية.
2. **النماذج المحلية:** ينزّل النماذج (مع `-PullModels`)، ثم يعرض كل نموذج مثبّت ويقول هل يتسع في ذاكرة كرت الشاشة أم لا.
3. **ينشر Open WebUI:** داخل Docker (أو بـ Python إن لم يوجد Docker)، مربوطًا بـ Ollama.
4. **ينتظر** حتى تعمل الصفحة، ويتأكد أنها ترى Ollama.
5. **الشبكة:** يجعل الصفحة تستمع على كل الواجهات (`0.0.0.0`)، ويضيف قاعدة جدار حماية تسمح **فقط** لأجهزة Tailscale (`100.64.0.0/10`). جيرانك على نفس الواي فاي لا يستطيعون الدخول.
6. **يطبع الروابط** ويفتح الصفحة في المتصفح.

### أين تُحفظ بياناتك

- مع Docker: في وحدة تخزين اسمها `open-webui`.
- مع Python: في المجلد `%LOCALAPPDATA%\OpenWebUI\data`.

التحديث وإعادة التشغيل **لا يحذفان** المحادثات ولا الإعدادات.

### التشغيل التلقائي بعد إعادة تشغيل الجهاز

- Ollama يبدأ تلقائيًا عند تسجيل الدخول (هذا من إعداده الافتراضي).
- مع Docker: الحاوية مضبوطة على `--restart always`، فتعمل بمجرد أن يبدأ Docker Desktop.
- مع Python: السكربت يضيف مهمة مجدولة اسمها `OpenWebUI` تبدأ عند تسجيل الدخول.

---

## الخطوة 4: افتح الصفحة

- على اللابتوب: **http://localhost:8080**
- من الجوال أو أي جهاز عليه Tailscale: **http://&lt;Tailscale-IP&gt;:8080**

السكربت يطبع عنوان Tailscale (يبدأ بـ `100.`). يمكنك معرفته أيضًا بالأمر `tailscale ip -4` أو من أيقونة Tailscale.

إذا كان المنفذ 8080 مشغولًا ببرنامج آخر، ينتقل السكربت إلى **3000**. استخدم المنفذ الذي يطبعه. وعند تشغيل السكربت مرة أخرى يبقى على نفس المنفذ.

## الخطوة 5: أول دخول (افعلها فورًا)

1. اضغط **Sign up** وأنشئ حسابك. **أول حساب يُنشأ يصبح هو المسؤول (Admin).**
2. ادخل **Admin Panel → Settings → General** وأطفئ **Enable New Sign Ups**، حتى لا يستطيع أحد غيرك إنشاء حساب.

## الخطوة 6: أضف مفاتيح النماذج السحابية (Claude وGPT وOpenRouter)

المفاتيح تُدخل **داخل الصفحة** وليس في أي ملف. السكربت لا يحفظ أي مفتاح.

اذهب إلى: **أيقونة حسابك (أسفل اليسار) → Admin Panel → Settings → Connections**.
تحت **OpenAI API** اضغط **+** (Add Connection) مرة لكل مزوّد:

| المزوّد | الرابط الذي تكتبه | من أين تأخذ المفتاح |
|---|---|---|
| **OpenRouter** (الأسهل: Claude وGPT وGemini وغيرها بمفتاح واحد) | `https://openrouter.ai/api/v1` | openrouter.ai → Keys |
| **OpenAI** (GPT) | `https://api.openai.com/v1` | platform.openai.com → API keys |
| **Anthropic** (Claude مباشرة) | `https://api.anthropic.com/v1` | console.anthropic.com → API Keys |

الصق المفتاح، اضغط أيقونة **التحقق / التحديث** لتجربته، ثم **Save**.

- مع Anthropic المباشر: إذا لم تظهر النماذج، اكتب أسماءها في خانة **Model IDs**، مثلًا `claude-sonnet-5-5` و`claude-opus-5-5` و`claude-haiku-5-5`.
- إذا كانت قائمة النماذج طويلة، أخفِ ما لا تحتاجه من **Admin Panel → Settings → Models**.
- في نفس الصفحة، اتصال **Ollama API** يجب أن يظهر بعلامة خضراء على `http://host.docker.internal:11434` (مع Docker) أو `http://127.0.0.1:11434` (مع Python).

**التبديل بين النماذج:** في أي محادثة اضغط اسم النموذج أعلى اليسار واختر نموذجًا محليًا (`qwen2.5:7b`) أو سحابيًا (`anthropic/claude-...` أو `gpt-...`). يمكنك التبديل في منتصف المحادثة.

---

## اختيار النماذج المحلية لكرت 8GB

القاعدة: النموذج يعمل كاملًا على كرت الشاشة إذا كان حجمه أقل من **حوالي 6.5GB** (يبقى الباقي للمحادثة نفسها). السكربت يتحقق من هذا تلقائيًا في المرحلة 2.

| النموذج | الحجم تقريبًا | على RTX 4060 8GB | مناسب لـ |
|---|---|---|---|
| `qwen2.5:7b` | 4.7GB | ✅ كامل على الكرت | العربية والاستخدام العام (**الافتراضي**) |
| `llama3.1:8b` | 4.9GB | ✅ كامل على الكرت | الإنجليزية والاستخدام العام (**الافتراضي**) |
| `qwen2.5-coder:7b` | 4.7GB | ✅ كامل على الكرت | البرمجة |
| `qwen2.5:3b` | 1.9GB | ✅ سريع جدًا | المهام الخفيفة |
| `qwen2.5:14b` | 9.0GB | ⚠️ جزء على المعالج (بطيء) | لا يُنصح به |

لتنزيل نماذج أخرى بدل الافتراضية:

</div>

```bat
Setup-OpenWebUI.cmd -PullModels -Models qwen2.5:7b,qwen2.5-coder:7b
```

<div dir="rtl">

أو مباشرة: `ollama pull qwen2.5-coder:7b`، والنموذج يظهر في الصفحة خلال ثوانٍ.

**خيار `-OptimizeOllama`** يضبط Ollama ليوفّر من ذاكرة الكرت (`OLLAMA_FLASH_ATTENTION=1` و`OLLAMA_KV_CACHE_TYPE=q8_0`)، فتبقى المحادثات الطويلة على الكرت. يكفي تشغيله مرة واحدة.

---

## هل كرت RTX 4060 يعمل فعلًا؟

شغّل في Terminal داخل المجلد:

</div>

```powershell
powershell -ExecutionPolicy Bypass -File .\Check-GPU.ps1
```

<div dir="rtl">

السكربت يسأل النموذج سؤالًا قصيرًا ثم يعرض:

- **السرعة:** نموذج 7B/8B كامل على الكرت يعطي عادة 30 كلمة/ثانية (tokens) أو أكثر. أقل من 10 يعني أنه يعمل على المعالج.
- **عمود PROCESSOR:**
  - `100% GPU` = يعمل كاملًا على الكرت (الأفضل).
  - `40%/60% CPU/GPU` = النموذج أكبر من 8GB وجزء منه على المعالج. استخدم نموذجًا أصغر.
  - `100% CPU` = الكرت لا يُستخدم. حدّث تعريف NVIDIA ثم أغلق Ollama وافتحه من جديد.
- **قائمة البرامج على الكرت:** يجب أن يظهر فيها `ollama`.

**طريقة مرئية:** افتح **Task Manager → Performance → GPU 1 (NVIDIA GeForce RTX 4060)**. عند تحميل نموذج 7B يرتفع **Dedicated GPU memory** بحوالي 5GB، والرسم يرتفع أثناء الإجابة.

اترك اللابتوب **موصولًا بالشاحن**، لأن الكرت أبطأ بكثير على البطارية.

---

## أوامر الاستخدام اليومي

| المهمة | الأمر |
|---|---|
| تحديث Open WebUI | شغّل `Setup-OpenWebUI.cmd` مرة أخرى (البيانات تبقى) |
| عرض السجلات (Docker) | `docker logs -f open-webui` |
| إيقاف / تشغيل (Docker) | `docker stop open-webui` / `docker start open-webui` |
| إيقاف / تشغيل (Python) | `Stop-ScheduledTask OpenWebUI` / `Start-ScheduledTask OpenWebUI` |
| نسخة احتياطية (Docker) | `docker run --rm -v open-webui:/data -v ${PWD}:/backup alpine tar czf /backup/openwebui-backup.tgz -C /data .` |
| النماذج المثبّتة | `ollama list` |
| حذف نموذج | `ollama rm <اسم-النموذج>` |

## خيارات السكربت

| الخيار | ماذا يفعل |
|---|---|
| `-PullModels` | ينزّل النماذج المحلية |
| `-Models a,b` | يحدد النماذج التي تُنزّل (الافتراضي `qwen2.5:7b,llama3.1:8b`) |
| `-OptimizeOllama` | يوفّر ذاكرة الكرت لكرت 8GB (يعيد تشغيل Ollama) |
| `-AllowDockerToOllama` | يحل مشكلة «الحاوية لا ترى Ollama» (يعيد تشغيل Ollama) |
| `-Port 3100` | يستخدم منفذًا آخر |
| `-ForcePip` | يستخدم Python بدل Docker حتى لو كان Docker موجودًا |

## حل المشاكل

- **لا تظهر النماذج المحلية / اتصال Ollama باللون الأحمر:** الحاوية لا تصل إلى Ollama. السكربت يكتشف هذا وينبّهك. الحل: شغّل `Setup-OpenWebUI.cmd -AllowDockerToOllama`. يجعل هذا Ollama يستمع على كل الواجهات، وجدار حماية ويندوز يبقى يمنع الأجهزة الأخرى من المنفذ 11434 ما لم تسمح أنت.
- **تعمل على اللابتوب ولا تعمل على الجوال:** تأكد أن Tailscale مفعّل على الجهازين، وأنك تستخدم عنوان `100.x.x.x`، وأن التثبيت شُغّل كمسؤول (عندها فقط تُضاف قاعدة الجدار الناري).
- **الصفحة لا تفتح بعد إعادة تشغيل الجهاز:** افتح Docker Desktop وانتظر دقيقة، وفعّل خيار التشغيل عند تسجيل الدخول (الخطوة 1).
- **على شبكة واي فاي عامة:** قاعدة السكربت تسمح لأجهزة Tailscale فقط، لكن Docker Desktop قد يضيف قواعد خاصة به. للاحتياط افتح **Windows Defender Firewall → Inbound Rules** واجعل قواعد Docker على الشبكات **Private** فقط.
- **رسالة «running scripts is disabled»:** استخدم `Setup-OpenWebUI.cmd` بدل تشغيل ملف `.ps1` مباشرة، أو أضف `-ExecutionPolicy Bypass` كما في الأمثلة.

## إزالة كل شيء

</div>

```powershell
docker rm -f open-webui; docker volume rm open-webui        # Docker (يحذف المحادثات!)
Unregister-ScheduledTask OpenWebUI -Confirm:$false           # Python
Remove-NetFirewallRule -DisplayName "Open WebUI (Tailscale only)"   # كمسؤول
Remove-Item -Recurse "$env:LOCALAPPDATA\OpenWebUI"
```
