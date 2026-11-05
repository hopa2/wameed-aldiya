-- ============================================================
-- القيم الافتراضية. لا تكتب فوق أي قيمة عدّلتها من لوحة التحكم
-- (ON CONFLICT DO NOTHING)، فإعادة التشغيل آمنة.
-- ============================================================
SET search_path = wameed, public;

INSERT INTO config (key, value, label_ar, group_ar, sort) VALUES
  ('system_paused',              'false',  'النظام موقوف (/stop)', 'التشغيل', 1),
  ('dry_run_until',              to_jsonb((current_date + 14)::text), 'فترة التجربة حتى (لا تنفيذ تلقائي قبلها)', 'التشغيل', 2),
  ('shadow_mode',                'true',   'وضع الظل لواتساب (لا رد بلا موافقتك)', 'التشغيل', 3),
  ('owner_chat_id',              '""',     'معرّف محادثتك في تيليجرام', 'التشغيل', 4),
  ('dashboard_url',              '""',     'رابط لوحة التحكم (يظهر في إشعارات تيليجرام)', 'التشغيل', 5),
  ('cap_per_order',              '3000',   'سقف الطلب الواحد (ر.س)', 'السقوف', 10),
  ('cap_daily',                  '10000',  'سقف اليوم (ر.س)', 'السقوف', 11),
  ('approval_timeout_hours',     '4',      'مهلة الموافقة بالساعات (بعدها رفض)', 'السقوف', 12),
  ('min_margin',                 '{"plumbing":15,"electrical":15,"paints":20,"building":12,"other":12}', 'الحد الأدنى للهامش % لكل فئة', 'التسعير', 20),
  ('max_increase_pct',           '10',     'أقصى زيادة سعر دفعة واحدة %', 'التسعير', 21),
  ('max_items_per_batch',        '5',      'أصناف كل دفعة تسعير', 'التسعير', 22),
  ('reorder_cover_days',         '14',     'أيام التغطية لإعادة الطلب', 'المخزون', 30),
  ('whatsapp_max_replies_per_hour', '30',  'أقصى ردود واتساب في الساعة', 'واتساب', 40),
  ('waha_url',                   '"http://SYNOLOGY-TAILSCALE-IP:3000"', 'عنوان WAHA على Synology', 'واتساب', 41),
  ('waha_session',               '"default"', 'اسم جلسة WAHA', 'واتساب', 42),
  ('ollama_url',                 '"http://host.docker.internal:11434"', 'عنوان Ollama', 'النماذج', 50),
  ('drafts_count',               '3',      'عدد مسودات التسويق', 'التسويق', 60),
  ('occasions',                  '[]',     'مناسبات الأسبوع (للتسويق)', 'التسويق', 61),
  ('min_coverage',               '{"كاشير":1}', 'الحد الأدنى للتغطية في كل وردية', 'الموظفون', 70),
  ('healthchecks_url',           '""',     'رابط نبض Healthchecks.io (اختياري)', 'المراقبة', 80),
  ('store_info', '{
     "name": "مؤسسة وميض الضياء",
     "location": "طريق الملك فهد، الحشيبرية، صبيا - جازان",
     "phone": "966550680623",
     "whatsapp": "966556448410",
     "maps_link": "https://maps.app.goo.gl/twARKvkxTz6S63MK8",
     "hours_text": "السبت إلى الخميس: 7 ص – 12 الظهر و 4 م – 11 الليل | الجمعة: 4 م – 11 الليل",
     "ad_schedule": [
       {"days": "SAT-THU", "from": "07:00", "to": "12:00"},
       {"days": "SAT-THU", "from": "16:00", "to": "23:00"},
       {"days": "FRI", "from": "16:00", "to": "23:00"}]
   }', 'معلومات المحل', 'المحل', 90)
ON CONFLICT (key) DO NOTHING;

INSERT INTO agents (name, label_ar, description_ar, model, output_kind, managed_by, schedule, sort) VALUES
  ('orchestrator',     'المنسّق',             'يكتب موجز الصباح من تقارير الوكلاء ويرسله لتيليجرام', 'qwen3:8b', 'orchestrator', 'runner', 'daily@07:00', 1),
  ('sales_agent',      'المبيعات والتحليل',    'قراءة فقط: أرقام الأمس وأعلى الأصناف والتغير', 'qwen3:8b', 'envelope', 'runner', 'daily@23:00', 2),
  ('inventory_agent',  'المخزون والمشتريات',   'يكتشف النواقص ويقترح أوامر شراء (بموافقتك)', 'qwen3:8b', 'envelope', 'runner', 'daily@06:30', 3),
  ('finance_agent',    'المالية',             'قراءة فقط: النقدية والذمم وأعمارها', 'qwen3:8b', 'envelope', 'runner', 'daily@06:40', 4),
  ('pricing_agent',    'التسعير',             'يقترح تعديل أسعار تحت الحد الأدنى للهامش (بموافقتك)', 'qwen3:8b', 'envelope', 'runner', 'weekly@sat@05:00', 5),
  ('supplier_agent',   'علاقات الموردين',      'يكتب رسالة المورد بعد اعتماد أمر الشراء (بموافقتك)', 'qwen3:8b', 'envelope', 'runner', NULL, 6),
  ('marketing_agent',  'التسويق',             'مسودات منشورات أسبوعية (بموافقتك)', 'qwen3:8b', 'envelope', 'runner', 'weekly@sun@10:00', 7),
  ('hr_agent',         'الموظفين والجدولة',    'جدول ورديات الأسبوع القادم (بموافقتك)', 'qwen3:8b', 'envelope', 'runner', 'weekly@thu@20:00', 8),
  ('customer_service', 'خدمة العملاء (واتساب)', 'يرد على أسئلة السعر والتوفر والدوام، ويحوّل الباقي', 'qwen3:8b', 'whatsapp', 'runner', NULL, 9),
  ('google_ads_agent', 'إعلانات جوجل',         'workflow مستقل على qwen3:14b ضمن سقوفه، ويسجل هنا ما نفّذه', 'qwen3:14b', 'envelope', 'external', NULL, 10)
ON CONFLICT (name) DO NOTHING;

INSERT INTO action_policies (action_type, label_ar, mode, executor, allowed_agents, counts_toward_cap, note_ar) VALUES
  ('create_purchase_order', 'أمر شراء',              'approval',    'manual',   '{inventory_agent}', true,  'يُدخل في Manager.io يدويًا حتى ربط واجهته، ثم يكتب وكيل الموردين الرسالة'),
  ('update_item_prices',    'تعديل أسعار',           'approval',    'manual',   '{pricing_agent}',   false, 'يُدخل في Manager.io يدويًا حتى ربط واجهته'),
  ('send_supplier_message', 'رسالة لمورد',           'approval',    'whatsapp', '{supplier_agent}',  false, 'واتساب عبر WAHA لرقم مورد معتمد فقط'),
  ('whatsapp_reply',        'رد واتساب لعميل',       'conditional', 'whatsapp', '{customer_service}', false, 'وضع الظل: بموافقتك. بعده: تلقائي للمعلوماتي بثقة عالية'),
  ('whatsapp_escalation',   'تحويل عميل لك',         'auto',        'telegram', '{customer_service}', false, 'تنبيه فوري لك على تيليجرام'),
  ('suggest_check',         'اقتراح مراجعة',         'auto',        'none',     '{sales_agent,finance_agent}', false, 'ملاحظة فقط بلا تنفيذ'),
  ('notify_owner',          'تنبيه للمالك',          'auto',        'telegram', '{orchestrator,sales_agent,finance_agent,inventory_agent}', false, NULL),
  ('publish_post',          'نشر منشور',             'approval',    'manual',   '{marketing_agent}', false, 'تنشره أنت بعد الموافقة'),
  ('publish_schedule',      'نشر جدول الورديات',     'approval',    'manual',   '{hr_agent}',        false, 'ترسله أنت بعد الموافقة'),
  -- وكيل الإعلانات: ينفّذ بنفسه ضمن سقوفه في workflow الخاص به، وهنا يُسجل فقط
  ('add_negative_keyword',  'إعلانات: كلمة سلبية',   'auto', 'external', '{google_ads_agent}', false, NULL),
  ('pause_keyword',         'إعلانات: إيقاف كلمة',   'auto', 'external', '{google_ads_agent}', false, NULL),
  ('pause_ad',              'إعلانات: إيقاف إعلان',  'auto', 'external', '{google_ads_agent}', false, NULL),
  ('pause_ad_group',        'إعلانات: إيقاف مجموعة', 'auto', 'external', '{google_ads_agent}', false, NULL),
  ('adjust_keyword_cpc',    'إعلانات: سعر نقرة',     'auto', 'external', '{google_ads_agent}', false, NULL),
  ('add_keyword',           'إعلانات: كلمة جديدة',   'auto', 'external', '{google_ads_agent}', false, NULL),
  ('create_ad',             'إعلانات: إعلان جديد',   'auto', 'external', '{google_ads_agent}', false, NULL),
  ('enable_item',           'إعلانات: إعادة تفعيل',  'auto', 'external', '{google_ads_agent}', false, NULL),
  ('change_ad_schedule',    'إعلانات: جدولة',        'auto', 'external', '{google_ads_agent}', false, NULL),
  ('reallocate_budget',     'إعلانات: توزيع ميزانية', 'auto', 'external', '{google_ads_agent}', false, NULL),
  ('update_landing_page',   'تحديث صفحة الهبوط',     'auto', 'external', '{google_ads_agent}', false, NULL),
  -- ممنوع نهائيًا (متطلبات فاتورة وZATCA وسلامة البيانات)
  ('create_sales_invoice',  'إنشاء فاتورة مبيعات',   'forbidden', 'none', '{}', false, 'الفوترة بشرية عند الكاشير'),
  ('edit_sales_invoice',    'تعديل فاتورة مبيعات',   'forbidden', 'none', '{}', false, NULL),
  ('delete_sales_invoice',  'حذف فاتورة مبيعات',     'forbidden', 'none', '{}', false, NULL),
  ('delete_record',         'حذف سجل',               'forbidden', 'none', '{}', false, NULL),
  ('bulk_message',          'إرسال جماعي',           'forbidden', 'none', '{}', false, NULL),
  ('accept_payment_terms',  'التزام مالي باسم المؤسسة', 'forbidden', 'none', '{}', false, NULL)
ON CONFLICT (action_type) DO NOTHING;
