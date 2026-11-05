// لوحة تحكم وميض الضياء: طبقة فوق المنظومة الموجودة على اللابتوب.
// لا تملك بوابة ولا وكلاء خاصين بها. تقرأ وتكتب في الجداول التي تستخدمها
// workflows الموجودة أصلًا، وبنفس الصيغة التي تكتب بها:
//   قاعدة wameed_ads (نفس Credential «Postgres wameed_ads» التي تستخدمها الـ workflows):
//       biz_state, biz_guardrails, biz_approvals, biz_audit_log, biz_manager_snapshots (منظومة المحل)
//       ads_runs, ads_actions, ads_state (وكيل الإعلانات)
//   قاعدة n8n: workflow_entity / execution_entity (حالة كل workflow، قراءة فقط)
// وتفحص حيًا: n8n وOllama وWAHA وManager.io.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const env = process.env;
const PORT = Number(env.PORT || 8080);
const PASSWORD = env.DASHBOARD_PASSWORD || '';
const N8N_URL = (env.N8N_INTERNAL_URL || 'http://n8n:5678').replace(/\/$/, '');
const OLLAMA_URL = (env.OLLAMA_URL || 'http://host.docker.internal:11434').replace(/\/$/, '');
const WAHA_URL = (env.WAHA_URL || 'http://waha:3000').replace(/\/$/, '');
const WAHA_KEY = env.WAHA_API_KEY || '';
const MANAGER_URL = (env.MANAGER_URL || 'http://100.95.125.96:55668').replace(/\/$/, '');
// «موافقة» اللوحة تمرّ عبر workflow «SYS - Dashboard Approve» إلى SYS - Approval Gate نفسها
const GATE_TOKEN = env.WAMEED_DASH_TOKEN || '';
const GATE_HOOK = GATE_TOKEN.length >= 20 ? (env.GATE_APPROVE_WEBHOOK || N8N_URL + '/webhook/wameed-dash-approve') : '';
const SECRET = crypto.createHash('sha256').update('wameed-dash|' + PASSWORD + '|' + (env.PGPASSWORD || '')).digest();
const SESSION_HOURS = 24 * 14;

if (!PASSWORD || PASSWORD.length < 8) {
  console.error('DASHBOARD_PASSWORD مطلوب (8 أحرف على الأقل)');
  process.exit(1);
}

const pgBase = { host: env.PGHOST || 'postgres', port: Number(env.PGPORT || 5432), user: env.PGUSER || 'wameed',
                 password: env.PGPASSWORD, max: 4, idleTimeoutMillis: 30000 };
const n8nDb = new Pool({ ...pgBase, database: env.N8N_PGDATABASE || 'n8n' });
const bizDb = new Pool({ ...pgBase, database: env.BIZ_PGDATABASE || 'wameed_ads' });
const adsDb = (env.ADS_PGDATABASE || 'wameed_ads') === (env.BIZ_PGDATABASE || 'wameed_ads') ? bizDb
            : new Pool({ ...pgBase, database: env.ADS_PGDATABASE });
for (const p of new Set([n8nDb, bizDb, adsDb])) p.on('error', e => console.error('pg:', e.message));
const q = async (sql, params = []) => (await bizDb.query(sql, params)).rows;   // biz_*
const qa = async (sql, params = []) => (await adsDb.query(sql, params)).rows;  // ads_*
const qn = async (sql, params = []) => (await n8nDb.query(sql, params)).rows;  // n8n نفسه
// الجداول قد لا تكون موجودة بعد (مثلًا لم يعمل workflow معين قط): نعيد null بدل إسقاط الصفحة كلها
const soft = (p) => p.catch(e => ({ error: e.message }));

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
const fails = new Map();
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
    req.on('data', c => { b += c; if (b.length > 64e3) { reject(new Error('الطلب كبير جدًا')); req.destroy(); } });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { reject(new Error('JSON غير صالح')); } });
  });
}
async function fetchJson(url, opts = {}, ms = 4000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { ok: r.ok, status: r.status, json };
  } finally { clearTimeout(t); }
}
const errMsg = (e) => e.name === 'AbortError' ? 'لا يرد (انتهت المهلة)' : (e.cause?.code || e.cause?.message || e.message);

// ---------- الفحص الحي (مخزن 20 ثانية حتى لا نثقل الأجهزة) ----------
let liveCache = { at: 0, data: null };
async function live() {
  if (Date.now() - liveCache.at < 20e3 && liveCache.data) return liveCache.data;
  const check = async (fn) => { try { return await fn(); } catch (e) { return { ok: false, detail: errMsg(e) }; } };
  const [n8n, ollama, waha, manager] = await Promise.all([
    check(async () => { const r = await fetchJson(N8N_URL + '/healthz'); return { ok: r.ok, detail: r.ok ? '' : 'رد ' + r.status }; }),
    check(async () => {
      const [tags, ps] = await Promise.all([fetchJson(OLLAMA_URL + '/api/tags'), fetchJson(OLLAMA_URL + '/api/ps')]);
      const loaded = (ps.json?.models || []).map(m => `${m.name} (${(m.size_vram / 1e9).toFixed(1)}GB)`);
      const models = (tags.json?.models || []).map(m => m.name);
      return { ok: tags.ok, detail: loaded.length ? 'في الذاكرة: ' + loaded.join('، ') : 'مثبت: ' + models.join('، ') };
    }),
    check(async () => {
      const r = await fetchJson(WAHA_URL + '/api/sessions?all=true', { headers: WAHA_KEY ? { 'x-api-key': WAHA_KEY } : {} });
      if (r.status === 401) return { ok: false, detail: 'WAHA يعمل لكن المفتاح غير صحيح (WAHA_API_KEY)' };
      const s = Array.isArray(r.json) ? r.json : [];
      const working = s.filter(x => x.status === 'WORKING');
      return { ok: r.ok && working.length > 0,
               detail: s.length ? s.map(x => `${x.name}: ${x.status}`).join('، ') : (r.ok ? 'لا توجد جلسة واتساب' : 'رد ' + r.status) };
    }),
    // أي رد HTTP يعني أن Manager.io يعمل على جهاز المحل (لا نرسل مفتاح الـ API من هنا)
    // /api2/ بلا مفتاح يرد 401 فورًا، ولا نتبع أي تحويل (الصفحة الرئيسية قد تحوّل إلى localhost على جهاز المحل)
    check(async () => {
      try {
        const r = await fetchJson(MANAGER_URL + '/api2/', { redirect: 'manual' }, 8000);
        return { ok: true, detail: 'جهاز المحل يرد (' + r.status + ')' };
      } catch (e) {
        // اللوحة لا تصل مباشرة؟ نعتمد على آخر لقطة نجحت فيها n8n بقراءة Manager
        const s = await q(`SELECT max(taken_at) AS at FROM biz_manager_snapshots`).catch(() => []);
        const at = s[0]?.at;
        if (at && Date.now() - new Date(at) < 3 * 3600e3)
          return { ok: true, detail: 'n8n قرأ منه آخر لقطة ' + new Date(at).toLocaleTimeString('ar-SA-u-nu-latn', { timeZone: 'Asia/Riyadh', hour: '2-digit', minute: '2-digit' }) + ' (اللوحة نفسها لا تصله: ' + errMsg(e) + ')' };
        return { ok: false, detail: errMsg(e) + (at ? ' · آخر لقطة ناجحة من n8n ' + new Date(at).toISOString().slice(0, 16).replace('T', ' ') : '') };
      }
    }),
  ]);
  liveCache = { at: Date.now(), data: { n8n, ollama, waha, manager } };
  return liveCache.data;
}

// ---------- القراءة ----------
const isTrue = (v) => v === true || v === 'true' || v === '"true"';

async function pausedState() {
  const [biz, ads] = await Promise.all([
    soft(q(`SELECT value::text AS v FROM biz_state WHERE key = 'system_paused'`)),
    soft(qa(`SELECT value::text AS v FROM ads_state WHERE key = 'system_paused'`)),
  ]);
  return { biz: Array.isArray(biz) ? isTrue(biz[0]?.v) : null, ads: Array.isArray(ads) ? isTrue(ads[0]?.v) : null };
}

const routes = [];
const route = (method, re, fn) => routes.push({ method, re, fn });

route('GET', /^\/api\/overview$/, async () => {
  const [paused, liveData, biz, ads, wf, snaps] = await Promise.all([
    pausedState(),
    live(),
    soft(q(`
      SELECT (SELECT count(*) FROM biz_approvals WHERE status = 'pending' AND now() <= expires_at)::int AS pending,
             (SELECT COALESCE(json_object_agg(status, n), '{}') FROM (SELECT status, count(*) n FROM biz_approvals
                 WHERE created_at > now() - interval '24 hours' GROUP BY status) t) AS last24,
             (SELECT COALESCE(sum(amount), 0) FROM biz_approvals WHERE status = 'executed' AND action_type = 'purchase_order'
                 AND executed_at > now() - interval '7 days') AS po7d,
             (SELECT COALESCE(sum(amount), 0) FROM biz_approvals WHERE status = 'executed' AND action_type = 'purchase_order'
                 AND executed_at::date = now()::date) AS po_today,
             (SELECT value::text FROM biz_guardrails WHERE key = 'po_max_per_day') AS po_max_per_day`)),
    soft(qa(`
      SELECT (SELECT to_json(r) FROM (SELECT run_id, run_type, status, dry_run, started_at, summary FROM ads_runs ORDER BY run_id DESC LIMIT 1) r) AS last_run,
             (SELECT COALESCE(json_object_agg(status, n), '{}') FROM (SELECT status, count(*) n FROM ads_actions
                 WHERE created_at > now() - interval '7 days' GROUP BY status) t) AS actions7d`)),
    soft(qn(`
      SELECT count(*) FILTER (WHERE w.active)::int AS active, count(*)::int AS total,
             (SELECT count(*) FROM execution_entity e WHERE e."startedAt" > now() - interval '24 hours' AND e."deletedAt" IS NULL)::int AS runs24,
             (SELECT count(*) FROM execution_entity e WHERE e."startedAt" > now() - interval '24 hours' AND e."deletedAt" IS NULL
                 AND e.status IN ('error', 'crashed'))::int AS errors24
      FROM workflow_entity w WHERE NOT COALESCE(w."isArchived", false)`)),
    soft(q(`SELECT DISTINCT ON (resource) resource, records, taken_at FROM biz_manager_snapshots ORDER BY resource, taken_at DESC`)),
  ]);
  const events = await recentEvents(8);
  return { paused, live: liveData, biz: biz[0] || biz, ads: ads[0] || ads, workflows: wf[0] || wf, snapshots: snaps, events };
});

async function recentEvents(limit) {
  const [a, b] = await Promise.all([
    soft(q(`SELECT 'biz' AS src, l.at, l.agent, l.event, l.approval_id, a.summary
            FROM biz_audit_log l LEFT JOIN biz_approvals a ON a.id = l.approval_id ORDER BY l.id DESC LIMIT $1`, [limit])),
    soft(qa(`SELECT 'ads' AS src, created_at AS at, source AS agent, action_type || ':' || status AS event, action_id AS approval_id,
                    left(COALESCE(reason, reject_reason, ''), 300) AS summary
             FROM ads_actions ORDER BY action_id DESC LIMIT $1`, [limit])),
  ]);
  return [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]
    .sort((x, y) => new Date(y.at) - new Date(x.at)).slice(0, limit);
}

route('GET', /^\/api\/events$/, async () => recentEvents(100));

route('GET', /^\/api\/approvals$/, async () => {
  await q(`UPDATE biz_approvals SET status = 'expired' WHERE status = 'pending' AND now() > expires_at`); // نفس ما يفعله /pending
  return {
    pending: await q(`SELECT id, agent, action_type, summary, payload, amount, created_at, expires_at
                      FROM biz_approvals WHERE status = 'pending' ORDER BY id`),
    recent: await q(`SELECT id, agent, action_type, summary, amount, status, created_at, decided_at, executed_at, result
                     FROM biz_approvals WHERE status <> 'pending' ORDER BY id DESC LIMIT 40`),
    can_approve: !!GATE_HOOK,
  };
});

// الرفض: نفس استعلام «Save Decision» في SYS - Approval Gate حرفيًا
route('POST', /^\/api\/approvals\/(\d+)\/reject$/, async (m) => {
  const r = await q(`
    WITH u AS (UPDATE biz_approvals SET status = $2, decided_at = now() WHERE id = $1 AND status = 'pending' RETURNING id)
    INSERT INTO biz_audit_log (agent, event, approval_id, details)
    SELECT 'gate', 'decision:' || $2, $1, $3::jsonb FROM u RETURNING approval_id`,
    [Number(m[1]), 'rejected', JSON.stringify({ via: 'dashboard' })]);
  if (!r.length) throw new Error('الطلب لم يعد بانتظار القرار');
  return { ok: true };
});

// الموافقة: لا ننفّذ شيئًا هنا. نمرّرها إلى البوابة الموجودة لتطبّق حواجزها وتنفّذ في Manager.io كما تفعل مع زر تيليجرام.
route('POST', /^\/api\/approvals\/(\d+)\/approve$/, async (m) => {
  if (!GATE_HOOK) throw new Error('الموافقة من زر تيليجرام حاليًا، حتى يُربط زر اللوحة بالبوابة');
  const id = Number(m[1]);
  const row = (await q(`SELECT status, now() > expires_at AS expired FROM biz_approvals WHERE id = $1`, [id]))[0];
  if (!row || row.status !== 'pending' || row.expired) throw new Error('الطلب لم يعد بانتظار القرار');
  const r = await fetchJson(GATE_HOOK, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-wameed-token': GATE_TOKEN },
    body: JSON.stringify({ approval_id: id, decision: 'approved', via: 'dashboard' }),
  }, 30000).catch(e => ({ ok: false, status: errMsg(e) }));
  if (!r.ok) throw new Error('البوابة لم تستلم الموافقة: ' + r.status);
  // البوابة قد تعتمد وتنفّذ، أو تحجب الطلب لتجاوز السقف، أو ترفض لأن المنظومة موقوفة: نعيد ما قررته هي
  const after = (await q(`SELECT status, result FROM biz_approvals WHERE id = $1`, [id]))[0] || {};
  return { ok: true, status: after.status, result: after.result };
});

route('GET', /^\/api\/workflows$/, async () => qn(`
  SELECT w.id, w.name, w.active, w.description, w."updatedAt" AS updated_at,
         e.status AS last_status, e."startedAt" AS last_at, e.mode AS last_mode,
         s.runs7, s.errors7
  FROM workflow_entity w
  LEFT JOIN LATERAL (SELECT status, "startedAt", mode FROM execution_entity x
                     WHERE x."workflowId" = w.id AND x."deletedAt" IS NULL ORDER BY x.id DESC LIMIT 1) e ON true
  LEFT JOIN LATERAL (SELECT count(*)::int AS runs7, count(*) FILTER (WHERE status IN ('error', 'crashed'))::int AS errors7
                     FROM execution_entity x WHERE x."workflowId" = w.id AND x."startedAt" > now() - interval '7 days') s ON true
  WHERE NOT COALESCE(w."isArchived", false)
  ORDER BY w.name`));

route('GET', /^\/api\/ads$/, async () => {
  const [runs, actions, state] = await Promise.all([
    qa(`SELECT run_id, run_type, status, dry_run, started_at, finished_at, left(summary, 1500) AS summary, left(error, 500) AS error
        FROM ads_runs ORDER BY run_id DESC LIMIT 30`),
    qa(`SELECT action_id, run_id, created_at, action_type, payload, reason, source, status, reject_reason, undone_at
        FROM ads_actions ORDER BY action_id DESC LIMIT 60`),
    qa(`SELECT key, left(value::text, 200) AS value, updated_at FROM ads_state ORDER BY key`),
  ]);
  return { runs, actions, state: state.filter(s => !/token|secret|key|password|update/i.test(s.key)) };
});

route('GET', /^\/api\/guardrails$/, async () => q(`SELECT key, value::text AS value FROM biz_guardrails ORDER BY key`));

route('PUT', /^\/api\/guardrails\/([\w.-]+)$/, async (m, b) => {
  const v = Number(b.value);
  if (!isFinite(v) || v < 0) throw new Error('القيمة يجب أن تكون رقمًا موجبًا');
  const cur = (await q(`SELECT value::text AS value FROM biz_guardrails WHERE key = $1`, [m[1]]))[0];
  if (!cur) throw Object.assign(new Error('حاجز غير معروف'), { code: 404 });
  // نُبقي صيغة القيمة كما هي في الجدول (نص أو رقم أو JSON)، فالـ workflows تقرؤها بـ value::text::int
  await q(`UPDATE biz_guardrails SET value = $2 WHERE key = $1`, [m[1], String(v)]);
  await q(`INSERT INTO biz_audit_log (agent, event, details) VALUES ('dashboard', 'guardrail:' || $1, $2::jsonb)`,
          [m[1], JSON.stringify({ from: cur.value, to: v })]);
  return { ok: true };
});

// الإيقاف: نفس ما يكتبه أمر /stop في تيليجرام (BIZ)، ونفس مفتاح وكيل الإعلانات (ADS)
route('POST', /^\/api\/pause$/, async (m, b) => {
  const paused = !!b.paused;
  const which = ['biz', 'ads', 'all'].includes(b.system) ? b.system : 'all';
  if (which !== 'ads') {
    await q(`INSERT INTO biz_state (key, value, updated_at) VALUES ('system_paused', $1, now())
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [paused ? 'true' : 'false']);
    await q(`INSERT INTO biz_audit_log (agent, event, details) VALUES ('dashboard', $1, '{"via":"dashboard"}'::jsonb)`,
            [paused ? '/stop' : '/resume']);
  }
  if (which !== 'biz') {
    await qa(`INSERT INTO ads_state (key, value, updated_at) VALUES ('system_paused', $1::jsonb, now())
              ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [paused ? 'true' : 'false']);
  }
  return { ok: true, paused: await pausedState() };
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
