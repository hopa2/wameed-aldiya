#!/usr/bin/env python3
"""يبني ملفات workflows الخاصة بمنظومة وميض الضياء (n8n 2.x) في مجلد workflows/.

  python3 build_workflows.py

كل workflow له معرّف ثابت، فإعادة الاستيراد تحدّث نفس الـ workflow ولا تكرره.
الاتصال بين الـ workflows عبر webhooks داخلية (localhost:5678) محمية بترويسة سرية،
فلا تعتمد على معرّفات تتغير بعد الاستيراد.
"""
import json, os, uuid

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'workflows')

CRED_PG = {'postgres': {'id': 'wameedPostgres01', 'name': 'Wameed Postgres'}}
CRED_HOOK = {'httpHeaderAuth': {'id': 'wameedHookToken1', 'name': 'Wameed Hook Token'}}
CRED_WAHA = {'httpHeaderAuth': {'id': 'wameedWahaKey001', 'name': 'Wameed WAHA Key'}}
CRED_TG = {'telegramApi': {'id': 'wameedTelegram01', 'name': 'Wameed Telegram'}}
INTERNAL = 'http://localhost:5678/webhook/'


def uid(seed):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, 'wameed/' + seed))


class WF:
    def __init__(self, wid, name):
        self.id, self.name = wid, name
        self.nodes, self.conn, self.x = [], {}, 0

    def add(self, name, ntype, version, params, creds=None, pos=None, **extra):
        self.x += 240
        node = {'id': uid(self.id + name), 'name': name, 'type': ntype, 'typeVersion': version,
                'position': pos or [self.x, 300], 'parameters': params}
        if creds:
            node['credentials'] = creds
        node.update(extra)
        self.nodes.append(node)
        return name

    def link(self, src, dst, out=0):
        outs = self.conn.setdefault(src, {'main': []})['main']
        while len(outs) <= out:
            outs.append([])
        outs[out].append({'node': dst, 'type': 'main', 'index': 0})

    def chain(self, *names):
        for a, b in zip(names, names[1:]):
            self.link(a, b)

    def save(self):
        data = {'id': self.id, 'name': self.name, 'nodes': self.nodes, 'connections': self.conn,
                'active': False, 'pinData': {}, 'versionId': uid(self.id + 'v1'),
                'settings': {'executionOrder': 'v1', 'timezone': 'Asia/Riyadh',
                             'saveDataSuccessExecution': 'all', 'saveManualExecutions': True},
                'tags': []}
        path = os.path.join(OUT, self.id + '.json')
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        return path

    # ---- عقد شائعة ----
    def webhook(self, name, path, response='onReceived'):
        return self.add(name, 'n8n-nodes-base.webhook', 2,
                        {'httpMethod': 'POST', 'path': path, 'authentication': 'headerAuth',
                         'responseMode': response, 'options': {}},
                        CRED_HOOK, webhookId=uid('hook/' + path))

    def pg(self, name, query, params=None, **extra):
        p = {'operation': 'executeQuery', 'query': query, 'options': {}}
        if params:
            p['options']['queryReplacement'] = '={{ ' + params + ' }}'
        return self.add(name, 'n8n-nodes-base.postgres', 2.5, p, CRED_PG, **extra)

    def code(self, name, js, mode='runOnceForAllItems'):
        p = {'jsCode': js.strip()}
        if mode != 'runOnceForAllItems':
            p['mode'] = mode
        return self.add(name, 'n8n-nodes-base.code', 2, p)

    def http(self, name, url, body=None, method='POST', creds=None, timeout=30000, cont=True, **extra):
        p = {'method': method, 'url': url, 'options': {'timeout': timeout}}
        if creds:
            p.update({'authentication': 'genericCredentialType', 'genericAuthType': 'httpHeaderAuth'})
        if body:
            p.update({'sendBody': True, 'specifyBody': 'json', 'jsonBody': '={{ JSON.stringify(' + body + ') }}'})
        if cont:
            extra.setdefault('onError', 'continueRegularOutput')
        return self.add(name, 'n8n-nodes-base.httpRequest', 4.2, p, creds, **extra)

    def internal(self, name, path, body):
        return self.http(name, INTERNAL + path, body, creds=CRED_HOOK, timeout=60000)

    def switch(self, name, expr, n):
        return self.add(name, 'n8n-nodes-base.switch', 3.2,
                        {'mode': 'expression', 'numberOutputs': n, 'output': '={{ ' + expr + ' }}', 'options': {}})

    def schedule(self, name, minutes):
        return self.add(name, 'n8n-nodes-base.scheduleTrigger', 1.2,
                        {'rule': {'interval': [{'field': 'minutes', 'minutesInterval': minutes}]}})


# =====================================================================
# 1) تشغيل وكيل: /webhook/wameed-run
#    body: { agent, trigger?, input?, extra?, envelope? }
#    - input: بيانات جاهزة من workflow آخر (تُدمج فوق السياق المحسوب من Postgres)
#    - envelope: رد جاهز من وكيل خارجي (مثل وكيل الإعلانات) فيُسجل ويمر على البوابة بلا LLM
# =====================================================================
def wf_run():
    w = WF('wameedRunAgent01', 'وميض | تشغيل وكيل')
    hook = w.webhook('طلب تشغيل', 'wameed-run')
    req = w.code('قراءة الطلب', r"""
const b = $input.first().json.body || {};
if (!b.agent || typeof b.agent !== 'string') throw new Error('agent مطلوب');
return [{ json: {
  agent: b.agent,
  trigger: b.trigger || 'manual',
  input: (b.input && typeof b.input === 'object') ? b.input : null,
  extra: (b.extra && typeof b.extra === 'object') ? b.extra : {},
  envelope: (b.envelope && typeof b.envelope === 'object') ? b.envelope : null,
}}];
""")
    load = w.pg('تحميل الوكيل والسياق', """
SELECT a.name, a.label_ar, a.model, a.think, a.temperature, a.num_ctx, a.output_kind, a.system_prompt,
       a.managed_by, a.enabled,
       wameed.cfg_bool('system_paused') AS paused,
       wameed.cfg_text('constitution') AS constitution,
       wameed.cfg_text('ollama_url') AS ollama_url,
       wameed.agent_context(a.name, $2::jsonb) AS ctx
FROM wameed.agents a WHERE a.name = $1""", '[ $json.agent, $json.extra ]')
    build = w.code('بناء الاستدعاء', r"""
const req = $('قراءة الطلب').first().json;
const a = $input.first().json;
const out = { agent: a.name, label: a.label_ar, trigger: req.trigger, kind: a.output_kind, model: a.model };

if (req.envelope) return [{ json: { ...out, mode: 'ingest', model: 'external', envelope: req.envelope, input: req.input } }];
if (a.paused)   return [{ json: { ...out, mode: 'skip', why: 'النظام موقوف' } }];
if (!a.enabled) return [{ json: { ...out, mode: 'skip', why: 'الوكيل معطل من لوحة التحكم' } }];
if (a.managed_by !== 'runner') return [{ json: { ...out, mode: 'skip', why: 'وكيل خارجي: يرسل envelope فقط' } }];

const ctx = Object.assign({}, a.ctx || {}, req.input || {});

// يعوّض {{ $json.x }} و{{ JSON.stringify($json.x) }} و{{ $now... }} في نص الأمر
function render(tpl) {
  return String(tpl || '').replace(/\{\{\s*([^}]+?)\s*\}\}/g, (m, expr) => {
    let e = expr.trim(), stringify = false;
    const js = e.match(/^JSON\.stringify\((.+)\)$/);
    if (js) { e = js[1].trim(); stringify = true; }
    if (e.startsWith('$now')) return ctx.now || '';
    const p = e.match(/^\$json\.([\w.]+)$/);
    if (!p) return m;
    const v = p[1].split('.').reduce((o, k) => (o == null ? undefined : o[k]), ctx);
    if (v === undefined || v === null) return 'غير متوفر';
    return (stringify || typeof v === 'object') ? JSON.stringify(v) : String(v);
  });
}

const S = { type: 'string' };
const SCHEMAS = {
  envelope: { type: 'object', required: ['agent', 'status', 'summary', 'actions', 'risks', 'missing_data'],
    properties: { agent: S, status: { type: 'string', enum: ['ok', 'needs_data', 'paused', 'error'] }, summary: S,
      actions: { type: 'array', items: { type: 'object', required: ['type', 'needs_approval', 'reason', 'payload'],
        properties: { type: S, needs_approval: { type: 'boolean' }, reason: S, payload: { type: 'object' } } } },
      risks: { type: 'array', items: S }, missing_data: { type: 'array', items: S } } },
  whatsapp: { type: 'object', required: ['intent', 'confidence', 'escalate', 'escalate_reason', 'reply', 'owner_note'],
    properties: { intent: { type: 'string', enum: ['price', 'availability', 'hours', 'location', 'greeting', 'other'] },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] }, escalate: { type: 'boolean' },
      escalate_reason: S, reply: S, owner_note: S } },
  orchestrator: { type: 'object', required: ['reply_to_owner', 'approvals', 'followups'],
    properties: { reply_to_owner: S, approvals: { type: 'array', items: { type: 'object' } }, followups: { type: 'array', items: S } } },
};
const NOTE = {
  envelope: '',
  whatsapp: 'رسالة العميل الحالية في customer_message.',
  orchestrator: 'هذا موجز الصباح المجدول. تقارير الوكلاء جاهزة في agent_reports (اسم الوكيل ← ملخصه)، فلا تستدعِ أدوات؛ اكتب reply_to_owner منها فقط، واجعل approvals فارغة، وعدد الطلبات المنتظرة في pending_approvals.',
};

const system = [render(a.constitution), render(a.system_prompt)].filter(Boolean).join('\n\n');
const user = 'البيانات:\n' + JSON.stringify(ctx) + (NOTE[a.output_kind] ? '\n\n' + NOTE[a.output_kind] : '') + (a.think ? '' : ' /no_think');

return [{ json: { ...out, mode: 'llm', input: ctx, ollama_url: a.ollama_url, started: Date.now(),
  ollama_body: { model: a.model, stream: false, think: !!a.think, format: SCHEMAS[a.output_kind] || SCHEMAS.envelope,
    options: { num_ctx: a.num_ctx, temperature: Number(a.temperature) },
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }] } } }];
""")
    sw = w.switch('المسار', "({ llm: 0, ingest: 1, skip: 2 })[$json.mode]", 3)
    llm = w.http('Ollama', '={{ $json.ollama_url }}/api/chat', '$json.ollama_body', timeout=900000,
                 retryOnFail=True, maxTries=2, waitBetweenTries=5000)
    parse = w.code('تحليل الرد', r"""
const prep = $('بناء الاستدعاء').first().json;
const res = $input.first().json;
let envelope = null, error = null;
try {
  if (res.error) throw new Error('Ollama: ' + (res.error.message || JSON.stringify(res.error)).slice(0, 300));
  let txt = (res.message && res.message.content) || '';
  txt = txt.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^```(json)?|```$/g, '').trim();
  const o = JSON.parse(txt);
  if (prep.kind === 'whatsapp') {
    const chat = prep.input.chat_id;
    const info = ['price', 'availability', 'hours', 'location', 'greeting'].includes(o.intent);
    const actions = [];
    if (o.reply) actions.push({ type: 'whatsapp_reply', needs_approval: false, reason: 'رد على: ' + String(prep.input.customer_message || '').slice(0, 80),
      payload: { chat_id: chat, text: o.reply, intent: o.intent, confidence: o.confidence, customer_text: prep.input.customer_message,
                 auto_ok: !o.escalate && o.confidence === 'high' && info } });
    if (o.escalate) actions.push({ type: 'whatsapp_escalation', needs_approval: false, reason: o.escalate_reason || 'تحويل',
      payload: { chat_id: chat, owner_note: o.owner_note, customer_text: prep.input.customer_message } });
    envelope = { agent: prep.agent, status: 'ok', summary: (o.escalate ? '↪️ تحويل: ' + (o.owner_note || '') : '💬 ' + o.intent + ' / ' + o.confidence),
                 actions, risks: [], missing_data: [], raw: o };
  } else if (prep.kind === 'orchestrator') {
    envelope = { agent: prep.agent, status: 'ok', summary: o.reply_to_owner, risks: [], missing_data: [], raw: o,
                 actions: [{ type: 'notify_owner', needs_approval: false, reason: 'موجز الصباح', payload: { text: o.reply_to_owner } }] };
  } else {
    envelope = o;
    envelope.agent = prep.agent;
    if (!Array.isArray(envelope.actions)) envelope.actions = [];
  }
} catch (e) { error = String(e.message || e).slice(0, 500); }
return [{ json: { agent: prep.agent, trigger: prep.trigger, model: prep.model, kind: prep.kind,
  duration_ms: Date.now() - prep.started, input: prep.input, envelope, error } }];
""")
    ext = w.code('رد خارجي جاهز', r"""
const p = $input.first().json;
return [{ json: { agent: p.agent, trigger: p.trigger || 'external', model: 'external', kind: p.kind,
                  duration_ms: null, input: p.input || null, envelope: p.envelope, error: null } }];
""")
    ingest = w.pg('تسجيل + بوابة التنفيذ',
                  'SELECT wameed.ingest_run($1, $2, $3, $4::int, $5::jsonb, $6::jsonb, $7) AS r',
                  '[ $json.agent, $json.trigger, $json.model, $json.duration_ms ?? null, $json.input ?? null, $json.envelope ?? null, $json.error ?? null ]')
    follow = w.code('المتابعة', r"""
const r = $input.first().json.r;
const agent = r.agent;
const out = [];
for (const a of (r.actions || [])) {
  if (a.status === 'auto_approved') out.push({ json: { kind: 'execute', action_id: a.id } });
  if (a.status === 'pending') out.push({ json: { kind: 'pending', action_id: a.id } });
}
if (['error', 'invalid_output'].includes(r.status)) {
  if (agent === 'orchestrator') out.push({ json: { kind: 'fallback', action_id: null } });
  else out.push({ json: { kind: 'text', action_id: null, text: '⚠️ فشل تشغيل وكيل «' + agent + '» (#' + r.run_id + '). التفاصيل في لوحة التحكم.' } });
}
return out;
""")
    fsw = w.switch('نوع المتابعة', "$json.kind === 'execute' ? 0 : 1", 2)
    exe = w.internal('تنفيذ تلقائي', 'wameed-execute', '{ action_id: $json.action_id }')
    txt = w.pg('نص الإشعار', """
SELECT CASE $1 WHEN 'pending' THEN wameed.approval_text($2::bigint)
               WHEN 'fallback' THEN wameed.fallback_report()
               ELSE $3 END AS text""", "[ $json.kind, $json.action_id ?? 0, $json.text ?? '' ]")
    note = w.internal('إشعار المالك', 'wameed-notify', '{ text: $json.text }')
    skip = w.pg('تسجيل التخطي',
                "SELECT wameed.log_event('info', $1, 'تخطي التشغيل: ' || $2) AS ok", '[ $json.agent, $json.why ]')
    w.chain(hook, req, load, build, sw)
    w.link(sw, llm, 0); w.link(sw, ext, 1); w.link(sw, skip, 2)
    w.chain(llm, parse, ingest)
    w.link(ext, ingest)
    w.chain(ingest, follow, fsw)
    w.link(fsw, exe, 0); w.link(fsw, txt, 1)
    w.link(txt, note)
    return w.save()


# =====================================================================
# 2) التنفيذ: /webhook/wameed-execute  body: { action_id }
#    لا ينفّذ إلا إجراءً حالته approved أو auto_approved، ومرة واحدة فقط (claim_action).
# =====================================================================
def wf_execute():
    w = WF('wameedExecute001', 'وميض | تنفيذ إجراء معتمد')
    hook = w.webhook('طلب تنفيذ', 'wameed-execute')
    claim = w.pg('حجز الإجراء', """
SELECT c.*, wameed.cfg_text('waha_url') AS waha_url, wameed.cfg_text('waha_session') AS waha_session
FROM wameed.claim_action($1::bigint) c""", '[ $json.body.action_id ]')
    sw = w.switch('المنفّذ', "({ whatsapp: 0, telegram: 1, manual: 2 })[$json.executor] ?? 3", 4)
    # واتساب
    wa_prep = w.code('تجهيز رسالة واتساب', r"""
const a = $input.first().json;
const p = a.payload || {};
const chatId = p.chat_id || (String(p.to || '').replace(/\D/g, '') + '@c.us');
return [{ json: { ...a, chatId, text: p.text, delay: a.type === 'whatsapp_reply' ? 3 + Math.floor(Math.random() * 6) : 1 } }];
""")
    wait = w.add('تأخير طبيعي', 'n8n-nodes-base.wait', 1.1, {'amount': '={{ $json.delay }}', 'unit': 'seconds'},
                 webhookId=uid('wait/wa'))
    wa_send = w.http('WAHA إرسال', "={{ $json.waha_url }}/api/sendText",
                     "{ session: $json.waha_session, chatId: $json.chatId, text: $json.text }", creds=CRED_WAHA)
    wa_done = w.pg('إنهاء واتساب', 'SELECT (wameed.finish_action($1::bigint, $2, $3::jsonb)).id AS id',
                   "[ $('حجز الإجراء').first().json.id, $json.error ? 'failed' : 'executed', $json.error ? { error: String($json.error.message || $json.error) } : { sent: true, id: $json.id ?? null } ]")
    # تيليجرام
    tg_text = w.code('نص التنبيه', r"""
const a = $input.first().json;
const p = a.payload || {};
let text = p.text || '';
if (a.type === 'whatsapp_escalation') {
  const num = String(p.chat_id || '').replace(/@.*/, '');
  text = '📞 عميل يحتاجك على واتساب\n' + (p.owner_note || '') + '\nرسالته: ' + (p.customer_text || '') + '\nhttps://wa.me/' + num;
}
return [{ json: { ...a, text } }];
""")
    tg_send = w.internal('إرسال التنبيه', 'wameed-notify', '{ text: $json.text }')
    tg_done = w.pg('إنهاء التنبيه', 'SELECT (wameed.finish_action($1::bigint, $2, $3::jsonb)).id AS id',
                   "[ $('حجز الإجراء').first().json.id, $json.error ? 'failed' : 'executed', $json.error ? { error: String($json.error.message || $json.error) } : { notified: true } ]")
    # يدوي (Manager.io وغيره)
    man_txt = w.pg('نص المهمة اليدوية', 'SELECT wameed.manual_task_text($1::bigint) AS text', '[ $json.id ]')
    man_send = w.internal('إرسال المهمة', 'wameed-notify', '{ text: $json.text }')
    man_done = w.pg('إنهاء يدوي', """
SELECT (wameed.finish_action($1::bigint, 'needs_manual', '{"note":"بانتظار التنفيذ اليدوي"}'::jsonb)).id AS id,
       $2::text AS type""", "[ $('حجز الإجراء').first().json.id, $('حجز الإجراء').first().json.type ]")
    chain_po = w.code('أمر شراء؟ ← وكيل الموردين', r"""
const j = $input.first().json;
return j.type === 'create_purchase_order' ? [{ json: { action_id: j.id } }] : [];
""")
    sup = w.internal('تشغيل وكيل الموردين', 'wameed-run',
                     "{ agent: 'supplier_agent', trigger: 'chain', extra: { action_id: $json.action_id } }")
    # خارجي/غير ذلك
    ext_done = w.pg('إنهاء خارجي', "SELECT (wameed.finish_action($1::bigint, 'executed', '{\"by\":\"external\"}'::jsonb)).id AS id",
                    '[ $json.id ]')
    w.chain(hook, claim, sw)
    w.link(sw, wa_prep, 0); w.chain(wa_prep, wait, wa_send, wa_done)
    w.link(sw, tg_text, 1); w.chain(tg_text, tg_send, tg_done)
    w.link(sw, man_txt, 2); w.chain(man_txt, man_send, man_done, chain_po, sup)
    w.link(sw, ext_done, 3)
    return w.save()


# =====================================================================
# 3) الإشعار: /webhook/wameed-notify  body: { text }  ← تيليجرام المالك فقط
# =====================================================================
def wf_notify():
    w = WF('wameedNotify0001', 'وميض | إشعار المالك (تيليجرام)')
    hook = w.webhook('طلب إشعار', 'wameed-notify', response='lastNode')
    chat = w.pg('معرّف المالك', "SELECT wameed.cfg_text('owner_chat_id') AS chat_id, $1::text AS text",
                "[ String($json.body.text || '').slice(0, 4000) ]")
    sw = w.switch('معرّف موجود؟', "$json.chat_id && $json.text ? 0 : 1", 2)
    tg = w.add('تيليجرام', 'n8n-nodes-base.telegram', 1.2,
               {'chatId': '={{ $json.chat_id }}',
                'text': "={{ $json.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }}",
                'additionalFields': {'appendAttribution': False, 'disable_web_page_preview': True, 'parse_mode': 'HTML'}},
               CRED_TG, onError='continueRegularOutput')
    miss = w.pg('بلا معرّف', "SELECT wameed.log_event('warn', 'notify', 'لم يُرسل إشعار: owner_chat_id فارغ', jsonb_build_object('text', $1::text)) AS ok",
                '[ $json.text ]')
    w.chain(hook, chat, sw)
    w.link(sw, tg, 0); w.link(sw, miss, 1)
    return w.save()


# =====================================================================
# 4) المجدول: كل 5 دقائق ← الوكلاء المستحقون + انتهاء المهل
# =====================================================================
def wf_scheduler():
    w = WF('wameedScheduler1', 'وميض | المجدول (كل 5 دقائق)')
    t = w.schedule('كل 5 دقائق', 5)
    due = w.pg('الوكلاء المستحقون', 'SELECT * FROM wameed.claim_due_agents()')
    run = w.internal('تشغيل', 'wameed-run', "{ agent: $json.agent, trigger: 'schedule' }")
    exp = w.pg('انتهاء المهل', 'SELECT wameed.expire_actions() AS expired', pos=[480, 500])
    w.chain(t, due, run)
    w.link(t, exp)
    return w.save()


# =====================================================================
# 5) الصحة: كل 5 دقائق ← Ollama وWAHA، وتنبيه عند تغيّر الحالة فقط
# =====================================================================
def wf_health():
    w = WF('wameedHealth0001', 'وميض | فحص الصحة (كل 5 دقائق)')
    t = w.schedule('كل 5 دقائق', 5)
    cfg = w.pg('العناوين', """
SELECT wameed.cfg_text('ollama_url') AS ollama_url, wameed.cfg_text('waha_url') AS waha_url,
       wameed.cfg_text('waha_session') AS waha_session, wameed.cfg_text('healthchecks_url') AS hc_url""")
    ol = w.http('Ollama tags', "={{ $json.ollama_url }}/api/tags", method='GET', timeout=10000)
    wa = w.http('WAHA session', "={{ $('العناوين').first().json.waha_url }}/api/sessions/{{ $('العناوين').first().json.waha_session }}",
                method='GET', creds=CRED_WAHA, timeout=10000)
    calc = w.code('الحكم', r"""
const ol = $('Ollama tags').first().json;
const wa = $input.first().json;
const models = Array.isArray(ol.models) ? ol.models.map(m => m.name) : null;
return [{ json: {
  ollama_ok: !!models, ollama_detail: models ? models.join('، ') : String((ol.error && ol.error.message) || 'لا رد'),
  waha_ok: wa.status === 'WORKING', waha_detail: wa.status ? 'الجلسة: ' + wa.status : String((wa.error && wa.error.message) || 'لا رد'),
}}];
""")
    save = w.pg('حفظ الحالة', """
SELECT wameed.set_health('ollama', $1::boolean, $2) AS ollama_changed,
       wameed.set_health('waha', $3::boolean, $4) AS waha_changed,
       wameed.set_health('n8n', true, 'يعمل') AS n8n_changed,
       $1::boolean AS ollama_ok, $3::boolean AS waha_ok, $2 AS ollama_detail, $4 AS waha_detail,
       wameed.cfg_text('healthchecks_url') AS hc_url""",
                '[ $json.ollama_ok, $json.ollama_detail, $json.waha_ok, $json.waha_detail ]')
    msg = w.code('تنبيه التغيّر', r"""
const h = $input.first().json;
const lines = [];
if (h.ollama_changed) lines.push(h.ollama_ok ? '✅ Ollama (العقل المحلي) عاد للعمل' : '🚨 Ollama متوقف: الوكلاء لن يعملوا، وموجز الصباح سيصل بالقالب الثابت\n' + h.ollama_detail);
if (h.waha_changed) lines.push(h.waha_ok ? '✅ واتساب (WAHA) عاد للعمل' : '🚨 واتساب (WAHA) متوقف: ' + h.waha_detail);
return lines.length ? [{ json: { text: lines.join('\n\n') } }] : [];
""")
    note = w.internal('إشعار', 'wameed-notify', '{ text: $json.text }')
    hc = w.code('نبض؟', r"""
const h = $('حفظ الحالة').first().json;
return h.hc_url ? [{ json: { url: h.hc_url } }] : [];
""")
    ping = w.http('Healthchecks', '={{ $json.url }}', method='GET', timeout=10000)
    w.chain(t, cfg, ol, wa, calc, save, msg, note)
    w.link(save, hc); w.link(hc, ping)
    return w.save()


# =====================================================================
# 6) واتساب الوارد: /webhook/wameed-waha  (يُوجَّه إليه webhook جلسة WAHA)
# =====================================================================
def wf_whatsapp():
    w = WF('wameedWhatsApp01', 'وميض | واتساب الوارد ← خدمة العملاء')
    hook = w.webhook('رسالة من WAHA', 'wameed-waha')
    filt = w.code('تصفية', r"""
const e = $input.first().json.body || {};
const p = e.payload || {};
const from = String(p.from || '');
if (!['message', 'message.any'].includes(e.event) || p.fromMe) return [];
if (!from.endsWith('@c.us') && !from.endsWith('@s.whatsapp.net')) return [];   // لا مجموعات ولا حالات
const text = String(p.body || '').trim();
if (!text) return [];
return [{ json: { chat_id: from, text: text.slice(0, 1000), wa_id: String(p.id || '') } }];
""")
    ctx = w.pg('تسجيل + سياق', 'SELECT wameed.wa_inbound($1, $2, $3) AS c', '[ $json.chat_id, $json.text, $json.wa_id ]')
    fresh = w.code('جديدة؟', r"""
const c = $input.first().json.c;
return c.fresh ? [{ json: c }] : [];
""")
    run = w.internal('تشغيل خدمة العملاء', 'wameed-run',
                     "{ agent: 'customer_service', trigger: 'whatsapp', input: { chat_id: $json.chat_id, customer_message: $json.customer_message, is_first_message: $json.is_first_message, history: $json.history, catalog_results: $json.catalog_results } }")
    w.chain(hook, filt, ctx, fresh, run)
    return w.save()


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    for f in (wf_run, wf_execute, wf_notify, wf_scheduler, wf_health, wf_whatsapp):
        print(f())
