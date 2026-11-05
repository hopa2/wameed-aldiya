'use strict';
// واجهة لوحة وميض الضياء: صفحة واحدة بلا مكتبات، فوق المنظومة الموجودة.
const $ = (s, el = document) => el.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v, d = 0) => v === null || v === undefined || v === '' ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });
const sar = (v) => v === null || v === undefined ? '—' : num(v, Number(v) % 1 ? 2 : 0) + ' ر.س';
const when = (t) => t ? new Date(t).toLocaleString('ar-SA-u-nu-latn-ca-gregory', { timeZone: 'Asia/Riyadh', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const ago = (t) => {
  if (!t) return '—';
  const m = Math.round((Date.now() - new Date(t)) / 60000);
  if (m < 1) return 'الآن';
  if (m < 60) return `قبل ${m} د`;
  if (m < 1440) return `قبل ${Math.round(m / 60)} س`;
  return `قبل ${Math.round(m / 1440)} يوم`;
};

const STATUS = {
  // biz_approvals
  pending: ['warn', 'بانتظارك'], approved: ['info', 'اعتُمد'], rejected: ['', 'مرفوض'], expired: ['', 'انتهت المهلة'],
  blocked: ['bad', 'حجبه السقف'], executed: ['ok', 'نُفذ'], failed: ['bad', 'فشل التنفيذ'], undone: ['', 'تراجعت عنه'],
  // n8n executions
  success: ['ok', 'نجح'], error: ['bad', 'فشل'], crashed: ['bad', 'تعطل'], running: ['info', 'يعمل'], waiting: ['info', 'ينتظر'],
  canceled: ['', 'أُلغي'], new: ['info', 'بدأ'],
  // ads
  ok: ['ok', 'نجح'], paused: ['info', 'موقوف'], dry_run: ['info', 'تجربة: لم يُنفذ'],
};
const label = (s) => (STATUS[s] || [, s])[1];
const pill = (s) => { const [c, t] = STATUS[s] || ['', s || '—']; return `<span class="pill ${c}"><span class="dot"></span>${esc(t)}</span>`; };
const ACTION = { purchase_order: 'أمر شراء', price_change: 'تعديل أسعار' };
const GROUPS = [
  ['SYS', 'المنظومة والبوابة', 'الموافقات، الموجز، التنبيهات، لقطات Manager'],
  ['BIZ', 'وكلاء المحل', 'التقارير، المخزون، الطلبات، الأسعار، واتساب'],
  ['ADS', 'وكيل إعلانات جوجل', 'الحارس، الوكيل، المنفّذ، صفحة الهبوط'],
  ['GBP', 'ملف جوجل التجاري', ''], ['JOB', 'بوت المبيعات', ''], ['ME', 'المساعد الشخصي', ''], ['TMP', 'مؤقت (للحذف)', ''],
];

async function api(path, opts = {}) {
  const r = await fetch('/api/' + path, {
    ...opts, headers: { 'content-type': 'application/json', 'x-requested-with': 'wameed', ...(opts.headers || {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== 'login') { showLogin(); throw new Error(j.error || 'سجّل الدخول'); }
  if (!r.ok) throw new Error(j.error || 'خطأ ' + r.status);
  return j;
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add('hidden'), 4500);
}
const errBox = (r) => r && r.error ? `<div class="banner warn">تعذّرت القراءة: ${esc(r.error)}</div>` : '';

// ---------- الدخول ----------
function showLogin() { $('#app').classList.add('hidden'); $('#login').classList.remove('hidden'); $('#pw').focus(); }
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await api('login', { method: 'POST', body: { password: $('#pw').value } }); $('#pw').value = ''; start(); }
  catch (err) { $('#loginErr').textContent = err.message; }
});

// ---------- التنقل ----------
const VIEWS = {};
let current = 'home', timer = null;
function go() {
  current = (location.hash || '#home').slice(1);
  if (!VIEWS[current]) current = 'home';
  document.querySelectorAll('#tabs a').forEach(a => a.classList.toggle('on', a.dataset.tab === current));
  render();
}
async function render() {
  try { await VIEWS[current]($('#view')); }
  catch (e) { if (!/سجّل/.test(e.message)) $('#view').innerHTML = `<div class="banner bad">${esc(e.message)}</div>`; }
}
window.addEventListener('hashchange', go);

function header(o) {
  const b = $('#pendingBadge'), n = o.biz?.pending || 0;
  b.textContent = n; b.classList.toggle('hidden', !n);
  const any = o.paused.biz || o.paused.ads;
  $('#pauseBox').innerHTML = any
    ? `<button class="btn ok" data-pause="0" data-system="all">▶️ استئناف</button>`
    : `<button class="btn bad" data-pause="1" data-system="all">⛔ إيقاف الكل</button>`;
  return o;
}
document.addEventListener('click', async (e) => {
  const p = e.target.closest('[data-pause]');
  if (!p) return;
  const paused = p.dataset.pause === '1', system = p.dataset.system;
  const name = { all: 'كل الوكلاء (المحل والإعلانات)', biz: 'وكلاء المحل والبوابة', ads: 'وكيل الإعلانات' }[system];
  if (paused && !confirm(`إيقاف ${name} حتى تستأنف؟`)) return;
  try { await api('pause', { method: 'POST', body: { paused, system } }); toast(paused ? 'أُوقف: ' + name : 'استُؤنف: ' + name); }
  catch (err) { toast(err.message); }
  render();
});

// ---------- الرئيسية ----------
VIEWS.home = async (el) => {
  const o = header(await api('overview'));
  const L = o.live, biz = o.biz || {}, ads = o.ads || {}, wf = o.workflows || {};
  const banners = [];
  if (o.paused.biz) banners.push(`<div class="banner bad row">⛔ وكلاء المحل موقوفون (/stop): البوابة لن تنفّذ أي موافقة. <button class="btn small ok" data-pause="0" data-system="biz">استئناف</button></div>`);
  if (o.paused.ads) banners.push(`<div class="banner bad row">⛔ وكيل الإعلانات موقوف. <button class="btn small ok" data-pause="0" data-system="ads">استئناف</button></div>`);
  if (!L.ollama.ok) banners.push(`<div class="banner bad">🚨 Ollama لا يرد: الوكلاء المحليون لن يعملوا.</div>`);
  if (!L.manager.ok) banners.push(`<div class="banner warn">🖥️ جهاز المحل (Manager.io) لا يرد: الموافقات لن تُنفذ حتى يعود.</div>`);
  if (!L.waha.ok) banners.push(`<div class="banner warn">💬 واتساب WAHA: ${esc(L.waha.detail)}</div>`);

  const hRow = (name, h) => `<div class="row"><span>${name}</span><span class="pill ${h.ok ? 'ok' : 'bad'}"><span class="dot"></span>${h.ok ? 'يعمل' : 'متوقف'}</span>
      <div class="muted" style="flex-basis:100%;font-size:13px">${esc(h.detail || '')}</div></div>`;
  const l24 = biz.last24 || {};
  const lastRun = ads.last_run;
  const snaps = Array.isArray(o.snapshots) ? o.snapshots : [];
  const capPct = biz.po_max_per_day ? Math.min(100, Math.round(Number(biz.po_today) / Number(String(biz.po_max_per_day).replace(/"/g, '')) * 100)) : 0;

  el.innerHTML = `
    ${banners.join('')}
    ${errBox(o.biz)}${errBox(o.ads)}${errBox(o.workflows)}
    <section class="grid">
      <a class="card stat" href="#approvals" style="text-decoration:none;color:inherit"><div class="label">بانتظار قرارك</div><div class="value">${num(biz.pending)}</div>
        <div class="sub">آخر 24 ساعة: ${Object.entries(l24).map(([k, v]) => `${esc(label(k))} ${num(v)}`).join('، ') || 'لا طلبات'}</div></a>
      <div class="card stat"><div class="label">مشتريات اليوم المنفّذة</div><div class="value">${sar(biz.po_today)}</div>
        ${biz.po_max_per_day ? `<div class="meter"><i style="width:${capPct}%"></i></div><div class="sub">من سقف ${esc(String(biz.po_max_per_day).replace(/"/g, ''))} ر.س · الأسبوع ${sar(biz.po7d)}</div>` : ''}</div>
      <a class="card stat" href="#agents" style="text-decoration:none;color:inherit"><div class="label">الـ workflows</div><div class="value">${num(wf.active)} <span style="font-size:1rem">مفعّل من ${num(wf.total)}</span></div>
        <div class="sub">آخر 24 ساعة: ${num(wf.runs24)} تشغيل${wf.errors24 ? ` · <span style="color:var(--bad)">${num(wf.errors24)} فشل</span>` : ' · بلا فشل'}</div></a>
      <a class="card stat" href="#ads" style="text-decoration:none;color:inherit"><div class="label">وكيل الإعلانات</div>
        <div class="value" style="font-size:1.1rem">${lastRun ? pill(lastRun.status) + (lastRun.dry_run ? ' ' + pill('dry_run') : '') : '—'}</div>
        <div class="sub">${lastRun ? 'آخر تشغيل ' + ago(lastRun.started_at) : 'لم يعمل بعد'}</div></a>
    </section>
    <section class="grid wide">
      <div class="card"><h2>حالة الأجهزة</h2><div class="list">
        ${hRow('n8n (اللابتوب)', L.n8n)}
        ${hRow('Ollama (العقل المحلي)', L.ollama)}
        ${hRow('واتساب WAHA (اللابتوب)', L.waha)}
        ${hRow('Manager.io (جهاز المحل)', L.manager)}
        ${snaps.length ? `<div class="muted" style="font-size:13px">آخر لقطات Manager: ${snaps.map(s => `${esc(s.resource)} ${num(s.records)} (${ago(s.taken_at)})`).join('، ')}</div>` : ''}
      </div></div>
      <div class="card"><h2>آخر الأحداث</h2><div class="list">${events(o.events)}</div>
        <a class="btn small" href="#log">كل السجل</a></div>
    </section>`;
};

const EVENT = (e) => {
  const ev = String(e.event || '');
  if (ev.startsWith('requested:')) return '📝 طلب موافقة: ' + (ACTION[ev.slice(10)] || ev.slice(10));
  if (ev.startsWith('decision:')) return '🧑 قرار: ' + label(ev.slice(9));
  if (ev.startsWith('execute:')) return '⚙️ تنفيذ: ' + label(ev.slice(8));
  if (ev.startsWith('guardrail:')) return '🛡️ تعديل حاجز ' + ev.slice(10);
  if (ev === '/stop') return '⛔ إيقاف';
  if (ev === '/resume') return '▶️ استئناف';
  if (ev === 'undo') return '↩️ تراجع';
  return ev;
};
function events(list) {
  return (list || []).map(e => `<div><div class="row"><span><span class="pill ${e.src === 'ads' ? 'info' : ''}">${e.src === 'ads' ? 'إعلانات' : esc(e.agent || 'المحل')}</span>
      ${esc(EVENT(e))}${e.approval_id ? ` <span class="muted">#${e.approval_id}</span>` : ''}</span><span class="muted" style="font-size:13px">${ago(e.at)}</span></div>
      ${e.summary ? `<div class="muted" style="font-size:14px;white-space:pre-wrap">${esc(String(e.summary).slice(0, 300))}</div>` : ''}</div>`).join('')
    || '<div class="muted">لا أحداث بعد</div>';
}

// ---------- الموافقات ----------
function approvalBody(a) {
  const p = a.payload || {};
  const rows = Array.isArray(p.changes) && p.changes.length
    ? `<div class="table-wrap"><table><tr><th>الصنف</th><th>الحالي</th><th>الجديد</th></tr>
        ${p.changes.map(c => `<tr><td>${esc(c.name || c.key)}</td><td class="num">${esc(c.old ?? '—')}</td><td class="num">${esc(c.new ?? '—')}</td></tr>`).join('')}</table></div>` : '';
  return `${a.summary ? `<div class="preview">${esc(a.summary)}</div>` : ''}${rows}
    ${p.supplierName ? `<div class="muted">المورد: ${esc(p.supplierName)}</div>` : ''}
    ${p.supplierMsg ? `<details><summary class="muted">رسالة المورد</summary><div class="preview">${esc(p.supplierMsg)}</div></details>` : ''}`;
}
VIEWS.approvals = async (el) => {
  const d = await api('approvals');
  api('overview').then(header).catch(() => {});
  el.innerHTML = `
    <h2>بانتظار قرارك (${d.pending.length})</h2>
    ${d.can_approve ? '' : '<div class="banner info">الموافقة من زر تيليجرام حاليًا. الرفض يعمل من هنا.</div>'}
    ${d.pending.length ? '' : '<div class="card muted">لا شيء بانتظارك الآن 👍</div>'}
    ${d.pending.map(a => `
      <div class="card approval stack" data-id="${a.id}">
        <div class="row"><strong>#${a.id} · ${esc(ACTION[a.action_type] || a.action_type)}${Number(a.amount) ? ' · ' + sar(a.amount) : ''}</strong>
          <span class="muted" style="font-size:13px">${esc(a.agent)} · ينتهي ${when(a.expires_at)}</span></div>
        ${approvalBody(a)}
        <div class="actions">
          ${d.can_approve ? '<button class="btn ok" data-decide="approve">✅ موافقة وتنفيذ في Manager</button>' : ''}
          <button class="btn bad" data-decide="reject">❌ رفض</button></div>
      </div>`).join('')}
    <div class="card"><h2>آخر الطلبات</h2><div class="table-wrap"><table>
      <tr><th>#</th><th>الطلب</th><th class="hide-sm">الوكيل</th><th>الحالة</th><th class="hide-sm">متى</th></tr>
      ${d.recent.map(a => `<tr><td class="num">${a.id}</td><td><strong>${esc(ACTION[a.action_type] || a.action_type)}</strong>${Number(a.amount) ? ' · ' + sar(a.amount) : ''}
          <div class="muted" style="font-size:13px">${esc(String(a.summary || '').slice(0, 120))}</div></td>
        <td class="hide-sm">${esc(a.agent)}</td><td>${pill(a.status)}<div class="muted" style="font-size:12px;margin-top:4px">${ago(a.executed_at || a.decided_at || a.created_at)}</div></td>
        <td class="hide-sm num">${when(a.executed_at || a.decided_at || a.created_at)}</td></tr>`).join('')
        || '<tr><td colspan="5" class="muted">لا طلبات بعد</td></tr>'}
    </table></div></div>`;
  el.querySelectorAll('[data-decide]').forEach(b => b.onclick = async () => {
    const card = b.closest('[data-id]'), id = card.dataset.id, approve = b.dataset.decide === 'approve';
    if (approve && !confirm(`تنفيذ الطلب #${id} في Manager.io الآن؟`)) return;
    card.querySelectorAll('button').forEach(x => x.disabled = true);
    try {
      const r = await api(`approvals/${id}/${approve ? 'approve' : 'reject'}`, { method: 'POST', body: {} });
      toast(!approve ? 'رُفض، لم يُنفذ شيء' : r.status === 'pending' ? 'البوابة لم تنفّذ (المنظومة موقوفة؟). التفاصيل في تيليجرام.'
          : `البوابة: ${label(r.status)}. التفاصيل في تيليجرام.`);
    } catch (e) { toast(e.message); }
    render();
  });
};

// ---------- الوكلاء (كل الـ workflows) ----------
VIEWS.agents = async (el) => {
  const list = await api('workflows');
  const groups = GROUPS.map(([p, title, sub]) => ({ title, sub, items: list.filter(w => new RegExp('^' + p + '\\s*-', 'i').test(w.name)) }));
  const used = new Set(groups.flatMap(g => g.items));
  groups.push({ title: 'أخرى', sub: '', items: list.filter(w => !used.has(w)) });
  el.innerHTML = groups.filter(g => g.items.length).map(g => `
    <div class="card"><div class="row"><h2 style="margin:0">${esc(g.title)}</h2><span class="muted" style="font-size:13px">${esc(g.sub)}</span></div>
      <div class="table-wrap"><table>
        <tr><th>الاسم</th><th>الحالة</th><th>آخر تشغيل</th><th class="hide-sm">7 أيام</th></tr>
        ${g.items.map(w => `<tr><td>${esc(w.name)}</td>
          <td>${w.active ? '<span class="pill ok"><span class="dot"></span>مفعّل</span>' : '<span class="pill">متوقف</span>'}</td>
          <td>${w.last_status ? pill(w.last_status) + '<div class="muted" style="font-size:12px;margin-top:4px">' + ago(w.last_at) + '</div>' : '<span class="muted">—</span>'}</td>
          <td class="hide-sm num">${num(w.runs7)}${w.errors7 ? ` · <span style="color:var(--bad)">${num(w.errors7)} فشل</span>` : ''}</td></tr>`).join('')}
      </table></div></div>`).join('')
    + `<p class="muted" style="font-size:13px">التفعيل والتعديل من n8n نفسه (http://localhost:5678)، حتى لا تتعارض اللوحة مع أداة النشر deploy_workflows.py.</p>`;
};

// ---------- الإعلانات ----------
VIEWS.ads = async (el) => {
  const [d, o] = await Promise.all([api('ads'), api('overview')]);
  header(o);
  el.innerHTML = `
    <div class="card row"><div><h2 style="margin:0">وكيل إعلانات جوجل</h2>
      <div class="muted" style="font-size:14px">الأوامر الكاملة في بوت تيليجرام (@wameed_ads_bot)، واللوحة للمتابعة والإيقاف.</div></div>
      ${o.paused.ads ? '<button class="btn ok" data-pause="0" data-system="ads">▶️ استئناف الإعلانات</button>' : '<button class="btn bad" data-pause="1" data-system="ads">⛔ إيقاف الإعلانات</button>'}</div>
    <div class="card"><h2>آخر الإجراءات</h2><div class="table-wrap"><table>
      <tr><th>#</th><th>الإجراء</th><th>الحالة</th><th class="hide-sm">السبب</th><th>متى</th></tr>
      ${d.actions.map(a => `<tr><td class="num">${a.action_id}</td><td class="ltr" style="text-align:start">${esc(a.action_type)}<div class="muted" style="font-size:12px">${esc(a.source)}</div></td>
        <td>${pill(a.status)}${a.undone_at ? ' ' + pill('undone') : ''}</td>
        <td class="hide-sm muted" style="font-size:13px">${esc(String(a.reason || a.reject_reason || '').slice(0, 200))}</td><td class="num">${when(a.created_at)}</td></tr>`).join('')
        || '<tr><td colspan="5" class="muted">لا إجراءات بعد</td></tr>'}
    </table></div></div>
    <div class="card"><h2>آخر التشغيلات</h2><div class="list">
      ${d.runs.map(r => `<div><div class="row"><span>${esc(r.run_type)} ${pill(r.status)} ${r.dry_run ? pill('dry_run') : ''}</span><span class="muted" style="font-size:13px">${when(r.started_at)}</span></div>
        ${r.summary ? `<details><summary class="muted">الملخص</summary><div style="white-space:pre-wrap">${esc(r.summary)}</div></details>` : ''}
        ${r.error ? `<div style="color:var(--bad);font-size:14px">${esc(r.error)}</div>` : ''}</div>`).join('') || '<div class="muted">لا تشغيلات بعد</div>'}
    </div></div>
    <div class="card"><h2>الحالة</h2><div class="table-wrap"><table>
      ${d.state.map(s => `<tr><td class="ltr" style="text-align:start">${esc(s.key)}</td><td class="ltr" style="text-align:start">${esc(s.value)}</td><td class="num muted">${ago(s.updated_at)}</td></tr>`).join('')}
    </table></div></div>`;
};

// ---------- السجل ----------
VIEWS.log = async (el) => {
  const list = await api('events');
  el.innerHTML = `<div class="card"><h2>السجل (المحل والإعلانات)</h2><div class="list">${events(list)}</div></div>`;
};

// ---------- الإعدادات: حواجز البوابة ----------
const GUARD = {
  po_max_per_order: ['سقف أمر الشراء الواحد', 'ر.س'], po_max_per_day: ['سقف المشتريات اليومي', 'ر.س'],
  approval_ttl_hours: ['مهلة طلب الموافقة', 'ساعة'],
};
VIEWS.settings = async (el) => {
  const list = await api('guardrails');
  el.innerHTML = `<div class="card stack"><h2>حواجز البوابة</h2>
    <p class="muted" style="margin:0">نفس القيم التي تقرؤها SYS - Approval Gate ووكيلا الطلبات والأسعار. كل تعديل يُسجل في السجل.</p>
    ${list.map(g => `<form class="row" data-key="${esc(g.key)}">
      <label class="field" style="flex:1 1 220px">${esc((GUARD[g.key] || [g.key])[0])} <span class="ltr">(${esc(g.key)})</span>
        <input type="number" min="0" step="any" value="${esc(String(g.value).replace(/"/g, ''))}"></label>
      <span class="muted">${esc((GUARD[g.key] || [, ''])[1])}</span><button class="btn small primary">حفظ</button></form>`).join('')
      || '<div class="muted">لا توجد حواجز في biz_guardrails</div>'}
  </div>
  <div class="card row"><span>المظهر</span><span style="display:flex;gap:6px;flex-wrap:wrap">
    <button class="btn small" data-theme="">تلقائي</button><button class="btn small" data-theme="light">فاتح</button><button class="btn small" data-theme="dark">داكن</button>
    <button class="btn small" id="logout">خروج</button></span></div>`;
  el.querySelectorAll('form[data-key]').forEach(f => f.onsubmit = async (e) => {
    e.preventDefault();
    try { await api('guardrails/' + encodeURIComponent(f.dataset.key), { method: 'PUT', body: { value: f.querySelector('input').value } }); toast('حُفظ'); }
    catch (err) { toast(err.message); }
  });
  el.querySelectorAll('[data-theme]').forEach(b => b.onclick = () => setTheme(b.dataset.theme));
  $('#logout').onclick = async () => { await api('logout', { method: 'POST', body: {} }); showLogin(); };
};

function setTheme(t) {
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  try { localStorage.setItem('theme', t); } catch {}
}
try { setTheme(localStorage.getItem('theme') || ''); } catch {}

// ---------- البدء ----------
async function start() {
  try { await api('overview'); } catch { return showLogin(); }
  $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
  go();
  clearInterval(timer);
  timer = setInterval(() => { if (!document.hidden && ['home', 'approvals'].includes(current) && !document.querySelector('input:focus')) render(); }, 60000);
}
start();
