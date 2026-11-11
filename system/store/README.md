# وكيل المتجر الإلكتروني (سلة)

نسخة مرجعية من `C:\wameed\store` على اللابتوب. التشغيل الفعلي من هناك.

| الملف | الغرض |
|---|---|
| `imgproc/` | خدمة الصور: rembg محلي (مجاني)، خلفية بيضاء 1200×1200، ظل خفيف، شعار المؤسسة. على `127.0.0.1:7000` فقط |
| `docker-compose.store.yml` | يضيف `imgproc` ومتغيرات سلة ورقم الموظف لـ n8n |
| `install-store.ps1` | التثبيت: يحدّث `.env`، يبني الخدمة، يعيد تشغيل n8n، ينزّل `qwen2.5vl:7b` |

مسارات n8n المرتبطة: `STORE - Salla Auth`، `STORE - Catalog Sync`، `STORE - Photo Requests`، `STORE - Bot Router`، `STORE - Process Photo`، `STORE - Publish Product`، `STORE - Orders`، ونوع الإجراء `store_publish` في `SYS - Approval Gate`.

الجداول في قاعدة `wameed_ads`: `store_tokens`، `store_products`، `store_photos`، `store_orders`، `store_state`.
