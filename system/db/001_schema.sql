-- ============================================================
-- منظومة وميض الضياء: مخطط قاعدة البيانات (Postgres 16)
-- يعمل داخل قاعدة n8n الموجودة نفسها، في مخطط منفصل اسمه wameed،
-- فلا يلمس جداول n8n، ويدخل تلقائيًا في نسخة pg_dump الليلية.
-- آمن للتشغيل أكثر من مرة (IF NOT EXISTS في كل مكان).
-- ============================================================

CREATE SCHEMA IF NOT EXISTS wameed;
SET search_path = wameed, public;

-- ---------- الإعدادات (بديل عقدة CONFIG، تُعدّل من لوحة التحكم) ----------
CREATE TABLE IF NOT EXISTS config (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  label_ar    text,
  group_ar    text DEFAULT 'عام',
  sort        int  DEFAULT 100,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);

-- ---------- الوكلاء ----------
CREATE TABLE IF NOT EXISTS agents (
  name           text PRIMARY KEY,                 -- sales_agent ...
  label_ar       text NOT NULL,
  description_ar text,
  model          text NOT NULL DEFAULT 'qwen3:8b',
  think          boolean NOT NULL DEFAULT false,
  temperature    numeric NOT NULL DEFAULT 0.3,
  num_ctx        int NOT NULL DEFAULT 16384,
  output_kind    text NOT NULL DEFAULT 'envelope'
                 CHECK (output_kind IN ('envelope','whatsapp','orchestrator')),
  system_prompt  text,                             -- الأمر الخاص بالوكيل (بدون الدستور)
  managed_by     text NOT NULL DEFAULT 'runner'
                 CHECK (managed_by IN ('runner','external')),  -- external = workflow خاص (وكيل الإعلانات)
  enabled        boolean NOT NULL DEFAULT true,
  schedule       text,                             -- daily@07:00 | weekly@sat@03:00 | NULL
  sort           int NOT NULL DEFAULT 100,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- ---------- سياسة كل نوع إجراء (الحاجز الحقيقي، لا البرومبت) ----------
CREATE TABLE IF NOT EXISTS action_policies (
  action_type       text PRIMARY KEY,
  label_ar          text NOT NULL,
  mode              text NOT NULL CHECK (mode IN ('auto','approval','forbidden','conditional')),
  executor          text NOT NULL CHECK (executor IN ('whatsapp','telegram','manual','external','none')),
  allowed_agents    text[] NOT NULL DEFAULT '{}',
  counts_toward_cap boolean NOT NULL DEFAULT false,
  note_ar           text
);

-- ---------- سجل التشغيل ----------
CREATE TABLE IF NOT EXISTS agent_runs (
  id           bigserial PRIMARY KEY,
  agent        text NOT NULL REFERENCES agents(name) ON UPDATE CASCADE,
  trigger      text NOT NULL DEFAULT 'manual',     -- schedule | dashboard | telegram | whatsapp | external | manual
  status       text NOT NULL CHECK (status IN ('ok','needs_data','paused','error','invalid_output')),
  model        text,
  started_at   timestamptz NOT NULL DEFAULT now(),
  duration_ms  int,
  summary      text,
  risks        jsonb NOT NULL DEFAULT '[]',
  missing_data jsonb NOT NULL DEFAULT '[]',
  input        jsonb,
  envelope     jsonb,
  error        text
);
CREATE INDEX IF NOT EXISTS agent_runs_agent_idx ON agent_runs (agent, started_at DESC);

-- ---------- الإجراءات المقترحة ومسارها في البوابة ----------
CREATE TABLE IF NOT EXISTS actions (
  id           bigserial PRIMARY KEY,
  run_id       bigint REFERENCES agent_runs(id) ON DELETE SET NULL,
  agent        text NOT NULL,
  type         text NOT NULL,
  reason       text,
  payload      jsonb NOT NULL DEFAULT '{}',
  total_sar    numeric(12,2) NOT NULL DEFAULT 0,
  status       text NOT NULL CHECK (status IN (
                 'pending',        -- بانتظار قرارك
                 'auto_approved',  -- معتمد آليًا ضمن السقوف
                 'approved',       -- اعتمدته أنت
                 'rejected',       -- رفضته أنت
                 'auto_rejected',  -- رفضته البوابة (حاجز)
                 'expired',        -- انتهت المهلة = رفض
                 'dry_run',        -- فترة التجربة: سُجل فقط
                 'executing',
                 'executed',
                 'failed',
                 'needs_manual'    -- معتمد، وينفذه شخص يدويًا (مثل Manager.io)
               )),
  gate_reason  text,
  decided_via  text,               -- auto | dashboard | telegram | system
  decided_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz,
  decided_at   timestamptz,
  executed_at  timestamptz,
  result       jsonb
);
CREATE INDEX IF NOT EXISTS actions_status_idx ON actions (status, created_at DESC);

-- ---------- السجل العام والصحة ----------
CREATE TABLE IF NOT EXISTS events (
  id      bigserial PRIMARY KEY,
  ts      timestamptz NOT NULL DEFAULT now(),
  level   text NOT NULL DEFAULT 'info' CHECK (level IN ('info','warn','error')),
  source  text NOT NULL,
  message text NOT NULL,
  data    jsonb
);
CREATE INDEX IF NOT EXISTS events_ts_idx ON events (ts DESC);

CREATE TABLE IF NOT EXISTS health (
  component  text PRIMARY KEY,     -- ollama | waha | n8n | manager
  ok         boolean NOT NULL,
  detail     text,
  checked_at timestamptz NOT NULL DEFAULT now(),
  changed_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- بيانات النشاط (تملؤها مزامنة Manager.io أو أي مصدر) ----------
CREATE TABLE IF NOT EXISTS sales_daily (
  day           date PRIMARY KEY,
  total_sales   numeric(12,2) NOT NULL DEFAULT 0,
  invoice_count int NOT NULL DEFAULT 0,
  top_items     jsonb NOT NULL DEFAULT '[]',     -- [{name, qty, total}]
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stock_items (
  item_key           text PRIMARY KEY,
  name               text NOT NULL,
  category           text NOT NULL DEFAULT 'other'
                     CHECK (category IN ('plumbing','electrical','paints','building','other')),
  unit               text,
  qty_on_hand        numeric NOT NULL DEFAULT 0,
  reorder_level      numeric,
  avg_daily_sales    numeric,                       -- متوسط آخر 28 يومًا
  cost               numeric(12,2),
  prev_cost          numeric(12,2),                 -- التكلفة السابقة (لوكيل التسعير)
  price              numeric(12,2),
  preferred_supplier text,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS suppliers (
  name        text PRIMARY KEY,
  whitelisted boolean NOT NULL DEFAULT false,
  whatsapp    text,
  email       text,
  notes       text
);

CREATE TABLE IF NOT EXISTS receivables (
  invoice_ref  text PRIMARY KEY,
  customer     text NOT NULL,
  balance      numeric(12,2) NOT NULL,
  invoice_date date,
  due_date     date,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shifts (
  id        bigserial PRIMARY KEY,
  employee  text NOT NULL,
  day       date NOT NULL,
  start_at  time NOT NULL,
  end_at    time NOT NULL,
  note      text
);

-- رسائل واتساب (لسجل المحادثة وحد الرسائل في الساعة)
CREATE TABLE IF NOT EXISTS wa_messages (
  id        bigserial PRIMARY KEY,
  chat_id   text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('in','out')),
  text      text,
  ts        timestamptz NOT NULL DEFAULT now(),
  wa_id     text UNIQUE
);
CREATE INDEX IF NOT EXISTS wa_messages_chat_idx ON wa_messages (chat_id, ts DESC);

CREATE TABLE IF NOT EXISTS staff (
  name           text PRIMARY KEY,
  role           text,                 -- كاشير | مستودع | ...
  available_days text[] NOT NULL DEFAULT '{sat,sun,mon,tue,wed,thu,fri}',
  leaves         jsonb NOT NULL DEFAULT '[]'
);

-- أرقام مالية مفردة: cash_balance, bank_balance, payables_due_7d
CREATE TABLE IF NOT EXISTS kv_metrics (
  key        text PRIMARY KEY,
  value      numeric(14,2) NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- يمنع تشغيل الموعد نفسه مرتين
CREATE TABLE IF NOT EXISTS schedule_claims (
  agent text NOT NULL,
  slot  timestamptz NOT NULL,
  PRIMARY KEY (agent, slot)
);
