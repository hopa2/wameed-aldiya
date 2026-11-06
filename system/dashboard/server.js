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
const { createCeo } = require('./ceo');

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
const n8nHook = (p) => GATE_TOKEN.length >= 20 ? N8N_URL + '/webhook/' + p : '';
const DATA_HOOK = n8nHook('wameed-dash-data'), SOLD_HOOK = n8nHook('wameed-dash-sold'), CONTROL_HOOK = n8nHook('wameed-dash-control');
const N8N_API_KEY = env.N8N_API_KEY || '';
const CEO_MODEL = env.CEO_MODEL || 'qwen3:8b';
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
        if (shopCache.good && Date.now() - shopCache.goodAt < 3600e3)
          return { ok: true, detail: 'n8n قرأ منه قبل ' + Math.round((Date.now() - shopCache.goodAt) / 60000) + ' دقيقة' };
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
      SELECT (SELECT to_json(r) FROM (SELECT run_id, run_type, CASE WHEN status = 'running' AND started_at < now() - interval '2 hours' THEN 'crashed' ELSE status END AS status, dry_run, started_at, summary FROM ads_runs ORDER BY run_id DESC LIMIT 1) r) AS last_run,
             (SELECT COALESCE(json_object_agg(status, n), '{}') FROM (SELECT status, count(*) n FROM ads_actions
                 WHERE created_at > now() - interval '7 days' GROUP BY status) t) AS actions7d`)),
    soft(qn(`
      SELECT count(*) FILTER (WHERE w.active)::int AS active, count(*)::int AS total,
             (SELECT count(*) FROM execution_entity e WHERE e."startedAt" > now() - interval '24 hours' AND e."deletedAt" IS NULL)::int AS runs24,
             (SELECT count(*) FROM execution_entity e JOIN workflow_entity x ON x.id = e."workflowId"
                 WHERE e."startedAt" > now() - interval '24 hours' AND e."deletedAt" IS NULL AND e.status IN ('error', 'crashed')
                 AND x.name NOT IN ('BIZ - Assistant', 'ME - Assistant', 'ADS-50 أوامر تيليجرام'))::int AS errors24
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
         s.runs7, s.errors7, s.last_error_at
  FROM workflow_entity w
  LEFT JOIN LATERAL (SELECT status, "startedAt", mode FROM execution_entity x
                     WHERE x."workflowId" = w.id AND x."deletedAt" IS NULL ORDER BY x.id DESC LIMIT 1) e ON true
  LEFT JOIN LATERAL (SELECT count(*)::int AS runs7, count(*) FILTER (WHERE status IN ('error', 'crashed'))::int AS errors7,
                            max("startedAt") FILTER (WHERE status IN ('error', 'crashed')) AS last_error_at
                     FROM execution_entity x WHERE x."workflowId" = w.id AND x."startedAt" > now() - interval '7 days') s ON true
  WHERE NOT COALESCE(w."isArchived", false)
  ORDER BY w.name`));

route('GET', /^\/api\/ads$/, async () => {
  const [runs, actions, state, plan, guard] = await Promise.all([
    qa(`SELECT run_id, run_type, CASE WHEN status = 'running' AND started_at < now() - interval '2 hours' THEN 'crashed' ELSE status END AS status, dry_run, started_at, finished_at, left(summary, 1500) AS summary, left(error, 500) AS error
        FROM ads_runs ORDER BY run_id DESC LIMIT 30`),
    qa(`SELECT action_id, run_id, created_at, action_type, payload, reason, source, status, reject_reason, undone_at,
               (status = 'executed' AND undone_at IS NULL AND created_at > now() - interval '30 days') AS can_undo
        FROM ads_actions ORDER BY action_id DESC LIMIT 60`),
    qa(`SELECT key, left(value::text, 200) AS value, updated_at FROM ads_state ORDER BY key`),
    qa(`SELECT value FROM ads_state WHERE key = 'bootstrap_plan'`),
    qa(`SELECT value FROM ads_state WHERE key = 'guard_paused'`),
  ]);
  return { runs, actions, plan: plan[0]?.value || null, guard: guard[0]?.value || null,
           state: state.filter(s => !/token|secret|key|password|update|bootstrap_plan/i.test(s.key)) };
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
async function setPause(paused, system) {
  const which = ['biz', 'ads', 'all'].includes(system) ? system : 'all';
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
  return (paused ? 'أُوقف: ' : 'استؤنف: ') + ({ biz: 'وكلاء المحل', ads: 'وكيل الإعلانات' }[which] || 'كل الوكلاء');
}
route('POST', /^\/api\/pause$/, async (m, b) => {
  await setPause(!!b.paused, b.system);
  return { ok: true, paused: await pausedState() };
});

// ---------- بيانات المحل (عبر n8n، قراءة فقط) ----------
let shopCache = { at: 0, data: null, good: null, goodAt: 0, pending: null };
async function shop(force) {
  if (!force && shopCache.data && Date.now() - shopCache.at < 120e3) return shopCache.data;
  if (shopCache.pending) return shopCache.pending;
  if (!DATA_HOOK) return { ok: false, error: 'WAMEED_DASH_TOKEN غير مضبوط' };
  shopCache.pending = (async () => {
    let data;
    try {
      const r = await fetchJson(DATA_HOOK, { method: 'POST', headers: { 'x-wameed-token': GATE_TOKEN } }, 150e3);
      data = r.json && r.ok ? r.json : { ok: false, error: r.status === 404 ? 'ورك فلو SYS - Dashboard Data غير مفعّل' : 'رد ' + r.status };
    } catch (e) { data = { ok: false, error: errMsg(e) }; }
    if (data.ok) { shopCache.good = data; shopCache.goodAt = Date.now(); }
    else if (shopCache.good) data = { ...shopCache.good, stale: true, stale_error: data.error, stale_at: shopCache.goodAt };
    shopCache.data = data; shopCache.at = Date.now(); shopCache.pending = null;
    return data;
  })();
  return shopCache.pending;
}
let soldCache = { at: 0, data: null, pending: null };
async function sold() {
  if (soldCache.data && Date.now() - soldCache.at < 6 * 3600e3) return soldCache.data;
  if (soldCache.pending) return soldCache.pending;
  soldCache.pending = (async () => {
    try {
      const r = await fetchJson(SOLD_HOOK, { method: 'POST', headers: { 'x-wameed-token': GATE_TOKEN } }, 200e3);
      if (r.ok && r.json?.ok) { soldCache.data = r.json; soldCache.at = Date.now(); return r.json; }
      throw new Error('رد ' + r.status);
    } finally { soldCache.pending = null; }
  })();
  return soldCache.pending;
}
const noItems = ({ items, ...rest }) => rest;
const norm = (s) => String(s || '').toLowerCase().replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/[^ء-يa-z0-9]+/g, ' ').trim();
async function inventoryAlerts() {
  const d = await shop();
  if (!d.ok) throw new Error(d.error);
  const s = await sold();
  const rows = (d.items || []).map(i => { const q = s.sold[i.key] || 0; return { ...i, sold30: Math.round(q * 100) / 100, rev30: Math.round(s.rev[i.key] || 0), cover: q > 0 ? Math.round(Math.max(i.owned, 0) / (q / 30)) : null }; });
  const pick = ({ name, unit, owned, sold30, rev30, cover, price }) => ({ name, unit, owned, sold30, rev30, cover_days: cover, price });
  return {
    summary: d.inventory,
    low: rows.filter(r => r.cover !== null && r.cover < 10).sort((a, b) => b.rev30 - a.rev30).slice(0, 25).map(pick),
    top: rows.filter(r => r.sold30 > 0).sort((a, b) => b.rev30 - a.rev30).slice(0, 25).map(pick),
    problems: rows.filter(r => r.owned < 0 || r.hand < 0).sort((a, b) => b.rev30 - a.rev30).slice(0, 25).map(r => ({ name: r.name, owned: r.owned, hand: r.hand, sold30: r.sold30 })),
    stale: rows.filter(r => r.sold30 === 0 && r.value > 0).sort((a, b) => b.value - a.value).slice(0, 25).map(r => ({ name: r.name, owned: r.owned, value: r.value })),
    invoices_read: s.invoices,
  };
}
route('GET', /^\/api\/shop$/, async (m, b, url) => noItems(await shop(url.searchParams.get('fresh') === '1')));
route('GET', /^\/api\/inventory$/, async () => inventoryAlerts());
route('GET', /^\/api\/items$/, async (m, b, url) => {
  const words = norm(url.searchParams.get('q')).split(' ').filter(Boolean);
  const d = await shop();
  if (!d.ok) throw new Error(d.error);
  if (!words.length) return [];
  return (d.items || []).filter(i => { const n = norm(i.name); return words.every(w => n.includes(w)); }).slice(0, 40);
});

// ---------- الجداول الخاصة باللوحة ----------
const GBP_DEFAULT = [
  ['categories', 'الفئات الرئيسية والفرعية مضبوطة', true], ['website', 'رابط الموقع يشير إلى صفحة الهبوط', true],
  ['nap', 'الاسم والعنوان والهاتف متطابقة في الصفحة والملف', true], ['qr', 'بطاقة QR لطلب التقييم في المحل', true],
  ['description', 'وصف الملف المعتمد منشور (مجدول السبت 7 نوفمبر 10:10)', false], ['photos', 'صور حديثة للواجهة والأقسام والداخل', false],
  ['hours', 'ساعات الدوام والمواسم محدثة', false], ['products', 'الأقسام والمنتجات مضافة في الملف', false],
  ['replies', 'الرد على كل التقييمات الحالية', false], ['posts', 'منشور أسبوعي في الخرائط', false],
  ['api', 'موافقة Google على API (متابعة 17 نوفمبر) ثم الأتمتة', false],
];
async function initDb() {
  await q(`CREATE TABLE IF NOT EXISTS dash_chat (id BIGSERIAL PRIMARY KEY, role TEXT NOT NULL, content TEXT NOT NULL, meta JSONB NOT NULL DEFAULT '{}', at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await q(`CREATE TABLE IF NOT EXISTS dash_proposals (id BIGSERIAL PRIMARY KEY, action TEXT NOT NULL, args JSONB NOT NULL DEFAULT '{}', title TEXT NOT NULL, reason TEXT, status TEXT NOT NULL DEFAULT 'pending',
            result TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), decided_at TIMESTAMPTZ, expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '4 hours')`);
  await q(`CREATE TABLE IF NOT EXISTS dash_gbp_checklist (key TEXT PRIMARY KEY, title TEXT NOT NULL, done BOOLEAN NOT NULL DEFAULT false, pos INT NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  for (const [i, [k, t, d]] of GBP_DEFAULT.entries())
    await q(`INSERT INTO dash_gbp_checklist (key, title, done, pos) VALUES ($1, $2, $3, $4) ON CONFLICT (key) DO NOTHING`, [k, t, d, i]);
}
const audit = (agent, event, details) => q(`INSERT INTO biz_audit_log (agent, event, details) VALUES ($1, $2, $3::jsonb)`, [agent, event, JSON.stringify(details || {})]).catch(e => console.error('audit:', e.message));

// ---------- الإجراءات: نفس الدوال لأزرار اللوحة وبطاقات الرئيس التنفيذي ----------
async function control(body, ms = 60e3) {
  if (!CONTROL_HOOK) throw new Error('WAMEED_DASH_TOKEN غير مضبوط');
  const r = await fetchJson(CONTROL_HOOK, { method: 'POST', headers: { 'content-type': 'application/json', 'x-wameed-token': GATE_TOKEN }, body: JSON.stringify(body) }, ms);
  if (!r.ok) throw new Error(r.status === 404 ? 'ورك فلو SYS - Dashboard Control غير مفعّل' : 'n8n رد ' + r.status);
  return r.json || {};
}
const AGENTS = { reorder: 'وكيل المشتريات', pricing: 'وكيل التسعير', ads_review: 'فحص وكيل الإعلانات' };
const PROTECTED = /^SYS - Dashboard/;
async function findWorkflow(key) {
  const rows = await qn(`SELECT id, name, active FROM workflow_entity WHERE NOT COALESCE("isArchived", false) AND (id = $1 OR name = $1)`, [String(key)]);
  if (!rows[0]) throw new Error('لا يوجد وكيل بهذا الاسم');
  return rows[0];
}
const ACTIONS = {
  async run_agent({ agent, request }) {
    if (!AGENTS[agent]) throw new Error('وكيل غير معروف');
    if ((await pausedState()).biz && agent !== 'ads_review') throw new Error('وكلاء المحل موقوفون، استأنفهم أولًا');
    if (agent === 'reorder') { const s = await sold(); await control({ agent, sold: s.sold }); return 'بدأ وكيل المشتريات. أي طلب شراء يصل إلى الموافقات وتيليجرام.'; }
    if (agent === 'pricing') { await control({ agent }); return 'بدأ وكيل التسعير. أي تعديل يصل إلى الموافقات وتيليجرام.'; }
    await control({ agent, request });
    return 'بدأ فحص الإعلانات للمراقبة فقط، ولن يغيّر شيئًا. النتيجة في تبويب الإعلانات خلال دقائق.';
  },
  async set_workflow({ workflow, active }) {
    if (typeof active !== 'boolean') throw new Error('حدد تفعيل أو إيقاف');
    const w = await findWorkflow(workflow);
    if (!/^(BIZ|SYS|ADS|GBP)\b/i.test(w.name)) throw new Error('هذا الوكيل خارج منظومة المؤسسة');
    if (PROTECTED.test(w.name) && !active) throw new Error('هذا الورك فلو تعتمد عليه اللوحة نفسها، فلا يوقف من هنا');
    if (!N8N_API_KEY) throw new Error('N8N_API_KEY غير متاح للوحة');
    const r = await fetchJson(`${N8N_URL}/api/v1/workflows/${w.id}/${active ? 'activate' : 'deactivate'}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-n8n-api-key': N8N_API_KEY }, body: '{}' }, 20e3);
    if (!r.ok) throw new Error('n8n رد ' + r.status);
    return (active ? 'فُعّل: ' : 'أوقف: ') + w.name;
  },
  async ads_approve_plan({ plan_id }) {
    const r = await qa(`UPDATE ads_state SET value = value || jsonb_build_object('status', 'approved', 'approved_at', now()), updated_at = now()
                        WHERE key = 'bootstrap_plan' AND value->>'status' = 'awaiting_approval' AND (value->>'plan_id')::bigint = $1 RETURNING key`, [Number(plan_id)]);
    if (!r.length) throw new Error('لا توجد خطة بهذا الرقم تنتظر الموافقة');
    return `اعتُمدت الخطة ${plan_id}، ووكيل الإعلانات ينفذها خلال 30 دقيقة.`;
  },
  async ads_undo({ action_id }) {
    const a = (await qa(`SELECT action_id, action_type, payload, prev_state, created_resource FROM ads_actions
                         WHERE action_id = $1 AND status = 'executed' AND undone_at IS NULL AND created_at > now() - interval '30 days'`, [Number(action_id)]))[0];
    if (!a) throw new Error('لا يوجد إجراء منفذ بهذا الرقم قابل للتراجع');
    const r = await control({ agent: 'ads_undo', action_id: Number(a.action_id), type: a.action_type, payload: a.payload, prev_state: a.prev_state, created_resource: a.created_resource }, 120e3);
    if (!r.ok) throw new Error('تعذّر التراجع: ' + String(r.error || 'غير معروف').slice(0, 200));
    if (r.validate_only) return `فترة التجربة: فحص فقط للإجراء #${action_id}، ولم يتغير شيء.`;
    await qa(`UPDATE ads_actions SET status = 'undone', undone_at = now() WHERE action_id = $1`, [Number(a.action_id)]);
    return `تم التراجع عن الإجراء #${action_id}.`;
  },
  async ads_resume() {
    const g = (await qa(`SELECT value FROM ads_state WHERE key = 'guard_paused'`))[0]?.value;
    if (!g || !g.month || !(g.campaigns || []).length) throw new Error('الحارس لم يوقف أي حملة');
    const r = await control({ agent: 'ads_resume', campaigns: g.campaigns }, 120e3);
    if (!r.ok) throw new Error('تعذّر الاستئناف: ' + String(r.error || '').slice(0, 200));
    if (!r.live) return 'فترة التجربة: فحص فقط، ولم يتغير شيء.';
    await qa(`UPDATE ads_state SET value = 'false'::jsonb, updated_at = now() WHERE key = 'guard_paused'`);
    return 'أعيد تشغيل الحملة التي أوقفها الحارس.';
  },
  async pause({ paused, system }) { return setPause(!!paused, system); },
};
async function runAction(action, args, by) {
  if (!ACTIONS[action]) throw new Error('إجراء غير معروف');
  const result = await ACTIONS[action](args || {});
  await audit(by, 'action:' + action, { args: action === 'ads_undo' || action === 'run_agent' ? { ...args, sold: undefined } : args, result });
  return result;
}
function proposalTitle(a) {
  switch (a.action) {
    case 'run_agent': return 'تشغيل ' + (AGENTS[a.agent] || a.agent);
    case 'set_workflow': return (a.active ? 'تفعيل ' : 'إيقاف ') + a.workflow;
    case 'ads_approve_plan': return 'اعتماد خطة الإعلانات رقم ' + a.plan_id;
    case 'ads_undo': return 'التراجع عن إجراء الإعلانات #' + a.action_id;
    case 'ads_resume': return 'إعادة تشغيل الحملة التي أوقفها الحارس';
    case 'pause': return (a.paused ? 'إيقاف ' : 'استئناف ') + ({ biz: 'وكلاء المحل', ads: 'وكيل الإعلانات' }[a.system] || 'كل الوكلاء');
    default: return a.action;
  }
}
async function propose(a) {
  if (!ACTIONS[a.action]) throw new Error('إجراء غير مسموح');
  const { action, reason, ...args } = a;
  if (action === 'set_workflow') { const w = await findWorkflow(args.workflow); args.workflow = w.name; }
  if (action === 'run_agent' && !AGENTS[args.agent]) throw new Error('وكيل غير معروف');
  const rows = await q(`INSERT INTO dash_proposals (action, args, title, reason) VALUES ($1, $2::jsonb, $3, $4) RETURNING id, action, title, reason, status, created_at, expires_at`,
    [action, JSON.stringify(args), proposalTitle({ action, ...args }), String(reason || '').slice(0, 500)]);
  await audit('ceo', 'proposal:' + action, { id: rows[0].id, args });
  return rows[0];
}
route('POST', /^\/api\/agents\/(\w+)\/run$/, async (m, b) => ({ ok: true, message: await runAction('run_agent', { agent: m[1], request: b.request }, 'dashboard') }));
route('POST', /^\/api\/workflows\/([\w-]+)\/active$/, async (m, b) => ({ ok: true, message: await runAction('set_workflow', { workflow: m[1], active: !!b.active }, 'dashboard') }));
route('POST', /^\/api\/ads\/plan\/(\d+)\/approve$/, async (m) => ({ ok: true, message: await runAction('ads_approve_plan', { plan_id: Number(m[1]) }, 'dashboard') }));
route('POST', /^\/api\/ads\/undo\/(\d+)$/, async (m) => ({ ok: true, message: await runAction('ads_undo', { action_id: Number(m[1]) }, 'dashboard') }));
route('POST', /^\/api\/ads\/resume$/, async () => ({ ok: true, message: await runAction('ads_resume', {}, 'dashboard') }));

route('POST', /^\/api\/proposals\/(\d+)\/(confirm|reject)$/, async (m) => {
  const id = Number(m[1]), confirm = m[2] === 'confirm';
  // الحجز الذري يمنع التنفيذ مرتين عند ضغطتين
  const p = (await q(`UPDATE dash_proposals SET status = $2, decided_at = now() WHERE id = $1 AND status = 'pending' AND now() <= expires_at RETURNING action, args`, [id, confirm ? 'running' : 'rejected']))[0];
  if (!p) throw new Error('البطاقة لم تعد بانتظار القرار');
  if (!confirm) { await audit('dashboard', 'proposal:rejected', { id }); return { ok: true, status: 'rejected', message: 'رُفض، ولم يُنفذ شيء' }; }
  try {
    const message = await runAction(p.action, p.args, 'dashboard');
    await q(`UPDATE dash_proposals SET status = 'done', result = $2 WHERE id = $1`, [id, message]);
    return { ok: true, status: 'done', message };
  } catch (e) {
    await q(`UPDATE dash_proposals SET status = 'failed', result = $2 WHERE id = $1`, [id, e.message]);
    throw e;
  }
});

// ---------- واتساب ----------
const wahaHeaders = () => (WAHA_KEY ? { 'x-api-key': WAHA_KEY } : {});
const QUOTES_TABLE = 'data_table_user_R74NfbJWPMAp6OdJ';
async function waStatus() {
  const [sessions, quotes] = await Promise.all([
    fetchJson(WAHA_URL + '/api/sessions?all=true', { headers: wahaHeaders() }).then(r => (Array.isArray(r.json) ? r.json : []).map(s => ({ name: s.name, status: s.status, me: s.me?.pushName || null }))).catch(e => ({ error: errMsg(e) })),
    soft(qn(`SELECT token, "customerName" AS customer, "quoteText" AS text, status, "createdAt" AS created_at FROM "${QUOTES_TABLE}" ORDER BY "createdAt" DESC LIMIT 20`)),
  ]);
  return { sessions, quotes };
}
route('GET', /^\/api\/whatsapp$/, waStatus);
route('GET', /^\/api\/whatsapp\/qr$/, async () => {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15e3);
  try {
    const r = await fetch(WAHA_URL + '/api/default/auth/qr?format=image', { headers: { ...wahaHeaders(), accept: 'image/png' }, signal: ctl.signal });
    if (!r.ok) throw new Error('لا يوجد رمز الآن. الجلسة مربوطة أو لم تبدأ بعد (' + r.status + ')');
    const type = r.headers.get('content-type') || 'image/png';
    if (type.includes('json')) { const j = await r.json(); return { image: `data:${j.mimetype || 'image/png'};base64,${j.data}` }; }
    return { image: `data:${type};base64,${Buffer.from(await r.arrayBuffer()).toString('base64')}` };
  } finally { clearTimeout(t); }
});
route('POST', /^\/api\/whatsapp\/restart$/, async () => {
  const r = await fetchJson(WAHA_URL + '/api/sessions/default/restart', { method: 'POST', headers: wahaHeaders() }, 20e3);
  if (!r.ok) throw new Error('WAHA رد ' + r.status);
  await audit('dashboard', 'whatsapp:restart', {});
  return { ok: true };
});
route('POST', /^\/api\/whatsapp\/quotes\/([\w-]+)\/(send|decline)$/, async (m) => {
  await control({ agent: 'quote', token: m[1], action: m[2] === 'send' ? 'y' : 'n' });
  await audit('dashboard', 'quote:' + m[2], { token: m[1] });
  return { ok: true };
});

// ---------- ملف جوجل التجاري ----------
const gbpChecklist = () => q(`SELECT key, title, done, updated_at FROM dash_gbp_checklist ORDER BY pos`);
route('GET', /^\/api\/gbp$/, async () => ({
  checklist: await gbpChecklist(),
  workflows: await soft(qn(`SELECT id, name, active FROM workflow_entity WHERE name LIKE 'GBP%' AND NOT COALESCE("isArchived", false) ORDER BY name`)),
}));
route('PUT', /^\/api\/gbp\/([\w-]+)$/, async (m, b) => {
  const r = await q(`UPDATE dash_gbp_checklist SET done = $2, updated_at = now() WHERE key = $1 RETURNING key`, [m[1], !!b.done]);
  if (!r.length) throw Object.assign(new Error('بند غير معروف'), { code: 404 });
  return { ok: true };
});

// ---------- الرئيس التنفيذي ----------
const stripWa = (list) => (list || []).map(({ wa, ...x }) => x);
const CEO_TOOLS = {
  async get_sales() { const d = await shop(); if (!d.ok) throw new Error(d.error); const periods = Object.fromEntries(Object.entries(d.periods).map(([k, { profit, ...p }]) => [k, p]));
    return { periods, goal: d.goal, today_invoices: d.today_invoices.slice(0, 30), cash: d.cash, data_age: d.stale ? 'قديمة: ' + d.stale_error : 'حديثة' }; },
  async get_debtors({ name }) {
    const d = await shop(); if (!d.ok) throw new Error(d.error);
    const r = d.receivables, list = stripWa(r.list);
    if (name) {
      const words = norm(name).split(' ').filter(w => w.length > 1);
      const scored = list.map(c => { const n = norm(c.name).split(' '); return { c, s: words.filter(w => n.includes(w)).length }; });
      const best = Math.max(0, ...scored.map(x => x.s));
      const hits = best ? scored.filter(x => x.s === best).map(x => x.c) : [];
      return { query: name, matches: hits.slice(0, 8), note: hits.length ? (hits.length > 1 ? 'أكثر من احتمال: اعرضها واطلب التحديد' : '') : 'لا يوجد مدين بهذا الاسم' };
    }
    return { total: r.total, count: r.count, overdue30: r.overdue30, top: list.slice(0, 15) };
  },
  async get_customers() { const d = await shop(); if (!d.ok) throw new Error(d.error); return { top_30_days: d.top_customers, lapsed: stripWa(d.lapsed) }; },
  async search_items({ query }) {
    const words = norm(query).split(' ').filter(Boolean), d = await shop(); if (!d.ok) throw new Error(d.error);
    const s = soldCache.data;
    return (d.items || []).filter(i => { const n = norm(i.name); return words.every(w => n.includes(w)); }).slice(0, 15)
      .map(i => ({ name: i.name, unit: i.unit, owned: i.owned, price: i.price, cost: i.cost, sold30: s ? (s.sold[i.key] || 0) : 'غير محسوب بعد' }));
  },
  get_inventory_alerts: async () => { const a = await inventoryAlerts(); return { summary: a.summary, low: a.low.slice(0, 15), top: a.top.slice(0, 10), problems: a.problems.slice(0, 10), stale: a.stale.slice(0, 10) }; },
  async get_system_status() {
    const [paused, l, wf] = await Promise.all([pausedState(), live(), qn(`
      SELECT w.name, w.active, s.errors, s.last_at FROM workflow_entity w
      LEFT JOIN LATERAL (SELECT count(*)::int AS errors, max(x."startedAt") AS last_at FROM execution_entity x WHERE x."workflowId" = w.id AND x."startedAt" > now() - interval '24 hours' AND x.status IN ('error', 'crashed')) s ON true
      WHERE NOT COALESCE(w."isArchived", false) AND w.name ~ '^(BIZ|SYS|ADS|GBP)' ORDER BY w.name`)]);
    return { paused, devices: l, active: wf.filter(w => w.active).length, inactive: wf.filter(w => !w.active).map(w => w.name),
             errors_24h: wf.filter(w => w.errors > 0).map(w => ({ name: w.name, errors: w.errors, last_error: w.last_at, note: /Assistant|ADS-50/.test(w.name) ? 'غالبًا انقطاع عابر في فحص تيليجرام' : undefined })) };
  },
  get_approvals: async () => q(`SELECT id, agent, action_type, left(summary, 400) AS summary, amount, expires_at FROM biz_approvals WHERE status = 'pending' AND now() <= expires_at ORDER BY id`),
  async get_ads_status() {
    const [runs, actions, plan, guard] = await Promise.all([
      qa(`SELECT run_id, run_type, CASE WHEN status = 'running' AND started_at < now() - interval '2 hours' THEN 'crashed' ELSE status END AS status, dry_run, started_at, left(summary, 900) AS summary, left(error, 200) AS error FROM ads_runs ORDER BY run_id DESC LIMIT 3`),
      qa(`SELECT action_id, action_type, status, left(reason, 200) AS reason, created_at FROM ads_actions ORDER BY action_id DESC LIMIT 8`),
      qa(`SELECT value->>'plan_id' AS plan_id, value->>'status' AS status FROM ads_state WHERE key = 'bootstrap_plan'`),
      qa(`SELECT value FROM ads_state WHERE key = 'guard_paused'`),
    ]);
    return { runs, actions, plan: plan[0] || null, guard: guard[0]?.value || null };
  },
  get_whatsapp_status: async () => { const s = await waStatus(); return { sessions: s.sessions, pending_quotes: Array.isArray(s.quotes) ? s.quotes.filter(x => x.status === 'pending').map(x => ({ customer: x.customer, text: String(x.text).slice(0, 300) })) : s.quotes }; },
  get_gbp_status: async () => ({ checklist: (await gbpChecklist()).map(c => ({ item: c.title, done: c.done })), note: 'النشر الآلي ينتظر موافقة Google على API، والمتابعة 17 نوفمبر' }),
};
async function chatHistory(limit) {
  const rows = await q(`SELECT role, content FROM dash_chat WHERE id > COALESCE((SELECT max(id) FROM dash_chat WHERE role = 'reset'), 0) AND role IN ('user', 'assistant') AND NOT (meta ? 'error') ORDER BY id DESC LIMIT $1`, [limit]);
  return rows.reverse();
}
const ceo = createCeo({ ollamaUrl: OLLAMA_URL, model: CEO_MODEL, tools: CEO_TOOLS, history: chatHistory, propose,
  save: (role, content, meta) => q(`INSERT INTO dash_chat (role, content, meta) VALUES ($1, $2, $3::jsonb)`, [role, content, JSON.stringify(meta || {})]) });
route('GET', /^\/api\/chat$/, async () => {
  await q(`UPDATE dash_proposals SET status = 'expired' WHERE status = 'pending' AND now() > expires_at`);
  const messages = await q(`SELECT id, role, content, meta, at FROM dash_chat WHERE id > COALESCE((SELECT max(id) FROM dash_chat WHERE role = 'reset'), 0) AND role <> 'reset' ORDER BY id DESC LIMIT 60`);
  const ids = messages.flatMap(m => m.meta?.proposals || []);
  const proposals = await q(`SELECT id, action, title, reason, status, result, created_at, expires_at FROM dash_proposals WHERE id = ANY($1::bigint[]) OR status = 'pending' ORDER BY id`, [ids]);
  return { messages: messages.reverse(), proposals, model: CEO_MODEL, busy: ceo.isBusy() };
});
route('POST', /^\/api\/chat\/reset$/, async () => { await q(`INSERT INTO dash_chat (role, content) VALUES ('reset', '')`); return { ok: true }; });

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
    if (url.pathname === '/api/chat' && req.method === 'POST') {
      const text = String((await body(req)).message || '').trim().slice(0, 2000);
      if (!text) return send(res, 400, { error: 'اكتب رسالتك' });
      res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
      const beat = setInterval(() => res.write('\n'), 15000);   // يبقي الاتصال حيًا أثناء تحميل النموذج
      try { await ceo.chat(text, (ev) => res.write(JSON.stringify(ev) + '\n')); }
      catch (e) { res.write(JSON.stringify({ type: 'reply', text: e.message, error: true, proposals: [] }) + '\n'); }
      clearInterval(beat);
      return res.end();
    }
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
(async function boot(tries = 0) {
  try { await initDb(); console.log('dash tables ready'); }
  catch (e) { console.error('initDb:', e.message); if (tries < 20) setTimeout(() => boot(tries + 1), 15000); }
})();
