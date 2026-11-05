// لوحة تحكم منظومة وميض الضياء
// خادم Node بلا إطار: يقرأ ويكتب في مخطط wameed على Postgres، ويطلب من n8n
// التشغيل والتنفيذ عبر webhooks داخلية. كل الحواجز في Postgres (wameed.gate_check).
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const env = process.env;
const PORT = Number(env.PORT || 8080);
const PASSWORD = env.DASHBOARD_PASSWORD || '';
const HOOK_TOKEN = env.WAMEED_HOOK_TOKEN || '';
const N8N_URL = (env.N8N_INTERNAL_URL || 'http://n8n:5678').replace(/\/$/, '');
const SECRET = crypto.createHash('sha256').update('wameed-dash|' + PASSWORD + '|' + HOOK_TOKEN).digest();
const SESSION_HOURS = 24 * 14;

if (!PASSWORD || PASSWORD.length < 8) {
  console.error('DASHBOARD_PASSWORD مطلوب (8 أحرف على الأقل)');
  process.exit(1);
}

const pool = new Pool({
  host: env.PGHOST || 'postgres', port: Number(env.PGPORT || 5432),
  database: env.PGDATABASE || 'n8n', user: env.PGUSER || 'wameed', password: env.PGPASSWORD,
  max: 5, idleTimeoutMillis: 30000,
});
const q = async (sql, params = []) => (await pool.query(sql, params)).rows;
const q1 = async (sql, params = []) => (await q(sql, params))[0];

// ---------- الجلسة ----------
function sign(exp) { return crypto.createHmac('sha256', SECRET).update(String(exp)).digest('base64url'); }
function makeCookie() {
  const exp = Date.now() + SESSION_HOURS * 3600e3;
  return `wsess=${exp}.${sign(exp)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}`;
}
function authed(req) {
  const m = /(?:^|;\s*)wsess=(\d+)\.([\w-]+)/.exec(req.headers.cookie || '');
  if (!m || Number(m[1]) < Date.now()) return false;
  const a = Buffer.from(m[2]), b = Buffer.from(sign(m[1]));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const fails = new Map(); // ip -> [timestamps]
function tooMany(ip) {
  const now = Date.now(), list = (fails.get(ip) || []).filter(t => now - t < 10 * 60e3);
  fails.set(ip, list);
  return list.length >= 5;
}

// ---------- أدوات ----------
function send(res, code, obj, headers = {}) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(obj));
}
function body(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 256e3) { reject(new Error('الطلب كبير جدًا')); req.destroy(); } });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { reject(new Error('JSON غير صالح')); } });
  });
}
async function fetchJson(url, opts = {}, ms = 5000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { ok: r.ok, status: r.status, json, text };
  } finally { clearTimeout(t); }
}
async function callN8n(hookPath, payload) {
  try {
    const r = await fetchJson(`${N8N_URL}/webhook/${hookPath}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-wameed-token': HOOK_TOKEN },
      body: JSON.stringify(payload),
    }, 15000);
    return r.ok ? { ok: true } : { ok: false, error: `n8n رد بـ ${r.status}` };
  } catch (e) { return { ok: false, error: 'n8n لا يرد: ' + e.message }; }
}

// ---------- الواجهات ----------
const routes = [];
const route = (method, re, fn) => routes.push({ method, re, fn });

route('GET', /^\/api\/overview$/, async () => {
  const [o] = await q(`
    SELECT wameed.cfg_bool('system_paused') AS paused, wameed.cfg_text('dry_run_until') AS dry_run_until,
           wameed.cfg_bool('shadow_mode') AS shadow_mode, wameed.cfg_num('cap_daily', 10000) AS cap_daily,
           wameed.cap_used_today() AS cap_used, wameed.riyadh_today()::text AS today,
           (SELECT count(*) FROM wameed.actions WHERE status = 'pending')::int AS pending,
           (SELECT count(*) FROM wameed.actions WHERE status = 'needs_manual')::int AS manual,
           (SELECT count(*) FROM wameed.agent_runs WHERE started_at > now() - interval '24 hours')::int AS runs_24h,
           (SELECT count(*) FROM wameed.agent_runs WHERE started_at > now() - interval '24 hours' AND status IN ('error','invalid_output'))::int AS errors_24h,
           (SELECT count(*) FROM wameed.actions WHERE created_at > now() - interval '24 hours' AND status = 'auto_rejected')::int AS blocked_24h,
           (SELECT to_jsonb(s) FROM wameed.sales_daily s WHERE day = wameed.riyadh_today() - 1) AS sales_yesterday,
           (SELECT to_jsonb(s) FROM wameed.sales_daily s WHERE day = wameed.riyadh_today() - 8) AS sales_week_ago,
           (SELECT count(*) FROM wameed.stock_items WHERE (reorder_level IS NOT NULL AND qty_on_hand <= reorder_level)
               OR (avg_daily_sales > 0 AND qty_on_hand / avg_daily_sales < wameed.cfg_num('reorder_cover_days', 14)))::int AS low_stock,
           (SELECT COALESCE(sum(balance), 0) FROM wameed.receivables WHERE COALESCE(due_date, invoice_date) < wameed.riyadh_today() - 30) AS overdue_30,
           (SELECT max(updated_at) FROM wameed.stock_items) AS stock_updated_at,
           (SELECT COALESCE(jsonb_agg(h ORDER BY component), '[]') FROM wameed.health h) AS health,
           (SELECT COALESCE(jsonb_agg(e ORDER BY e.id DESC), '[]') FROM (SELECT * FROM wameed.events ORDER BY id DESC LIMIT 8) e) AS events,
           wameed.cfg_text('ollama_url') AS ollama_url`);
  // فحص حي من اللوحة نفسها
  const live = {};
  try {
    const [tags, ps] = await Promise.all([fetchJson(o.ollama_url + '/api/tags'), fetchJson(o.ollama_url + '/api/ps')]);
    live.ollama = { ok: tags.ok, models: (tags.json?.models || []).map(m => m.name),
                    loaded: (ps.json?.models || []).map(m => ({ name: m.name, vram_gb: +(m.size_vram / 1e9).toFixed(1) })) };
  } catch (e) { live.ollama = { ok: false, error: e.message }; }
  try { live.n8n = { ok: (await fetchJson(N8N_URL + '/healthz')).ok }; } catch (e) { live.n8n = { ok: false, error: e.message }; }
  delete o.ollama_url;
  return { ...o, live };
});

route('GET', /^\/api\/agents$/, async () => q(`
  SELECT a.name, a.label_ar, a.description_ar, a.model, a.enabled, a.schedule, a.managed_by, a.output_kind, a.sort,
         r.status AS last_status, r.started_at AS last_at, r.summary AS last_summary, r.id AS last_run_id,
         (SELECT count(*) FROM wameed.agent_runs x WHERE x.agent = a.name AND x.started_at > now() - interval '7 days')::int AS runs_7d,
         (SELECT count(*) FROM wameed.agent_runs x WHERE x.agent = a.name AND x.started_at > now() - interval '7 days'
            AND x.status IN ('error','invalid_output'))::int AS errors_7d,
         (SELECT count(*) FROM wameed.actions x WHERE x.agent = a.name AND x.status = 'pending')::int AS pending
  FROM wameed.agents a
  LEFT JOIN LATERAL (SELECT * FROM wameed.agent_runs r WHERE r.agent = a.name ORDER BY started_at DESC LIMIT 1) r ON true
  ORDER BY a.sort, a.name`));

route('GET', /^\/api\/agents\/([\w-]+)$/, async (m) => {
  const a = await q1(`SELECT name, label_ar, description_ar, model, enabled, schedule, managed_by, output_kind, system_prompt, think, temperature, num_ctx
                      FROM wameed.agents WHERE name = $1`, [m[1]]);
  if (!a) throw Object.assign(new Error('وكيل غير موجود'), { code: 404 });
  return a;
});

route('PATCH', /^\/api\/agents\/([\w-]+)$/, async (m, b) => {
  const allowed = { enabled: 'boolean', schedule: 'string', model: 'string', system_prompt: 'string' };
  const sets = [], vals = [m[1]];
  for (const [k, t] of Object.entries(allowed)) {
    if (!(k in b)) continue;
    let v = b[k];
    if (k === 'schedule' && (v === '' || v === null)) v = null;
    else if (typeof v !== t) throw new Error('قيمة غير صالحة: ' + k);
    if (k === 'schedule' && v !== null && !/^(daily@\d{2}:\d{2}|weekly@(sat|sun|mon|tue|wed|thu|fri)@\d{2}:\d{2}|hourly@\d{1,2})$/.test(v))
      throw new Error('صيغة الموعد: daily@07:00 أو weekly@sat@03:00 أو hourly@15');
    vals.push(v); sets.push(`${k} = $${vals.length}`);
  }
  if (!sets.length) throw new Error('لا يوجد تعديل');
  const r = await q1(`UPDATE wameed.agents SET ${sets.join(', ')}, updated_at = now() WHERE name = $1 RETURNING name`, vals);
  if (!r) throw Object.assign(new Error('وكيل غير موجود'), { code: 404 });
  await q(`SELECT wameed.log_event('info', 'dashboard', 'تعديل وكيل ' || $1 || ': ' || $2)`, [m[1], Object.keys(b).join('، ')]);
  return { ok: true };
});

route('POST', /^\/api\/agents\/([\w-]+)\/run$/, async (m, b) => {
  const a = await q1(`SELECT name, managed_by, enabled FROM wameed.agents WHERE name = $1`, [m[1]]);
  if (!a) throw Object.assign(new Error('وكيل غير موجود'), { code: 404 });
  if (a.managed_by !== 'runner') throw new Error('هذا الوكيل يعمل من workflow خاص به');
  if (a.name === 'customer_service') throw new Error('خدمة العملاء تعمل عند وصول رسالة واتساب فقط');
  const extra = {};
  if (typeof b.owner_notes === 'string') extra.owner_notes = b.owner_notes.slice(0, 500);
  const r = await callN8n('wameed-run', { agent: a.name, trigger: 'dashboard', extra });
  if (!r.ok) throw new Error(r.error);
  return { ok: true, message: 'بدأ التشغيل، والنتيجة تظهر في السجل خلال دقيقة أو اثنتين' };
});

route('GET', /^\/api\/actions$/, async (m, b, url) => {
  const status = url.searchParams.get('status') || 'pending';
  const where = status === 'pending' ? `a.status = 'pending'`
              : status === 'manual' ? `a.status = 'needs_manual'`
              : `true`;
  return q(`
    SELECT a.id, a.agent, ag.label_ar AS agent_label, a.type, p.label_ar AS type_label, p.executor, a.reason, a.payload,
           a.total_sar, a.status, a.gate_reason, a.decided_via, a.created_at, a.expires_at, a.decided_at, a.executed_at, a.result,
           CASE WHEN a.status = 'pending' THEN wameed.approval_text(a.id) END AS preview
    FROM wameed.actions a
    LEFT JOIN wameed.agents ag ON ag.name = a.agent
    LEFT JOIN wameed.action_policies p ON p.action_type = a.type
    WHERE ${where}
    ORDER BY a.id DESC LIMIT 100`);
});

route('POST', /^\/api\/actions\/(\d+)\/decide$/, async (m, b) => {
  if (!['approve', 'reject'].includes(b.decision)) throw new Error('القرار: approve أو reject');
  let row;
  try { row = await q1(`SELECT * FROM wameed.decide_action($1, $2, 'dashboard', 'owner')`, [m[1], b.decision]); }
  catch (e) { throw new Error(e.message); }
  let exec = null;
  if (row.status === 'approved') exec = await callN8n('wameed-execute', { action_id: Number(m[1]) });
  return { ok: true, status: row.status, gate_reason: row.gate_reason, exec };
});

route('POST', /^\/api\/actions\/(\d+)\/done$/, async (m) => {
  // المالك أكّد أنه نفّذ المهمة اليدوية (مثل إدخال أمر الشراء في Manager.io)
  const r = await q1(`UPDATE wameed.actions SET status = 'executed', result = COALESCE(result, '{}') || '{"manual_done": true}'::jsonb
                      WHERE id = $1 AND status = 'needs_manual' RETURNING id`, [m[1]]);
  if (!r) throw new Error('ليست مهمة يدوية مفتوحة');
  return { ok: true };
});

route('GET', /^\/api\/runs$/, async (m, b, url) => {
  const agent = url.searchParams.get('agent');
  return q(`SELECT r.id, r.agent, a.label_ar AS agent_label, r.trigger, r.status, r.model, r.started_at, r.duration_ms,
                   r.summary, r.risks, r.missing_data, r.error,
                   (SELECT count(*) FROM wameed.actions x WHERE x.run_id = r.id)::int AS actions
            FROM wameed.agent_runs r LEFT JOIN wameed.agents a ON a.name = r.agent
            WHERE ($1::text IS NULL OR r.agent = $1)
            ORDER BY r.id DESC LIMIT 60`, [agent]);
});

route('GET', /^\/api\/runs\/(\d+)$/, async (m) => {
  const r = await q1(`SELECT * FROM wameed.agent_runs WHERE id = $1`, [m[1]]);
  if (!r) throw Object.assign(new Error('غير موجود'), { code: 404 });
  r.actions = await q(`SELECT id, type, status, gate_reason, total_sar FROM wameed.actions WHERE run_id = $1 ORDER BY id`, [m[1]]);
  return r;
});

route('GET', /^\/api\/events$/, async () => q(`SELECT * FROM wameed.events ORDER BY id DESC LIMIT 100`));

route('GET', /^\/api\/config$/, async () => ({
  config: await q(`SELECT key, value, label_ar, group_ar, sort, updated_at, updated_by FROM wameed.config ORDER BY sort, key`),
  policies: await q(`SELECT * FROM wameed.action_policies ORDER BY mode, action_type`),
}));

route('PUT', /^\/api\/config\/([\w-]+)$/, async (m, b) => {
  if (!('value' in b)) throw new Error('value مطلوب');
  const cur = await q1(`SELECT value FROM wameed.config WHERE key = $1`, [m[1]]);
  if (!cur) throw Object.assign(new Error('إعداد غير معروف'), { code: 404 });
  const typeOf = v => Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v;
  if (typeOf(cur.value) !== typeOf(b.value)) throw new Error('نوع القيمة يجب أن يبقى ' + typeOf(cur.value));
  if (typeof b.value === 'number' && (!(b.value >= 0) || !isFinite(b.value))) throw new Error('رقم غير صالح');
  await q(`SELECT wameed.set_config_value($1, $2::jsonb, 'dashboard')`, [m[1], JSON.stringify(b.value)]);
  return { ok: true };
});

route('POST', /^\/api\/pause$/, async (m, b) => {
  const paused = !!b.paused;
  await q(`SELECT wameed.set_config_value('system_paused', $1::jsonb, 'dashboard')`, [JSON.stringify(paused)]);
  callN8n('wameed-notify', { text: paused ? '⛔ أوقفت المنظومة من لوحة التحكم: لا تشغيل ولا تنفيذ حتى الاستئناف.' : '▶️ استُؤنفت المنظومة من لوحة التحكم.' });
  return { ok: true, paused };
});

route('GET', /^\/api\/data$/, async () => ({
  suppliers: await q(`SELECT * FROM wameed.suppliers ORDER BY whitelisted DESC, name`),
  stock: await q(`SELECT item_key, name, category, unit, qty_on_hand, reorder_level, avg_daily_sales, cost, price, preferred_supplier, updated_at
                  FROM wameed.stock_items ORDER BY name LIMIT 500`),
}));

route('PUT', /^\/api\/suppliers$/, async (m, b) => {
  if (!b.name || typeof b.name !== 'string') throw new Error('اسم المورد مطلوب');
  await q(`INSERT INTO wameed.suppliers (name, whitelisted, whatsapp, email, notes) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (name) DO UPDATE SET whitelisted = EXCLUDED.whitelisted, whatsapp = EXCLUDED.whatsapp,
             email = EXCLUDED.email, notes = EXCLUDED.notes`,
          [b.name.trim(), !!b.whitelisted, b.whatsapp || null, b.email || null, b.notes || null]);
  await q(`SELECT wameed.log_event('info', 'dashboard', 'تحديث مورد: ' || $1 || CASE WHEN $2 THEN ' (معتمد)' ELSE ' (غير معتمد)' END)`, [b.name, !!b.whitelisted]);
  return { ok: true };
});

// ---------- الملفات الثابتة ----------
const PUB = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
                '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUB, p));
  if (!file.startsWith(PUB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

const SEC_HEADERS = {
  'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'",
};

http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SEC_HEADERS)) res.setHeader(k, v);
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/healthz') return send(res, 200, { ok: true });
    if (url.pathname === '/api/login' && req.method === 'POST') {
      const ip = req.socket.remoteAddress;
      if (tooMany(ip)) return send(res, 429, { error: 'محاولات كثيرة، انتظر 10 دقائق' });
      const b = await body(req);
      const a = crypto.createHash('sha256').update(String(b.password || '')).digest();
      const c = crypto.createHash('sha256').update(PASSWORD).digest();
      if (!crypto.timingSafeEqual(a, c)) { fails.get(ip).push(Date.now()); return send(res, 401, { error: 'كلمة السر غير صحيحة' }); }
      return send(res, 200, { ok: true }, { 'set-cookie': makeCookie() });
    }
    if (url.pathname === '/api/logout') return send(res, 200, { ok: true }, { 'set-cookie': 'wsess=; Path=/; Max-Age=0' });
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url);
    if (!authed(req)) return send(res, 401, { error: 'سجّل الدخول' });
    if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'wameed') return send(res, 403, { error: 'طلب مرفوض' });
    for (const r of routes) {
      const m = r.method === req.method && r.re.exec(url.pathname);
      if (m) {
        const b = req.method === 'GET' ? {} : await body(req);
        return send(res, 200, await r.fn(m, b, url));
      }
    }
    send(res, 404, { error: 'غير موجود' });
  } catch (e) {
    send(res, e.code === 404 ? 404 : 400, { error: e.message || String(e) });
  }
}).listen(PORT, '0.0.0.0', () => console.log(`wameed dashboard on :${PORT}`));
