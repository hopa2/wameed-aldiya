-- ============================================================
-- منطق المنظومة داخل Postgres: بوابة التنفيذ، والجدولة، وسياق الوكلاء.
-- الحواجز هنا لا في البرومبت ولا في n8n: لو أخطأ النموذج أو تعطّل
-- workflow، تبقى البوابة ترفض. آمن لإعادة التشغيل (CREATE OR REPLACE).
-- ============================================================
SET search_path = wameed, public;

-- ---------- أدوات مساعدة ----------
CREATE OR REPLACE FUNCTION cfg(p_key text) RETURNS jsonb
LANGUAGE sql STABLE AS $$ SELECT value FROM wameed.config WHERE key = p_key $$;

CREATE OR REPLACE FUNCTION cfg_num(p_key text, p_default numeric DEFAULT 0) RETURNS numeric
LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT CASE WHEN jsonb_typeof(value) = 'number' THEN value::text::numeric END
                   FROM wameed.config WHERE key = p_key), p_default) $$;

CREATE OR REPLACE FUNCTION cfg_bool(p_key text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT value = 'true'::jsonb FROM wameed.config WHERE key = p_key), false) $$;

CREATE OR REPLACE FUNCTION cfg_text(p_key text) RETURNS text
LANGUAGE sql STABLE AS $$ SELECT value #>> '{}' FROM wameed.config WHERE key = p_key $$;

CREATE OR REPLACE FUNCTION riyadh_now() RETURNS timestamp
LANGUAGE sql STABLE AS $$ SELECT now() AT TIME ZONE 'Asia/Riyadh' $$;

CREATE OR REPLACE FUNCTION riyadh_today() RETURNS date
LANGUAGE sql STABLE AS $$ SELECT (now() AT TIME ZONE 'Asia/Riyadh')::date $$;

CREATE OR REPLACE FUNCTION log_event(p_level text, p_source text, p_message text, p_data jsonb DEFAULT NULL)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO wameed.events (level, source, message, data) VALUES (p_level, p_source, p_message, p_data) $$;

CREATE OR REPLACE FUNCTION set_config_value(p_key text, p_value jsonb, p_by text DEFAULT 'system')
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE wameed.config SET value = p_value, updated_at = now(), updated_by = p_by WHERE key = p_key;
  IF NOT FOUND THEN RAISE EXCEPTION 'إعداد غير معروف: %', p_key; END IF;
  PERFORM wameed.log_event('info', p_by, 'تعديل إعداد: ' || p_key, jsonb_build_object('value', p_value));
END $$;

-- المصروف اليوم من السقف اليومي (الإجراءات المعتمدة أو المنفذة فقط)
CREATE OR REPLACE FUNCTION cap_used_today() RETURNS numeric
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(SUM(a.total_sar), 0)
  FROM wameed.actions a JOIN wameed.action_policies p ON p.action_type = a.type
  WHERE p.counts_toward_cap
    AND a.status IN ('auto_approved','approved','executing','executed','needs_manual')
    AND (a.created_at AT TIME ZONE 'Asia/Riyadh')::date = wameed.riyadh_today() $$;

-- ---------- فحص الحواجز لإجراء واحد (بلا كتابة) ----------
CREATE OR REPLACE FUNCTION gate_check(p_agent text, p_action jsonb,
  OUT status text, OUT reason text, OUT total numeric)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_type    text  := p_action->>'type';
  v_payload jsonb := COALESCE(p_action->'payload', '{}'::jsonb);
  v_pol     wameed.action_policies;
  v_agent   wameed.agents;
  v_line    jsonb;
  v_item    jsonb;
  v_stock   wameed.stock_items;
  v_price   numeric;
  v_margin  numeric;
  v_min     numeric;
  v_text    text;
  v_n       int;
BEGIN
  total := 0;
  SELECT * INTO v_agent FROM wameed.agents a WHERE a.name = p_agent;
  SELECT * INTO v_pol FROM wameed.action_policies ap WHERE ap.action_type = v_type;

  IF v_agent.name IS NULL THEN
    status := 'auto_rejected'; reason := 'وكيل غير معروف: ' || COALESCE(p_agent, '?'); RETURN;
  END IF;
  IF v_pol.action_type IS NULL THEN
    status := 'auto_rejected'; reason := 'نوع إجراء غير معروف: ' || COALESCE(v_type, '?'); RETURN;
  END IF;
  IF v_pol.mode = 'forbidden' THEN
    status := 'auto_rejected'; reason := 'إجراء ممنوع نهائيًا: ' || v_pol.label_ar; RETURN;
  END IF;
  IF NOT (p_agent = ANY (v_pol.allowed_agents)) THEN
    status := 'auto_rejected'; reason := 'هذا الوكيل لا يملك صلاحية: ' || v_pol.label_ar; RETURN;
  END IF;

  -- إجراء نفّذه workflow خارجي بنفسه (مثل وكيل الإعلانات ضمن سقوفه): يُسجل فقط
  IF COALESCE((p_action->>'already_executed')::boolean, false) THEN
    IF v_agent.managed_by = 'external' THEN
      status := 'executed'; reason := 'نفّذه الوكيل نفسه ضمن سقوفه، وسُجل هنا للمتابعة'; RETURN;
    END IF;
    status := 'auto_rejected'; reason := 'already_executed مسموح لوكيل خارجي فقط'; RETURN;
  END IF;

  IF wameed.cfg_bool('system_paused') THEN
    status := 'auto_rejected'; reason := 'النظام موقوف (/stop)'; RETURN;
  END IF;

  -- ===== فحوص خاصة بكل نوع =====
  IF v_type = 'create_purchase_order' THEN
    IF NOT EXISTS (SELECT 1 FROM wameed.suppliers s WHERE s.name = v_payload->>'supplier' AND s.whitelisted) THEN
      status := 'auto_rejected'; reason := 'مورد غير معتمد: ' || COALESCE(v_payload->>'supplier', '?'); RETURN;
    END IF;
    IF jsonb_typeof(v_payload->'lines') IS DISTINCT FROM 'array' OR jsonb_array_length(v_payload->'lines') = 0 THEN
      status := 'auto_rejected'; reason := 'أمر شراء بلا بنود'; RETURN;
    END IF;
    FOR v_line IN SELECT * FROM jsonb_array_elements(v_payload->'lines') LOOP
      IF (v_line->>'qty')::numeric <= 0 OR (v_line->>'unit_price')::numeric <= 0 THEN
        status := 'auto_rejected'; reason := 'كمية أو سعر غير صالح في: ' || COALESCE(v_line->>'name', '?'); RETURN;
      END IF;
      total := total + (v_line->>'qty')::numeric * (v_line->>'unit_price')::numeric;
    END LOOP;
    total := round(total, 2);
    IF abs(total - COALESCE((v_payload->>'order_total')::numeric, -1)) > 1 THEN
      status := 'auto_rejected';
      reason := format('الإجمالي %s لا يطابق مجموع البنود %s', v_payload->>'order_total', total); RETURN;
    END IF;

  ELSIF v_type = 'update_item_prices' THEN
    v_n := COALESCE(jsonb_array_length(v_payload->'items'), 0);
    IF v_n = 0 THEN status := 'auto_rejected'; reason := 'دفعة أسعار فارغة'; RETURN; END IF;
    IF v_n > wameed.cfg_num('max_items_per_batch', 5) THEN
      status := 'auto_rejected'; reason := format('الدفعة %s أصناف، والحد %s', v_n, wameed.cfg_num('max_items_per_batch', 5)); RETURN;
    END IF;
    FOR v_item IN SELECT * FROM jsonb_array_elements(v_payload->'items') LOOP
      SELECT * INTO v_stock FROM wameed.stock_items si WHERE si.item_key = v_item->>'item_key';
      IF v_stock.item_key IS NULL OR v_stock.cost IS NULL OR v_stock.price IS NULL THEN
        status := 'auto_rejected'; reason := 'صنف غير معروف أو بلا تكلفة: ' || COALESCE(v_item->>'name', '?'); RETURN;
      END IF;
      v_price := (v_item->>'price_proposed')::numeric;
      IF v_price IS NULL OR v_price <= 0 THEN
        status := 'auto_rejected'; reason := 'سعر مقترح غير صالح: ' || v_stock.name; RETURN;
      END IF;
      v_margin := (v_price - v_stock.cost) / v_price * 100;
      v_min := COALESCE((wameed.cfg('min_margin')->>v_stock.category)::numeric, 0);
      IF v_margin < v_min THEN
        status := 'auto_rejected'; reason := format('هامش %s أقل من الحد %s%%: %s', round(v_margin, 1), v_min, v_stock.name); RETURN;
      END IF;
      IF v_price < v_stock.price THEN
        status := 'auto_rejected'; reason := 'تخفيض سعر بلا طلب من المالك: ' || v_stock.name; RETURN;
      END IF;
      IF (v_price - v_stock.price) / v_stock.price * 100 > wameed.cfg_num('max_increase_pct', 10) THEN
        status := 'auto_rejected'; reason := format('زيادة أكثر من %s%%: %s', wameed.cfg_num('max_increase_pct', 10), v_stock.name); RETURN;
      END IF;
    END LOOP;

  ELSIF v_type IN ('whatsapp_reply', 'send_supplier_message') THEN
    v_text := COALESCE(v_payload->>'text', '');
    IF length(btrim(v_text)) = 0 OR length(v_text) > 1000 THEN
      status := 'auto_rejected'; reason := 'نص الرسالة فارغ أو أطول من 1000 حرف'; RETURN;
    END IF;
    IF replace(v_text, COALESCE(wameed.cfg('store_info')->>'maps_link', '#none#'), '') ~* '(https?://|www\.)' THEN
      status := 'auto_rejected'; reason := 'الرسالة فيها رابط غير رابط المحل'; RETURN;
    END IF;
    IF v_type = 'send_supplier_message' THEN
      IF COALESCE(v_payload->>'channel', 'whatsapp') <> 'whatsapp' THEN
        status := 'auto_rejected'; reason := 'قناة الإرسال للمورد غير مدعومة آليًا (واتساب فقط)'; RETURN;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM wameed.suppliers s
                     WHERE s.whitelisted AND regexp_replace(COALESCE(s.whatsapp, ''), '\D', '', 'g')
                                           = regexp_replace(COALESCE(v_payload->>'to', ''), '\D', '', 'g')
                       AND COALESCE(s.whatsapp, '') <> '') THEN
        status := 'auto_rejected'; reason := 'رقم المستلم ليس لمورد معتمد'; RETURN;
      END IF;
    ELSE
      IF COALESCE(v_payload->>'chat_id', '') = '' OR v_payload->>'chat_id' LIKE '%@g.us' THEN
        status := 'auto_rejected'; reason := 'محادثة غير صالحة (أو مجموعة)'; RETURN;
      END IF;
      SELECT count(*) INTO v_n FROM wameed.wa_messages m
       WHERE m.direction = 'out' AND m.ts > now() - interval '1 hour';
      IF v_n >= wameed.cfg_num('whatsapp_max_replies_per_hour', 30) THEN
        status := 'auto_rejected'; reason := 'تجاوز حد رسائل واتساب في الساعة'; RETURN;
      END IF;
    END IF;
  END IF;

  -- ===== السقوف المالية =====
  IF v_pol.counts_toward_cap THEN
    IF total > wameed.cfg_num('cap_per_order', 3000) THEN
      status := 'auto_rejected'; reason := format('%s ر.س أعلى من سقف الطلب الواحد %s', total, wameed.cfg_num('cap_per_order', 3000)); RETURN;
    END IF;
    IF wameed.cap_used_today() + total > wameed.cfg_num('cap_daily', 10000) THEN
      status := 'auto_rejected'; reason := format('يتجاوز سقف اليوم (المتبقي %s ر.س)', wameed.cfg_num('cap_daily', 10000) - wameed.cap_used_today()); RETURN;
    END IF;
  END IF;

  -- ===== تلقائي أم بانتظار المالك؟ =====
  IF v_pol.mode = 'auto' THEN
    IF COALESCE((p_action->>'needs_approval')::boolean, false) THEN
      status := 'pending'; reason := 'الوكيل طلب موافقتك';
    ELSE
      status := 'auto_approved'; reason := 'ضمن الحواجز، تلقائي';
    END IF;
  ELSIF v_pol.mode = 'conditional' THEN   -- رد واتساب
    IF wameed.cfg_bool('shadow_mode') THEN
      status := 'pending'; reason := 'وضع الظل: الرد لا يُرسل إلا بموافقتك';
    ELSIF COALESCE((v_payload->>'auto_ok')::boolean, false) THEN
      status := 'auto_approved'; reason := 'سؤال معلوماتي بثقة عالية';
    ELSE
      status := 'pending'; reason := 'ليس معلوماتيًا أو الثقة غير عالية';
    END IF;
  ELSE
    status := 'pending'; reason := 'يحتاج موافقتك';
  END IF;

  -- فترة التجربة: التلقائي يُسجل فقط ولا يُنفذ
  IF status = 'auto_approved' AND v_pol.executor NOT IN ('telegram', 'none')
     AND wameed.riyadh_today() < COALESCE(wameed.cfg_text('dry_run_until'), '1970-01-01')::date THEN
    status := 'dry_run'; reason := 'فترة التجربة حتى ' || wameed.cfg_text('dry_run_until') || ': سُجل ولم يُنفذ';
  END IF;
EXCEPTION WHEN OTHERS THEN
  status := 'auto_rejected'; reason := 'بيانات الإجراء غير صالحة: ' || SQLERRM; total := 0;
END $$;

-- ---------- تسجيل إجراء عبر البوابة ----------
CREATE OR REPLACE FUNCTION submit_action(p_run_id bigint, p_agent text, p_action jsonb)
RETURNS wameed.actions LANGUAGE plpgsql AS $$
DECLARE
  g   record;
  row wameed.actions;
BEGIN
  SELECT * INTO g FROM wameed.gate_check(p_agent, p_action);
  INSERT INTO wameed.actions (run_id, agent, type, reason, payload, total_sar, status, gate_reason,
                              decided_via, decided_at, expires_at, executed_at)
  VALUES (p_run_id, p_agent, COALESCE(p_action->>'type', '?'), p_action->>'reason',
          COALESCE(p_action->'payload', '{}'::jsonb), COALESCE(g.total, 0), g.status, g.reason,
          CASE WHEN g.status IN ('pending') THEN NULL ELSE 'auto' END,
          CASE WHEN g.status IN ('pending') THEN NULL ELSE now() END,
          CASE WHEN g.status = 'pending'
               THEN now() + make_interval(hours => wameed.cfg_num('approval_timeout_hours', 4)::int) END,
          CASE WHEN g.status = 'executed' THEN now() END)
  RETURNING * INTO row;
  IF g.status = 'auto_rejected' THEN
    PERFORM wameed.log_event('warn', 'gate', 'رفض آلي #' || row.id || ': ' || g.reason,
                             jsonb_build_object('agent', p_agent, 'type', row.type));
  END IF;
  RETURN row;
END $$;

-- ---------- قرار المالك ----------
CREATE OR REPLACE FUNCTION decide_action(p_id bigint, p_decision text, p_via text DEFAULT 'dashboard', p_by text DEFAULT 'owner')
RETURNS wameed.actions LANGUAGE plpgsql AS $$
DECLARE
  row wameed.actions;
  pol wameed.action_policies;
BEGIN
  SELECT * INTO row FROM wameed.actions WHERE id = p_id FOR UPDATE;
  IF row.id IS NULL THEN RAISE EXCEPTION 'لا يوجد طلب رقم %', p_id; END IF;
  IF row.status <> 'pending' THEN
    RAISE EXCEPTION 'الطلب #% ليس بانتظار القرار (الحالة: %)', p_id, row.status;
  END IF;
  IF row.expires_at IS NOT NULL AND row.expires_at < now() THEN
    UPDATE wameed.actions SET status = 'expired', decided_at = now(), decided_via = 'system'
     WHERE id = p_id RETURNING * INTO row;
    RETURN row;
  END IF;

  IF p_decision = 'reject' THEN
    UPDATE wameed.actions SET status = 'rejected', decided_at = now(), decided_via = p_via, decided_by = p_by
     WHERE id = p_id RETURNING * INTO row;
  ELSIF p_decision = 'approve' THEN
    IF wameed.cfg_bool('system_paused') THEN RAISE EXCEPTION 'النظام موقوف؛ استأنفه أولًا'; END IF;
    SELECT * INTO pol FROM wameed.action_policies WHERE action_type = row.type;
    IF pol.counts_toward_cap AND wameed.cap_used_today() + row.total_sar > wameed.cfg_num('cap_daily', 10000) THEN
      UPDATE wameed.actions SET status = 'auto_rejected', gate_reason = 'عند الموافقة: يتجاوز سقف اليوم',
             decided_at = now(), decided_via = 'system' WHERE id = p_id RETURNING * INTO row;
      RETURN row;
    END IF;
    UPDATE wameed.actions SET status = 'approved', decided_at = now(), decided_via = p_via, decided_by = p_by
     WHERE id = p_id RETURNING * INTO row;
  ELSE
    RAISE EXCEPTION 'قرار غير معروف: % (approve أو reject)', p_decision;
  END IF;
  PERFORM wameed.log_event('info', p_via, CASE WHEN row.status = 'approved' THEN 'اعتماد #' ELSE 'رفض #' END || p_id, NULL);
  RETURN row;
END $$;

-- ---------- التنفيذ: حجز ثم إنهاء (يمنع التنفيذ مرتين) ----------
CREATE OR REPLACE FUNCTION claim_action(p_id bigint)
RETURNS TABLE (id bigint, agent text, type text, payload jsonb, total_sar numeric, executor text, label_ar text)
LANGUAGE plpgsql AS $$
BEGIN
  IF wameed.cfg_bool('system_paused') THEN RETURN; END IF;
  RETURN QUERY
  UPDATE wameed.actions a SET status = 'executing'
   FROM wameed.action_policies p
   WHERE a.id = p_id AND p.action_type = a.type AND a.status IN ('approved', 'auto_approved')
  RETURNING a.id, a.agent, a.type, a.payload, a.total_sar, p.executor, p.label_ar;
END $$;

CREATE OR REPLACE FUNCTION finish_action(p_id bigint, p_status text, p_result jsonb DEFAULT NULL)
RETURNS wameed.actions LANGUAGE plpgsql AS $$
DECLARE row wameed.actions;
BEGIN
  IF p_status NOT IN ('executed', 'failed', 'needs_manual') THEN
    RAISE EXCEPTION 'حالة إنهاء غير صالحة: %', p_status;
  END IF;
  UPDATE wameed.actions SET status = p_status, executed_at = now(), result = p_result
   WHERE id = p_id AND status = 'executing' RETURNING * INTO row;
  IF row.id IS NOT NULL AND p_status = 'executed' AND row.type IN ('whatsapp_reply', 'send_supplier_message') THEN
    INSERT INTO wameed.wa_messages (chat_id, direction, text)
    VALUES (COALESCE(row.payload->>'chat_id', regexp_replace(COALESCE(row.payload->>'to', ''), '\D', '', 'g') || '@c.us'),
            'out', row.payload->>'text');
  END IF;
  IF row.id IS NOT NULL AND p_status = 'failed' THEN
    PERFORM wameed.log_event('error', 'executor', 'فشل تنفيذ #' || p_id, p_result);
  END IF;
  RETURN row;
END $$;

CREATE OR REPLACE FUNCTION expire_actions() RETURNS int LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
  UPDATE wameed.actions SET status = 'expired', decided_at = now(), decided_via = 'system'
   WHERE status = 'pending' AND expires_at < now();
  GET DIAGNOSTICS n = ROW_COUNT;
  -- تنفيذ علِق أكثر من 30 دقيقة = فشل
  UPDATE wameed.actions SET status = 'failed', result = '{"error":"timeout in executing"}'
   WHERE status = 'executing' AND COALESCE(decided_at, created_at) < now() - interval '30 minutes';
  RETURN n;
END $$;

-- ---------- تسجيل تشغيل وكيل + تمرير إجراءاته على البوابة ----------
CREATE OR REPLACE FUNCTION ingest_run(p_agent text, p_trigger text, p_model text, p_duration_ms int,
                                      p_input jsonb, p_envelope jsonb, p_error text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
  v_run    bigint;
  v_act    jsonb;
  v_row    wameed.actions;
  v_out    jsonb := '[]'::jsonb;
  v_exec   text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM wameed.agents WHERE name = p_agent) THEN
    RAISE EXCEPTION 'وكيل غير معروف: %', p_agent;
  END IF;

  IF p_error IS NOT NULL AND p_error <> '' THEN
    v_status := 'error';
  ELSIF p_envelope IS NULL OR jsonb_typeof(p_envelope) <> 'object'
        OR COALESCE(p_envelope->>'status', '') NOT IN ('ok', 'needs_data', 'paused', 'error') THEN
    v_status := 'invalid_output';
  ELSE
    v_status := p_envelope->>'status';
  END IF;

  INSERT INTO wameed.agent_runs (agent, trigger, status, model, duration_ms, summary, risks, missing_data, input, envelope, error)
  VALUES (p_agent, COALESCE(p_trigger, 'manual'), v_status, p_model, p_duration_ms,
          p_envelope->>'summary',
          CASE WHEN jsonb_typeof(p_envelope->'risks') = 'array' THEN p_envelope->'risks' ELSE '[]' END,
          CASE WHEN jsonb_typeof(p_envelope->'missing_data') = 'array' THEN p_envelope->'missing_data' ELSE '[]' END,
          p_input, p_envelope, NULLIF(p_error, ''))
  RETURNING id INTO v_run;

  IF v_status IN ('error', 'invalid_output') THEN
    PERFORM wameed.log_event('error', p_agent, 'فشل تشغيل الوكيل: ' || COALESCE(p_error, 'رد غير صالح'), jsonb_build_object('run_id', v_run));
  END IF;

  IF v_status IN ('ok', 'needs_data') AND jsonb_typeof(p_envelope->'actions') = 'array' THEN
    FOR v_act IN SELECT * FROM jsonb_array_elements(p_envelope->'actions') LOOP
      v_row := wameed.submit_action(v_run, p_agent, v_act);
      SELECT executor INTO v_exec FROM wameed.action_policies WHERE action_type = v_row.type;
      v_out := v_out || jsonb_build_object('id', v_row.id, 'type', v_row.type, 'status', v_row.status,
                                           'gate_reason', v_row.gate_reason, 'executor', v_exec,
                                           'total_sar', v_row.total_sar);
    END LOOP;
  END IF;

  RETURN jsonb_build_object('run_id', v_run, 'agent', p_agent, 'status', v_status, 'summary', p_envelope->>'summary', 'actions', v_out);
END $$;

-- ---------- الجدولة: daily@07:00 | weekly@sat@03:00 | hourly@15 ----------
CREATE OR REPLACE FUNCTION last_slot(p_schedule text) RETURNS timestamptz
LANGUAGE plpgsql STABLE AS $$
DECLARE
  parts text[] := string_to_array(lower(btrim(p_schedule)), '@');
  n     timestamp := wameed.riyadh_now();
  slot  timestamp;
  dows  text[] := ARRAY['sun','mon','tue','wed','thu','fri','sat'];
  dow   int;
BEGIN
  IF parts[1] = 'daily' THEN
    slot := n::date + parts[2]::time;
    IF slot > n THEN slot := slot - interval '1 day'; END IF;
  ELSIF parts[1] = 'weekly' THEN
    dow := array_position(dows, parts[2]) - 1;
    IF dow IS NULL THEN RETURN NULL; END IF;
    slot := (n::date - ((extract(dow FROM n)::int - dow + 7) % 7)) + parts[3]::time;
    IF slot > n THEN slot := slot - interval '7 days'; END IF;
  ELSIF parts[1] = 'hourly' THEN
    slot := date_trunc('hour', n) + make_interval(mins => COALESCE(parts[2], '0')::int);
    IF slot > n THEN slot := slot - interval '1 hour'; END IF;
  ELSE
    RETURN NULL;
  END IF;
  RETURN slot AT TIME ZONE 'Asia/Riyadh';
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END $$;

-- يحجز المواعيد المستحقة (لم تُشغّل، وعمرها أقل من ساعتين) ويعيدها مرة واحدة فقط
CREATE OR REPLACE FUNCTION claim_due_agents() RETURNS TABLE (agent text, slot timestamptz)
LANGUAGE plpgsql AS $$
BEGIN
  IF wameed.cfg_bool('system_paused') THEN RETURN; END IF;
  RETURN QUERY
  INSERT INTO wameed.schedule_claims (agent, slot)
  SELECT a.name, wameed.last_slot(a.schedule)
    FROM wameed.agents a
   WHERE a.enabled AND a.managed_by = 'runner' AND a.schedule IS NOT NULL
     AND wameed.last_slot(a.schedule) IS NOT NULL
     AND wameed.last_slot(a.schedule) > now() - interval '2 hours'
  ON CONFLICT DO NOTHING
  RETURNING schedule_claims.agent, schedule_claims.slot;
END $$;

-- ---------- سياق كل وكيل (أرقام محسوبة مسبقًا؛ النموذج لا يحسب) ----------
CREATE OR REPLACE FUNCTION agent_context(p_agent text, p_extra jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE
  base   jsonb;
  ctx    jsonb := '{}'::jsonb;
  d      date := wameed.riyadh_today();
  cover  numeric := wameed.cfg_num('reorder_cover_days', 14);
  v_po   wameed.actions;
BEGIN
  base := jsonb_build_object(
    'system_paused', wameed.cfg_bool('system_paused'),
    'now', to_char(wameed.riyadh_now(), 'YYYY-MM-DD HH24:MI'),
    'store_info', wameed.cfg('store_info'));

  IF p_agent = 'sales_agent' THEN
    ctx := jsonb_build_object('metrics', (
      WITH y AS (SELECT * FROM wameed.sales_daily WHERE day = d - 1),
           p AS (SELECT * FROM wameed.sales_daily WHERE day = d - 8)
      SELECT jsonb_build_object(
        'period', (d - 1)::text,
        'total_sales', (SELECT total_sales FROM y),
        'invoice_count', (SELECT invoice_count FROM y),
        'avg_invoice', (SELECT round(total_sales / NULLIF(invoice_count, 0), 2) FROM y),
        'top_items', COALESCE((SELECT top_items FROM y), '[]'),
        'change_vs_prev_period_pct', (SELECT round(((SELECT total_sales FROM y) - total_sales) / NULLIF(total_sales, 0) * 100, 1) FROM p),
        'last_7_days', (SELECT COALESCE(jsonb_agg(jsonb_build_object('day', day, 'total', total_sales, 'invoices', invoice_count) ORDER BY day), '[]')
                          FROM wameed.sales_daily WHERE day BETWEEN d - 7 AND d - 1),
        'zero_sales_items', (SELECT COALESCE(jsonb_agg(name), '[]') FROM
                          (SELECT name FROM wameed.stock_items WHERE COALESCE(avg_daily_sales, 0) = 0 AND qty_on_hand > 0 LIMIT 15) z))));

  ELSIF p_agent = 'inventory_agent' THEN
    ctx := jsonb_build_object(
      'low_stock', (SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'days_of_cover')::numeric NULLS FIRST), '[]') FROM (
        SELECT jsonb_build_object(
          'item_key', item_key, 'item_code', item_key, 'name', name, 'category', category,
          'qty_on_hand', qty_on_hand, 'reorder_level', reorder_level,
          'avg_daily_sales_28d', avg_daily_sales,
          'days_of_cover', round(qty_on_hand / NULLIF(avg_daily_sales, 0), 1),
          'suggested_qty', sq,
          'last_purchase_price', cost,
          'line_total', round(sq * COALESCE(cost, 0), 2),
          'preferred_supplier', preferred_supplier) AS x
        FROM (SELECT *, GREATEST(ceil(COALESCE(avg_daily_sales, 0) * cover * 2 - qty_on_hand), 0) AS sq
                FROM wameed.stock_items) s
        WHERE (reorder_level IS NOT NULL AND qty_on_hand <= reorder_level)
           OR (avg_daily_sales > 0 AND qty_on_hand / avg_daily_sales < cover)
        LIMIT 40) t),
      'supplier_whitelist', (SELECT COALESCE(jsonb_agg(name ORDER BY name), '[]') FROM wameed.suppliers WHERE whitelisted),
      'cap_per_order', wameed.cfg_num('cap_per_order', 3000),
      'cap_daily_remaining', wameed.cfg_num('cap_daily', 10000) - wameed.cap_used_today());

  ELSIF p_agent = 'pricing_agent' THEN
    ctx := jsonb_build_object(
      'candidates', (SELECT COALESCE(jsonb_agg(x), '[]') FROM (
        SELECT jsonb_build_object(
          'item_key', item_key, 'name', name, 'category', category,
          'cost_old', prev_cost, 'cost_new', cost, 'price_current', price,
          'margin_current_pct', round((price - cost) / NULLIF(price, 0) * 100, 1),
          'price_proposed', pp,
          'margin_proposed_pct', round((pp - cost) / NULLIF(pp, 0) * 100, 1),
          'min_margin_pct', mm,
          'sales_28d', round(COALESCE(avg_daily_sales, 0) * 28)) AS x
        FROM (SELECT si.*, mm,
                     -- أقل سعر يحقق الحد الأدنى، مقرّب لأعلى نصف ريال، وبحد أقصى للزيادة
                     LEAST(ceil(cost / (1 - mm / 100) * 2) / 2,
                           round(price * (1 + wameed.cfg_num('max_increase_pct', 10) / 100), 2)) AS pp
                FROM wameed.stock_items si,
                     LATERAL (SELECT COALESCE((wameed.cfg('min_margin')->>si.category)::numeric, 0) AS mm) m
               WHERE cost IS NOT NULL AND price > 0) s
        WHERE (price - cost) / price * 100 < mm OR (prev_cost IS NOT NULL AND prev_cost <> cost)
        LIMIT 25) t),
      'min_margin', wameed.cfg('min_margin'),
      'max_items_per_batch', wameed.cfg_num('max_items_per_batch', 5),
      'max_increase_pct', wameed.cfg_num('max_increase_pct', 10));

  ELSIF p_agent = 'finance_agent' THEN
    ctx := jsonb_build_object('finance', jsonb_build_object(
      'cash_balance', (SELECT value FROM wameed.kv_metrics WHERE key = 'cash_balance'),
      'bank_balance', (SELECT value FROM wameed.kv_metrics WHERE key = 'bank_balance'),
      'payables_due_7d', (SELECT value FROM wameed.kv_metrics WHERE key = 'payables_due_7d'),
      'receivables_total', (SELECT COALESCE(sum(balance), 0) FROM wameed.receivables),
      'aging', (SELECT jsonb_object_agg(bucket, total) FROM (
        SELECT CASE WHEN age <= 30 THEN '0-30' WHEN age <= 60 THEN '31-60' WHEN age <= 90 THEN '61-90' ELSE '90+' END AS bucket,
               sum(balance) AS total
          FROM (SELECT balance, d - COALESCE(due_date, invoice_date, d) AS age FROM wameed.receivables) r
         GROUP BY 1) b),
      'top_overdue_customers', (SELECT COALESCE(jsonb_agg(x), '[]') FROM (
        SELECT jsonb_build_object('customer', customer, 'amount', sum(balance),
                                  'max_days_overdue', max(d - COALESCE(due_date, invoice_date))) AS x
          FROM wameed.receivables WHERE COALESCE(due_date, invoice_date) < d - 30
         GROUP BY customer ORDER BY sum(balance) DESC LIMIT 5) t)));

  ELSIF p_agent = 'marketing_agent' THEN
    ctx := jsonb_build_object(
      'push_items', (SELECT COALESCE(jsonb_agg(x), '[]') FROM (
        SELECT jsonb_build_object('name', name, 'price', price,
               'why', CASE WHEN avg_daily_sales > 0 AND qty_on_hand / avg_daily_sales > 60 THEN 'مخزون مرتفع'
                           WHEN updated_at > now() - interval '7 days' AND prev_cost IS NULL THEN 'وصل جديد'
                           ELSE 'مخزون مرتفع' END) AS x
          FROM wameed.stock_items
         WHERE price > 0 AND qty_on_hand > 0
           AND (COALESCE(avg_daily_sales, 0) = 0 OR qty_on_hand / avg_daily_sales > 60)
         ORDER BY qty_on_hand * COALESCE(cost, 0) DESC LIMIT 6) t),
      'occasions', COALESCE(wameed.cfg('occasions'), '[]'),
      'drafts_count', wameed.cfg_num('drafts_count', 3));

  ELSIF p_agent = 'hr_agent' THEN
    ctx := jsonb_build_object(
      'staff', (SELECT COALESCE(jsonb_agg(jsonb_build_object('name', name, 'role', role, 'available_days', available_days, 'leaves', leaves)), '[]') FROM wameed.staff),
      'store_hours', wameed.cfg('store_info')->'ad_schedule',
      'min_coverage', wameed.cfg('min_coverage'),
      'owner_notes', COALESCE(p_extra->>'owner_notes', ''));

  ELSIF p_agent = 'supplier_agent' THEN
    IF p_extra ? 'action_id' THEN
      SELECT * INTO v_po FROM wameed.actions WHERE id = (p_extra->>'action_id')::bigint AND type = 'create_purchase_order';
    END IF;
    ctx := jsonb_build_object(
      'approved_po', CASE WHEN v_po.id IS NULL THEN NULL ELSE v_po.payload || jsonb_build_object('po_ref', v_po.id) END,
      'supplier', (SELECT to_jsonb(s) FROM wameed.suppliers s WHERE s.name = v_po.payload->>'supplier'),
      'owner_note', COALESCE(p_extra->>'owner_note', ''));

  ELSIF p_agent = 'orchestrator' THEN
    ctx := wameed.morning_brief_data();
  END IF;

  RETURN base || ctx || (p_extra - 'action_id');
END $$;

-- ---------- موجز الصباح ----------
CREATE OR REPLACE FUNCTION morning_brief_data() RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'date', wameed.riyadh_today()::text,
    'agent_reports', (SELECT COALESCE(jsonb_object_agg(agent, summary), '{}') FROM (
        SELECT DISTINCT ON (agent) agent, summary FROM wameed.agent_runs
         WHERE status IN ('ok', 'needs_data') AND agent <> 'orchestrator' AND started_at > now() - interval '30 hours'
         ORDER BY agent, started_at DESC) r),
    'pending_approvals', (SELECT count(*) FROM wameed.actions WHERE status = 'pending'),
    'failed_runs_24h', (SELECT count(*) FROM wameed.agent_runs WHERE status IN ('error', 'invalid_output') AND started_at > now() - interval '24 hours'),
    'unhealthy', (SELECT COALESCE(jsonb_agg(component), '[]') FROM wameed.health WHERE NOT ok)) $$;

CREATE OR REPLACE FUNCTION fallback_report() RETURNS text
LANGUAGE sql STABLE AS $$
  WITH y AS (SELECT * FROM wameed.sales_daily WHERE day = wameed.riyadh_today() - 1),
       ls AS (SELECT name FROM wameed.stock_items
               WHERE (reorder_level IS NOT NULL AND qty_on_hand <= reorder_level)
                  OR (avg_daily_sales > 0 AND qty_on_hand / avg_daily_sales < wameed.cfg_num('reorder_cover_days', 14)))
  SELECT format(E'📊 تقرير %s | وميض الضياء\nالمبيعات: %s | %s فاتورة | متوسط %s ر.س\nالأعلى: %s\n📦 تحت حد الطلب: %s أصناف (%s)\n💳 متأخرات +30 يوم: %s ر.س\n🟡 بانتظار قرارك: %s\n(المساعد الذكي غير متاح الآن، هذا تقرير آلي من الأرقام فقط)',
    (wameed.riyadh_today() - 1)::text,
    COALESCE((SELECT total_sales::text || ' ر.س' FROM y), 'غير متوفر'),
    COALESCE((SELECT invoice_count::text FROM y), '0'),
    COALESCE((SELECT round(total_sales / NULLIF(invoice_count, 0), 2)::text FROM y), '-'),
    COALESCE((SELECT string_agg(e->>'name', '، ') FROM (SELECT jsonb_array_elements(top_items) e FROM y LIMIT 3) t), '-'),
    (SELECT count(*) FROM ls),
    COALESCE((SELECT string_agg(name, '، ') FROM (SELECT name FROM ls LIMIT 5) t), '-'),
    (SELECT COALESCE(sum(balance), 0) FROM wameed.receivables WHERE COALESCE(due_date, invoice_date) < wameed.riyadh_today() - 30),
    (SELECT count(*) FROM wameed.actions WHERE status = 'pending')) $$;

-- ---------- الصحة: يعيد true إذا تغيّرت الحالة (للتنبيه مرة واحدة) ----------
CREATE OR REPLACE FUNCTION set_health(p_component text, p_ok boolean, p_detail text)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE prev boolean;
BEGIN
  SELECT ok INTO prev FROM wameed.health WHERE component = p_component;
  INSERT INTO wameed.health (component, ok, detail, checked_at, changed_at)
  VALUES (p_component, p_ok, p_detail, now(), now())
  ON CONFLICT (component) DO UPDATE
    SET ok = EXCLUDED.ok, detail = EXCLUDED.detail, checked_at = now(),
        changed_at = CASE WHEN wameed.health.ok = EXCLUDED.ok THEN wameed.health.changed_at ELSE now() END;
  IF prev IS DISTINCT FROM p_ok AND prev IS NOT NULL THEN
    PERFORM wameed.log_event(CASE WHEN p_ok THEN 'info' ELSE 'error' END, 'health',
                             p_component || CASE WHEN p_ok THEN ' عاد للعمل' ELSE ' متوقف: ' || COALESCE(p_detail, '') END);
    RETURN true;
  END IF;
  RETURN false;
END $$;

-- نص إشعار تيليجرام لطلب موافقة (يُبنى من البيانات لا من النموذج)
CREATE OR REPLACE FUNCTION approval_text(p_id bigint) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT format(E'🟡 طلب موافقة #%s\nالوكيل: %s\nالإجراء: %s\nالسبب: %s\n%s%s⏳ ينتهي تلقائيًا بالرفض: %s\n🔗 %s',
    a.id, COALESCE(ag.label_ar, a.agent), COALESCE(p.label_ar, a.type), COALESCE(a.reason, '-'),
    CASE WHEN a.type = 'create_purchase_order' THEN
           COALESCE((SELECT string_agg(format('• %s × %s = %s ر.س', l->>'name', l->>'qty',
                       round((l->>'qty')::numeric * (l->>'unit_price')::numeric, 2)), E'\n')
                     FROM jsonb_array_elements(a.payload->'lines') l), '') || E'\nالمورد: ' || COALESCE(a.payload->>'supplier', '-') || E'\n'
         WHEN a.type = 'update_item_prices' THEN
           COALESCE((SELECT string_agg(format('• %s: %s ← %s ر.س', i->>'name', i->>'price_current', i->>'price_proposed'), E'\n')
                     FROM jsonb_array_elements(a.payload->'items') i), '') || E'\n'
         WHEN a.payload ? 'text' THEN 'النص: ' || (a.payload->>'text') || E'\n'
         ELSE '' END,
    CASE WHEN p.counts_toward_cap THEN format(E'💰 الإجمالي: %s ر.س | المتبقي من سقف اليوم بعده: %s ر.س\n',
           a.total_sar, wameed.cfg_num('cap_daily', 10000) - wameed.cap_used_today() - a.total_sar) ELSE '' END,
    to_char(a.expires_at AT TIME ZONE 'Asia/Riyadh', 'HH24:MI'),
    COALESCE(wameed.cfg_text('dashboard_url'), '') || '#approvals')
  FROM wameed.actions a
  LEFT JOIN wameed.agents ag ON ag.name = a.agent
  LEFT JOIN wameed.action_policies p ON p.action_type = a.type
  WHERE a.id = p_id $$;

-- ---------- بحث الكتالوج لوكيل خدمة العملاء ----------
-- يطابق كلمات رسالة العميل (3 أحرف فأكثر) مع أسماء الأصناف، ولا يكشف الكمية.
CREATE OR REPLACE FUNCTION catalog_search(p_text text, p_limit int DEFAULT 5) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  WITH words AS (
    SELECT DISTINCT w FROM regexp_split_to_table(lower(COALESCE(p_text, '')), '[^[:alnum:]\u0600-\u06FF]+') w
     WHERE length(w) >= 3 AND w NOT IN ('عندكم','ابغى','ابي','ابغا','السلام','عليكم','كم','سعر','متوفر','الله','لو','سمحت')),
  scored AS (
    SELECT s.name, s.unit, s.price, s.qty_on_hand > 0 AS in_stock,
           (SELECT count(*) FROM words WHERE lower(s.name) LIKE '%' || words.w || '%'
                                           OR lower(s.name) LIKE '%' || regexp_replace(words.w, '^ال', '') || '%') AS score
      FROM wameed.stock_items s)
  SELECT COALESCE(jsonb_agg(jsonb_build_object('name', name, 'unit', unit, 'price', price, 'in_stock', in_stock)
                            ORDER BY score DESC, name), '[]')
    FROM (SELECT * FROM scored WHERE score > 0 ORDER BY score DESC, name LIMIT p_limit) t $$;

-- يستقبل رسالة واتساب واردة: يسجلها (مرة واحدة)، ويجهز سياق وكيل خدمة العملاء
CREATE OR REPLACE FUNCTION wa_inbound(p_chat_id text, p_text text, p_wa_id text) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE v_id bigint; v_first boolean; v_hist jsonb;
BEGIN
  SELECT NOT EXISTS (SELECT 1 FROM wameed.wa_messages WHERE chat_id = p_chat_id) INTO v_first;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('from', CASE direction WHEN 'in' THEN 'customer' ELSE 'store' END, 'text', text) ORDER BY ts), '[]')
    INTO v_hist FROM (SELECT * FROM wameed.wa_messages WHERE chat_id = p_chat_id ORDER BY ts DESC LIMIT 6) h;
  INSERT INTO wameed.wa_messages (chat_id, direction, text, wa_id) VALUES (p_chat_id, 'in', p_text, NULLIF(p_wa_id, ''))
  ON CONFLICT (wa_id) DO NOTHING RETURNING id INTO v_id;
  RETURN jsonb_build_object('fresh', v_id IS NOT NULL, 'chat_id', p_chat_id, 'customer_message', p_text,
                            'is_first_message', v_first, 'history', v_hist,
                            'catalog_results', wameed.catalog_search(p_text));
END $$;

-- نص المهمة اليدوية بعد الاعتماد (مثل إدخال أمر الشراء في Manager.io)
CREATE OR REPLACE FUNCTION manual_task_text(p_id bigint) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT format(E'✅ معتمد #%s (%s): نفّذه يدويًا%s\n%s',
    a.id, COALESCE(p.label_ar, a.type),
    CASE WHEN a.type IN ('create_purchase_order', 'update_item_prices') THEN ' في Manager.io' ELSE '' END,
    CASE WHEN a.type = 'create_purchase_order' THEN
           'المورد: ' || COALESCE(a.payload->>'supplier', '-') || E'\n' ||
           COALESCE((SELECT string_agg(format('• %s × %s بسعر %s', l->>'name', l->>'qty', l->>'unit_price'), E'\n')
                     FROM jsonb_array_elements(a.payload->'lines') l), '') || E'\nالإجمالي: ' || a.total_sar || ' ر.س'
         WHEN a.type = 'update_item_prices' THEN
           COALESCE((SELECT string_agg(format('• %s: %s ← %s ر.س', i->>'name', i->>'price_current', i->>'price_proposed'), E'\n')
                     FROM jsonb_array_elements(a.payload->'items') i), '')
         WHEN a.payload ? 'text' THEN a.payload->>'text'
         ELSE COALESCE(a.reason, '') END)
  FROM wameed.actions a LEFT JOIN wameed.action_policies p ON p.action_type = a.type
  WHERE a.id = p_id $$;
