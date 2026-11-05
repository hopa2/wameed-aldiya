-- اختبار بوابة التنفيذ: يعمل داخل معاملة ثم يتراجع، فلا يترك أثرًا.
-- psql -v ON_ERROR_STOP=1 -f system/db/tests/gate_test.sql
BEGIN;
SET search_path = wameed, public;
-- نبدأ من جداول فارغة (داخل المعاملة فقط)
TRUNCATE suppliers, stock_items, actions, agent_runs, wa_messages, schedule_claims CASCADE;

INSERT INTO suppliers (name, whitelisted, whatsapp) VALUES ('مورد معتمد', true, '966500000001'), ('مورد آخر', false, '966500000002');
INSERT INTO stock_items (item_key, name, category, unit, qty_on_hand, reorder_level, avg_daily_sales, cost, prev_cost, price, preferred_supplier)
VALUES ('P1', 'محبس 1/2 إنش', 'plumbing', 'حبة', 3, 10, 2, 16, 15, 18, 'مورد معتمد'),
       ('C1', 'أسمنت مقاوم 50كجم', 'building', 'كيس', 20, 50, 8, 16.5, NULL, 19, 'مورد معتمد');
UPDATE config SET value = to_jsonb((current_date - 1)::text) WHERE key = 'dry_run_until';

DO $$
DECLARE r jsonb; a actions; g record; ctx jsonb;
BEGIN
  -- 1) وكيل قراءة فقط لا يستطيع إنشاء أمر شراء
  SELECT * INTO g FROM gate_check('sales_agent', '{"type":"create_purchase_order","payload":{}}');
  ASSERT g.status = 'auto_rejected', '1: ' || g.reason;

  -- 2) فاتورة مبيعات ممنوعة نهائيًا
  SELECT * INTO g FROM gate_check('inventory_agent', '{"type":"create_sales_invoice"}');
  ASSERT g.status = 'auto_rejected' AND g.reason LIKE 'إجراء ممنوع%', '2: ' || g.reason;

  -- 3) أمر شراء صحيح ← بانتظار الموافقة
  SELECT * INTO g FROM gate_check('inventory_agent', '{"type":"create_purchase_order","payload":{"supplier":"مورد معتمد","lines":[{"name":"أسمنت","qty":100,"unit_price":16.5}],"order_total":1650}}');
  ASSERT g.status = 'pending' AND g.total = 1650, '3: ' || g.status || ' ' || g.reason;

  -- 4) مورد غير معتمد
  SELECT * INTO g FROM gate_check('inventory_agent', '{"type":"create_purchase_order","payload":{"supplier":"مورد آخر","lines":[{"name":"x","qty":1,"unit_price":1}],"order_total":1}}');
  ASSERT g.status = 'auto_rejected', '4';

  -- 5) الإجمالي المكتوب لا يطابق البنود (النموذج أخطأ في الحساب)
  SELECT * INTO g FROM gate_check('inventory_agent', '{"type":"create_purchase_order","payload":{"supplier":"مورد معتمد","lines":[{"name":"x","qty":10,"unit_price":10}],"order_total":50}}');
  ASSERT g.status = 'auto_rejected' AND g.reason LIKE '%لا يطابق%', '5: ' || g.reason;

  -- 6) فوق سقف الطلب الواحد
  SELECT * INTO g FROM gate_check('inventory_agent', '{"type":"create_purchase_order","payload":{"supplier":"مورد معتمد","lines":[{"name":"x","qty":1000,"unit_price":5}],"order_total":5000}}');
  ASSERT g.status = 'auto_rejected' AND g.reason LIKE '%سقف الطلب%', '6: ' || g.reason;

  -- 7) أرقام غير رقمية لا تكسر البوابة
  SELECT * INTO g FROM gate_check('inventory_agent', '{"type":"create_purchase_order","payload":{"supplier":"مورد معتمد","lines":[{"name":"x","qty":"كثير","unit_price":5}],"order_total":5}}');
  ASSERT g.status = 'auto_rejected' AND g.reason LIKE 'بيانات الإجراء غير صالحة%', '7: ' || g.reason;

  -- 8) سعر يخالف الحد الأدنى للهامش (سباكة 15%): 18 → 18.5 هامش 13.5%
  SELECT * INTO g FROM gate_check('pricing_agent', '{"type":"update_item_prices","payload":{"items":[{"item_key":"P1","name":"محبس","price_proposed":18.5}]}}');
  ASSERT g.status = 'auto_rejected' AND g.reason LIKE 'هامش%', '8: ' || g.reason;
  -- 9) زيادة فوق 10%: 18 → 21
  SELECT * INTO g FROM gate_check('pricing_agent', '{"type":"update_item_prices","payload":{"items":[{"item_key":"P1","name":"محبس","price_proposed":21}]}}');
  ASSERT g.status = 'auto_rejected' AND g.reason LIKE 'زيادة%', '9: ' || g.reason;
  -- 10) سعر صحيح: 18 → 19.5 (هامش 17.9%، زيادة 8.3%)
  SELECT * INTO g FROM gate_check('pricing_agent', '{"type":"update_item_prices","payload":{"items":[{"item_key":"P1","name":"محبس","price_proposed":19.5}]}}');
  ASSERT g.status = 'pending', '10: ' || g.reason;

  -- 11) رد واتساب في وضع الظل ← انتظار، ورابط غريب ← رفض
  SELECT * INTO g FROM gate_check('customer_service', '{"type":"whatsapp_reply","payload":{"chat_id":"966511111111@c.us","text":"متوفر","auto_ok":true}}');
  ASSERT g.status = 'pending', '11a';
  SELECT * INTO g FROM gate_check('customer_service', '{"type":"whatsapp_reply","payload":{"chat_id":"966511111111@c.us","text":"شوف http://evil.example"}}');
  ASSERT g.status = 'auto_rejected', '11b';
  SELECT * INTO g FROM gate_check('customer_service', '{"type":"whatsapp_reply","payload":{"chat_id":"966511111111@c.us","text":"موقعنا https://maps.app.goo.gl/twARKvkxTz6S63MK8"}}');
  ASSERT g.status = 'pending', '11c: ' || g.reason;
  UPDATE config SET value = 'false' WHERE key = 'shadow_mode';
  SELECT * INTO g FROM gate_check('customer_service', '{"type":"whatsapp_reply","payload":{"chat_id":"966511111111@c.us","text":"متوفر","auto_ok":true}}');
  ASSERT g.status = 'auto_approved', '11d: ' || g.status;

  -- 12) رسالة لرقم ليس لمورد معتمد
  SELECT * INTO g FROM gate_check('supplier_agent', '{"type":"send_supplier_message","payload":{"channel":"whatsapp","to":"966500000002","text":"السلام عليكم"}}');
  ASSERT g.status = 'auto_rejected', '12';

  -- 13) وكيل الإعلانات يسجّل ما نفّذه، ووكيل عادي لا يستطيع ادّعاء التنفيذ
  SELECT * INTO g FROM gate_check('google_ads_agent', '{"type":"add_negative_keyword","already_executed":true}');
  ASSERT g.status = 'executed', '13a';
  SELECT * INTO g FROM gate_check('inventory_agent', '{"type":"create_purchase_order","already_executed":true}');
  ASSERT g.status = 'auto_rejected', '13b';

  -- 13c) الإشعارات لا تتوقف في فترة التجربة، والتنفيذ الحقيقي يتوقف
  UPDATE config SET value = to_jsonb((current_date + 5)::text) WHERE key = 'dry_run_until';
  SELECT * INTO g FROM gate_check('orchestrator', '{"type":"notify_owner","payload":{"text":"x"}}');
  ASSERT g.status = 'auto_approved', '13c: ' || g.status;
  SELECT * INTO g FROM gate_check('customer_service', '{"type":"whatsapp_reply","payload":{"chat_id":"966511111111@c.us","text":"متوفر","auto_ok":true}}');
  ASSERT g.status = 'dry_run', '13d: ' || g.status;
  UPDATE config SET value = to_jsonb((current_date - 1)::text) WHERE key = 'dry_run_until';

  -- 14) ingest_run كامل + قرار + سقف يومي عند الموافقة
  r := ingest_run('inventory_agent', 'test', 'qwen3:8b', 1000, '{}',
    '{"agent":"inventory_agent","status":"ok","summary":"نواقص","actions":[
       {"type":"create_purchase_order","needs_approval":true,"reason":"r","payload":{"supplier":"مورد معتمد","lines":[{"name":"أسمنت","qty":150,"unit_price":19}],"order_total":2850}},
       {"type":"create_purchase_order","needs_approval":true,"reason":"r","payload":{"supplier":"مورد معتمد","lines":[{"name":"أسمنت","qty":150,"unit_price":19}],"order_total":2850}},
       {"type":"create_purchase_order","needs_approval":true,"reason":"r","payload":{"supplier":"مورد معتمد","lines":[{"name":"أسمنت","qty":150,"unit_price":19}],"order_total":2850}},
       {"type":"create_purchase_order","needs_approval":true,"reason":"r","payload":{"supplier":"مورد معتمد","lines":[{"name":"أسمنت","qty":150,"unit_price":19}],"order_total":2850}},
       {"type":"delete_record","payload":{}}],"risks":[],"missing_data":[]}');
  ASSERT r->>'status' = 'ok' AND jsonb_array_length(r->'actions') = 5, '14a';
  ASSERT r->'actions'->4->>'status' = 'auto_rejected', '14b';
  PERFORM decide_action((r->'actions'->0->>'id')::bigint, 'approve');
  PERFORM decide_action((r->'actions'->1->>'id')::bigint, 'approve');
  PERFORM decide_action((r->'actions'->2->>'id')::bigint, 'approve');
  a := decide_action((r->'actions'->3->>'id')::bigint, 'approve');   -- 4×2850 = 11400 > 10000
  ASSERT a.status = 'auto_rejected', '14c: ' || a.status;
  ASSERT cap_used_today() = 8550, '14d';

  -- 15) التنفيذ لا يتكرر
  ASSERT (SELECT count(*) FROM claim_action((r->'actions'->0->>'id')::bigint)) = 1, '15a';
  ASSERT (SELECT count(*) FROM claim_action((r->'actions'->0->>'id')::bigint)) = 0, '15b';
  a := finish_action((r->'actions'->0->>'id')::bigint, 'needs_manual', '{"note":"x"}');
  ASSERT a.status = 'needs_manual', '15c';

  -- 16) رد غير صالح من النموذج
  r := ingest_run('sales_agent', 'test', 'qwen3:8b', 10, '{}', '{"foo":1}');
  ASSERT r->>'status' = 'invalid_output', '16';

  -- 17) الإيقاف يمنع كل شيء
  UPDATE config SET value = 'true' WHERE key = 'system_paused';
  SELECT * INTO g FROM gate_check('inventory_agent', '{"type":"create_purchase_order","payload":{"supplier":"مورد معتمد","lines":[{"name":"x","qty":1,"unit_price":1}],"order_total":1}}');
  ASSERT g.status = 'auto_rejected' AND g.reason LIKE 'النظام موقوف%', '17a';
  ASSERT (SELECT count(*) FROM claim_due_agents()) = 0, '17b';
  UPDATE config SET value = 'false' WHERE key = 'system_paused';

  -- 18) الجدولة: يحجز مرة واحدة فقط
  UPDATE agents SET schedule = 'hourly@0' WHERE name = 'sales_agent';
  ASSERT (SELECT count(*) FROM claim_due_agents() WHERE agent = 'sales_agent') = 1, '18a';
  ASSERT (SELECT count(*) FROM claim_due_agents() WHERE agent = 'sales_agent') = 0, '18b';
  ASSERT last_slot('weekly@sat@03:00') <= now() AND last_slot('weekly@sat@03:00') > now() - interval '7 days', '18c';
  ASSERT last_slot('nonsense') IS NULL, '18d';

  -- 19) السياق ونص الموافقة
  ctx := agent_context('inventory_agent');
  ASSERT jsonb_array_length(ctx->'low_stock') = 2, '19a: ' || (ctx->'low_stock')::text;
  ctx := agent_context('pricing_agent');
  ASSERT jsonb_array_length(ctx->'candidates') >= 1, '19b';
  ASSERT fallback_report() LIKE '📊 تقرير%', '19d';
  ASSERT (SELECT count(*) FROM agents WHERE system_prompt IS NULL AND managed_by = 'runner') = 0, '19e';

  -- 20) انتهاء المهلة
  UPDATE actions SET expires_at = now() - interval '1 minute' WHERE status = 'pending';
  ASSERT expire_actions() >= 0, '20';
  ASSERT NOT EXISTS (SELECT 1 FROM actions WHERE status = 'pending'), '20b';

  RAISE NOTICE 'كل اختبارات البوابة نجحت ✅';
END $$;
ROLLBACK;
