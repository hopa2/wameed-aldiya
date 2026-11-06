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
  success: ['ok', 'نجح'], error: ['bad', 'فشل'], crashed: ['bad', 'انقطع'], running: ['info', 'يعمل'], waiting: ['info', 'ينتظر'],
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
let current = 'ceo', timer = null;
function go() {
  current = (location.hash || '#ceo').slice(1);
  if (!VIEWS[current]) current = 'ceo';
  $('#view').classList.toggle('chat-view', current === 'ceo');
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
    <section class="grid" id="homeShop"><div class="card muted">جارٍ قراءة أرقام المحل…</div></section>
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
  api('shop').then(d => {
    const box = $('#homeShop'); if (!box) return;
    if (!d.ok) { box.innerHTML = `<div class="banner warn">أرقام المحل: ${esc(d.error)}</div>`; return; }
    box.innerHTML = shopTiles(d);
  }).catch(e => { const box = $('#homeShop'); if (box) box.innerHTML = `<div class="banner warn">أرقام المحل: ${esc(e.message)}</div>`; });
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

// ---------- الوكلاء ----------
const RUNNABLE = { 'BIZ - Reorder Suggest': 'reorder', 'BIZ - Pricing Suggest': 'pricing', 'ADS-30 وكيل إعلانات جوجل': 'ads_review' };
const canToggle = (w) => /^(BIZ|SYS|ADS|GBP)\b/i.test(w.name) && !/^SYS - Dashboard/.test(w.name);
VIEWS.agents = async (el) => {
  const list = await api('workflows');
  const groups = GROUPS.map(([p, title, sub]) => ({ title, sub, items: list.filter(w => new RegExp('^' + p + '\\s*-', 'i').test(w.name)) }));
  const used = new Set(groups.flatMap(g => g.items));
  groups.push({ title: 'أخرى', sub: '', items: list.filter(w => !used.has(w)) });
  el.innerHTML = `<div class="banner info">أغلب الوكلاء لا يحفظون سجل النجاح لتخفيف القاعدة، فغياب «آخر نجاح» لا يعني أنهم لم يعملوا. المهم عمود آخر فشل.</div>` + groups.filter(g => g.items.length).map(g => `
    <div class="card"><div class="row"><h2 style="margin:0">${esc(g.title)}</h2><span class="muted" style="font-size:13px">${esc(g.sub)}</span></div>
      <div class="table-wrap"><table>
        <tr><th>الاسم</th><th>الحالة</th><th>آخر فشل</th><th class="hide-sm">أخطاء 7 أيام</th><th>تحكم</th></tr>
        ${g.items.map(w => `<tr><td>${esc(w.name)}${w.description ? `<div class="muted hide-sm" style="font-size:12px">${esc(String(w.description).slice(0, 110))}</div>` : ''}</td>
          <td>${w.active ? '<span class="pill ok"><span class="dot"></span>مفعّل</span>' : '<span class="pill">متوقف</span>'}</td>
          <td class="num">${w.last_error_at ? `<span style="color:var(--bad)">${ago(w.last_error_at)}</span>` : '<span class="muted">لا يوجد</span>'}</td>
          <td class="hide-sm num">${num(w.errors7 || 0)}</td>
          <td><div class="btn-row">${RUNNABLE[w.name] ? `<button class="btn small primary" data-run="${RUNNABLE[w.name]}" data-name="${esc(w.name)}">تشغيل</button>` : ''}
            ${canToggle(w) ? `<button class="btn small ${w.active ? 'bad' : 'ok'}" data-toggle="${esc(w.id)}" data-active="${w.active ? 0 : 1}" data-name="${esc(w.name)}">${w.active ? 'إيقاف' : 'تفعيل'}</button>` : ''}</div></td></tr>`).join('')}
      </table></div></div>`).join('');
  el.querySelectorAll('[data-toggle]').forEach(b => b.onclick = async () => {
    const on = b.dataset.active === '1';
    if (!confirm(`${on ? 'تفعيل' : 'إيقاف'} ${b.dataset.name}؟`)) return;
    b.disabled = true;
    try { toast((await api(`workflows/${b.dataset.toggle}/active`, { method: 'POST', body: { active: on } })).message); } catch (e) { toast(e.message); }
    render();
  });
  el.querySelectorAll('[data-run]').forEach(b => b.onclick = async () => {
    if (!confirm(`تشغيل ${b.dataset.name} الآن؟ أي إجراء يصل إليك للموافقة.`)) return;
    b.disabled = true; toast('جارٍ التشغيل…');
    try { toast((await api(`agents/${b.dataset.run}/run`, { method: 'POST', body: {} })).message); } catch (e) { toast(e.message); }
    b.disabled = false;
  });
};

// ---------- الإعلانات ----------
VIEWS.ads = async (el) => {
  const [d, o] = await Promise.all([api('ads'), api('overview')]);
  header(o);
  const plan = d.plan, g = d.guard;
  el.innerHTML = `
    <div class="card row"><div><h2 style="margin:0">وكيل إعلانات جوجل</h2>
      <div class="muted" style="font-size:14px">كل أوامر البوت متاحة هنا. التنفيذ على الحساب يبقى ضمن قواعد الوكيل وفترة التجربة.</div></div>
      <div class="btn-row"><button class="btn primary" id="adsReview">فحص الآن</button>
      <a class="btn" href="#ceo" data-ask="راجع حالة إعلانات جوجل واقترح أهم 3 تحسينات، واذكر ما يحتاج قراري.">اسأل الرئيس عن التحسين</a>
      ${o.paused.ads ? '<button class="btn ok" data-pause="0" data-system="ads">▶️ استئناف</button>' : '<button class="btn bad" data-pause="1" data-system="ads">⛔ إيقاف الوكيل</button>'}</div></div>
    ${g && g.month ? `<div class="banner bad row">🛡️ الحارس أوقف الحملة: ${esc(g.reason || '')} <button class="btn small ok" id="adsResume">إعادة تشغيل الحملة</button></div>` : ''}
    ${plan && plan.plan_id ? `<div class="card stack"><div class="row"><h2 style="margin:0">خطة حملة البحث #${esc(plan.plan_id)}</h2>${pill(plan.status)}</div>
      ${plan.status === 'awaiting_approval' ? `<div class="btn-row"><button class="btn ok" data-plan="${esc(plan.plan_id)}">✅ اعتماد الخطة</button></div>` : ''}
      <details><summary class="muted">تفاصيل الخطة</summary><pre>${esc(JSON.stringify(plan, null, 2).slice(0, 12000))}</pre></details></div>` : ''}
    <div class="card"><h2>آخر الإجراءات</h2><div class="table-wrap"><table>
      <tr><th>#</th><th>الإجراء</th><th>الحالة</th><th class="hide-sm">السبب</th><th>متى</th><th></th></tr>
      ${d.actions.map(a => `<tr><td class="num">${a.action_id}</td><td class="ltr" style="text-align:start">${esc(a.action_type)}<div class="muted" style="font-size:12px">${esc(a.source)}</div></td>
        <td>${pill(a.status)}${a.undone_at ? ' ' + pill('undone') : ''}</td>
        <td class="hide-sm muted" style="font-size:13px">${esc(String(a.reason || a.reject_reason || '').slice(0, 200))}</td><td class="num">${when(a.created_at)}</td>
        <td>${a.can_undo ? `<button class="btn small" data-undo="${a.action_id}">تراجع</button>` : ''}</td></tr>`).join('')
        || '<tr><td colspan="6" class="muted">لا إجراءات بعد</td></tr>'}
    </table></div></div>
    <div class="card"><h2>آخر التشغيلات</h2><div class="list">
      ${d.runs.map(r => `<div><div class="row"><span>${esc(r.run_type)} ${pill(r.status)} ${r.dry_run ? pill('dry_run') : ''}</span><span class="muted" style="font-size:13px">${when(r.started_at)}</span></div>
        ${r.summary ? `<details><summary class="muted">الملخص</summary><div style="white-space:pre-wrap">${esc(r.summary)}</div></details>` : ''}
        ${r.error ? `<div style="color:var(--bad);font-size:14px">${esc(r.error)}</div>` : ''}</div>`).join('') || '<div class="muted">لا تشغيلات بعد</div>'}
    </div></div>
    <div class="card"><h2>الحالة</h2><div class="table-wrap"><table>
      ${d.state.map(s => `<tr><td class="ltr" style="text-align:start">${esc(s.key)}</td><td class="ltr" style="text-align:start">${esc(s.value)}</td><td class="num muted">${ago(s.updated_at)}</td></tr>`).join('')}
    </table></div></div>`;
  const act = async (b, msg, path, body = {}) => { if (!confirm(msg)) return; b.disabled = true; try { toast((await api(path, { method: 'POST', body })).message); } catch (e) { toast(e.message); } render(); };
  $('#adsReview').onclick = (e) => act(e.target, 'تشغيل فحص الإعلانات الآن؟ للمراقبة فقط، ولن يغيّر شيئًا.', 'agents/ads_review/run');
  const res = $('#adsResume'); if (res) res.onclick = (e) => act(e.target, 'إعادة تشغيل الحملة التي أوقفها الحارس؟ سيعود الصرف.', 'ads/resume');
  el.querySelectorAll('[data-plan]').forEach(b => b.onclick = () => act(b, `اعتماد الخطة ${b.dataset.plan}؟ ستُنفذ على حساب الإعلانات خلال 30 دقيقة.`, `ads/plan/${b.dataset.plan}/approve`));
  el.querySelectorAll('[data-undo]').forEach(b => b.onclick = () => act(b, `التراجع عن الإجراء #${b.dataset.undo}؟`, `ads/undo/${b.dataset.undo}`));
};

// ---------- المحل ----------
const change = (a, b) => { if (!b) return ''; const p = Math.round((a - b) / b * 100); return `<span style="color:var(--${p >= 0 ? 'ok' : 'bad'})">${p >= 0 ? '▲' : '▼'} ${Math.abs(p)}%</span>`; };
function shopTiles(d) {
  const p = d.periods, g = d.goal, r = d.receivables;
  return `<a class="card stat link" href="#shop"><div class="label">مبيعات اليوم</div><div class="value">${sar(p.today.total)}</div><div class="sub">${num(p.today.count)} فاتورة · أمس ${sar(p.yesterday.total)}</div></a>
    <a class="card stat link" href="#shop"><div class="label">هدف الشهر (${num(g.target)})</div><div class="value">${num(g.pct)}%</div><div class="meter"><i style="width:${Math.min(100, g.pct)}%"></i></div><div class="sub">${sar(p.month.total)} · المطلوب يوميًا ${sar(g.need_daily)}</div></a>
    <a class="card stat link" href="#shop"><div class="label">الذمم على العملاء</div><div class="value">${sar(r.total)}</div><div class="sub">${num(r.count)} عميل · متأخر +30 يوم ${sar(r.overdue30)}</div></a>`;
}
const stale = (d) => d.stale ? `<div class="banner warn">هذه آخر أرقام نجحت قراءتها، لأن Manager لا يرد الآن: ${esc(d.stale_error)}</div>` : '';
const partial = (d) => { const miss = Object.entries(d.partial || {}).filter(([, v]) => v).map(([k]) => ({ customers: 'العملاء', items: 'الأصناف', receipts: 'القبض', payments: 'الصرف' }[k])); return miss.length ? `<div class="banner warn">تعذّرت قراءة: ${esc(miss.join('، '))}</div>` : ''; };
function bars(daily) {
  const max = Math.max(1, ...daily.map(x => x.t));
  const total = daily.reduce((a, x) => a + x.t, 0);
  return `<div class="bars" role="img" aria-label="مبيعات آخر 30 يومًا، الإجمالي ${num(total)} ريال">${daily.map((x, i) => `<div class="bar${i === daily.length - 1 ? ' now' : ''}" title="${esc(x.d)}: ${num(x.t)} ر.س، ${x.n} فاتورة"><i style="height:${Math.max(x.t ? 3 : 0, Math.round(x.t / max * 100))}%"></i></div>`).join('')}</div>
    <div class="row muted" style="font-size:13px"><span>${esc(daily[0].d)}</span><span>أعلى يوم ${num(max)} ر.س</span><span>${esc(daily[daily.length - 1].d)}</span></div>`;
}
const waLink = (c) => c.wa ? `<a class="btn small" href="https://wa.me/${esc(c.wa)}" target="_blank" rel="noopener">واتساب</a>` : '<span class="muted" style="font-size:13px">لا يوجد رقم</span>';
const methods = (m) => Object.entries(m || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${esc(k)} ${num(v)}`).join(' · ') || '—';
VIEWS.shop = async (el) => {
  el.innerHTML = '<div class="card muted">جارٍ القراءة من Manager.io…</div>';
  const d = await api('shop');
  if (!d.ok) { el.innerHTML = `<div class="banner bad">${esc(d.error)}</div>`; return; }
  const p = d.periods, g = d.goal;
  el.innerHTML = `${stale(d)}${partial(d)}
    <section class="grid">${shopTiles(d)}
      <div class="card stat"><div class="label">نقدية اليوم</div><div class="value">${d.cash.in ? sar(d.cash.in.today) : '—'}</div><div class="sub">قبض · صرف ${d.cash.out ? sar(d.cash.out.today) : '—'}</div></div></section>
    <div class="card stack"><div class="row"><h2 style="margin:0">مبيعات آخر 30 يومًا</h2><button class="btn small" id="shopFresh">تحديث الآن</button></div>${bars(d.daily)}
      <div class="muted" style="font-size:14px">التوقع لنهاية الشهر بالمعدل الحالي: ${sar(g.forecast)} · باقي ${num(g.days_left)} يوم</div></div>
    <div class="card"><h2>الفترات</h2><div class="table-wrap"><table><tr><th>الفترة</th><th>المبيعات</th><th>الفواتير</th><th class="hide-sm">المتوسط</th><th class="hide-sm">طريقة الدفع</th></tr>
      ${['today', 'yesterday', 'week', 'lastWeek', 'month', 'lastMonthSame', 'lastMonth'].map(k => `<tr><td>${esc(p[k].label)}</td><td class="num">${sar(p[k].total)}</td><td class="num">${num(p[k].count)}</td><td class="hide-sm num">${sar(p[k].avg)}</td><td class="hide-sm muted">${methods(p[k].methods)}</td></tr>`).join('')}
    </table></div><p class="muted" style="font-size:13px;margin:8px 0 0">لا أعرض الربح هنا لأن تكاليف المخزون غير مضبوطة بعد.</p></div>
    <section class="grid wide">
      <div class="card"><h2>فواتير اليوم (${d.today_invoices.length})</h2><div class="table-wrap"><table><tr><th>#</th><th>العميل</th><th>المبلغ</th><th>الدفع</th></tr>
        ${d.today_invoices.map(i => `<tr><td class="num">${esc(i.ref)}</td><td>${esc(i.customer)}</td><td class="num">${sar(i.amount)}</td><td>${esc(i.method)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">لا فواتير اليوم حتى الآن</td></tr>'}</table></div></div>
      <div class="card"><h2>أكبر المدينين</h2><div class="table-wrap"><table><tr><th>العميل</th><th>المبلغ</th><th>منذ</th><th></th></tr>
        ${d.receivables.list.slice(0, 15).map(c => `<tr><td>${esc(c.name)}</td><td class="num">${sar(c.amount)}</td><td class="num">${c.days === null ? '—' : num(c.days) + ' يوم'}</td><td>${waLink(c)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">لا ذمم</td></tr>'}</table></div>
        <p class="muted" style="font-size:13px;margin:8px 0 0">الرابط يفتح المحادثة فقط، والرسالة ترسلها بنفسك.</p></div>
    </section>
    <div class="card stack"><div class="row"><h2 style="margin:0">المخزون</h2><span class="muted">${d.inventory ? `${num(d.inventory.count)} صنف · القيمة ${sar(d.inventory.value)} · ${num(d.inventory.negative)} صنف بكمية سالبة في النظام · ${num(d.inventory.no_price)} بلا سعر` : 'تعذّرت القراءة'}</span></div>
      <div class="row" style="flex-wrap:nowrap"><input type="text" id="itemQ" placeholder="ابحث عن صنف"><button class="btn" id="itemGo">بحث</button></div><div id="itemRes"></div>
      <button class="btn" id="invLoad">حساب النواقص والأكثر مبيعًا (دقيقة تقريبًا)</button><div id="invRes"></div></div>`;
  $('#shopFresh').onclick = async (e) => { e.target.disabled = true; await api('shop?fresh=1').catch(() => {}); render(); };
  const search = async () => {
    const list = await api('items?q=' + encodeURIComponent($('#itemQ').value)).catch(e => { toast(e.message); return []; });
    $('#itemRes').innerHTML = `<div class="table-wrap"><table><tr><th>الصنف</th><th>الكمية</th><th>البيع</th><th class="hide-sm">الشراء</th></tr>${list.map(i => `<tr><td>${esc(i.name)}</td><td class="num">${num(i.owned, i.owned % 1 ? 2 : 0)} ${esc(i.unit)}</td><td class="num">${sar(i.price)}</td><td class="hide-sm num">${sar(i.cost)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">لا نتائج</td></tr>'}</table></div>`;
  };
  $('#itemGo').onclick = search;
  $('#itemQ').onkeydown = (e) => { if (e.key === 'Enter') search(); };
  $('#invLoad').onclick = async (e) => {
    e.target.disabled = true; $('#invRes').innerHTML = '<div class="muted">جارٍ قراءة فواتير آخر 30 يومًا بهدوء حتى لا يثقل جهاز المحل…</div>';
    try {
      const a = await api('inventory');
      const tbl = (title, rows, cols) => `<h3>${title}</h3><div class="table-wrap"><table><tr>${cols.map(c => `<th>${c[0]}</th>`).join('')}</tr>${rows.map(r => `<tr>${cols.map(c => `<td>${esc(c[1](r))}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${cols.length}" class="muted">لا يوجد</td></tr>`}</table></div>`;
      $('#invRes').innerHTML = tbl('قاربت النفاد (أقل من 10 أيام)', a.low, [['الصنف', r => r.name], ['الكمية', r => r.owned], ['مبيع 30 يوم', r => r.sold30], ['يكفي', r => r.cover_days + ' يوم']])
        + tbl('الأكثر مبيعًا', a.top, [['الصنف', r => r.name], ['الكمية المبيعة', r => r.sold30], ['القيمة', r => sar(r.rev30)]])
        + tbl('مشاكل جرد', a.problems, [['الصنف', r => r.name], ['المملوك', r => r.owned], ['الموجود', r => r.hand]])
        + tbl('أموال راكدة', a.stale, [['الصنف', r => r.name], ['الكمية', r => r.owned], ['القيمة', r => sar(r.value)]]);
    } catch (err) { $('#invRes').innerHTML = `<div class="banner warn">${esc(err.message)}</div>`; }
    e.target.disabled = false;
  };
};

// ---------- التقارير ----------
let reportKind = 'day';
VIEWS.reports = async (el) => {
  el.innerHTML = '<div class="card muted">جارٍ تجهيز التقرير…</div>';
  const d = await api('shop');
  if (!d.ok) { el.innerHTML = `<div class="banner bad">${esc(d.error)}</div>`; return; }
  const p = d.periods;
  const K = { day: ['اليومي', p.today, p.yesterday, 'أمس', 'today'], week: ['الأسبوعي', p.week, p.lastWeek, 'الأسبوع الماضي', 'week'], month: ['الشهري', p.month, p.lastMonthSame, 'نفس الفترة من الشهر الماضي', 'month'] };
  const [title, a, b, bl, ck] = K[reportKind];
  const tiles = `<section class="grid">
    <div class="card stat"><div class="label">المبيعات</div><div class="value">${sar(a.total)}</div><div class="sub">${change(a.total, b.total)} مقابل ${esc(bl)} (${sar(b.total)})</div></div>
    <div class="card stat"><div class="label">الفواتير</div><div class="value">${num(a.count)}</div><div class="sub">المتوسط ${sar(a.avg)}</div></div>
    <div class="card stat"><div class="label">القبض</div><div class="value">${d.cash.in ? sar(d.cash.in[ck]) : '—'}</div><div class="sub">سندات القبض</div></div>
    <div class="card stat"><div class="label">الصرف</div><div class="value">${d.cash.out ? sar(d.cash.out[ck]) : '—'}</div><div class="sub">سندات الصرف</div></div></section>`;
  const dbt = d.receivables.list.filter(c => c.days > 30).slice(0, 10);
  el.innerHTML = `${stale(d)}<div class="card row no-print"><div class="btn-row">${Object.entries(K).map(([k, v]) => `<button class="btn small ${k === reportKind ? 'primary' : ''}" data-kind="${k}">${v[0]}</button>`).join('')}</div>
      <div class="btn-row"><a class="btn small" href="#ceo" data-ask="اكتب لي قراءة للتقرير ${esc(title)}: ماذا تغير، وما أهم إجراء واحد؟">اطلب تحليل الرئيس</a><button class="btn small" id="repPrint">طباعة / PDF</button></div></div>
    <div class="card"><h2 style="margin:0">التقرير ${esc(title)} · ${esc(a.from === a.to ? a.from : a.from + ' إلى ' + a.to)}</h2><div class="muted">طريقة الدفع: ${methods(a.methods)}</div></div>
    ${tiles}
    ${reportKind === 'month' ? `<div class="card stack"><h2 style="margin:0">الهدف الشهري</h2><div class="meter"><i style="width:${Math.min(100, d.goal.pct)}%"></i></div><div>${num(d.goal.pct)}% من ${sar(d.goal.target)} · الناقص ${sar(d.goal.gap)} · المطلوب يوميًا ${sar(d.goal.need_daily)} · التوقع ${sar(d.goal.forecast)}</div></div>` : ''}
    <section class="grid wide">
      <div class="card"><h2>أعلى العملاء (30 يومًا)</h2><div class="table-wrap"><table>${d.top_customers.map(c => `<tr><td>${esc(c.name)}</td><td class="num">${sar(c.total)}</td></tr>`).join('') || '<tr><td class="muted">لا يوجد</td></tr>'}</table></div></div>
      <div class="card"><h2>آجل متأخر +30 يوم</h2><div class="table-wrap"><table>${dbt.map(c => `<tr><td>${esc(c.name)}</td><td class="num">${sar(c.amount)}</td><td class="num">${num(c.days)} يوم</td><td class="no-print">${waLink(c)}</td></tr>`).join('') || '<tr><td class="muted">لا يوجد</td></tr>'}</table></div></div>
      <div class="card"><h2>عملاء توقفوا عن الشراء</h2><div class="table-wrap"><table>${d.lapsed.slice(0, 10).map(c => `<tr><td>${esc(c.name)}</td><td class="num">${num(c.days)} يوم</td><td class="no-print">${waLink(c)}</td></tr>`).join('') || '<tr><td class="muted">لا يوجد</td></tr>'}</table></div></div>
    </section>
    <p class="muted no-print" style="font-size:13px">الأرقام مقروءة مباشرة من Manager.io. التقارير المجدولة تبقى تصلك أنت وشريكك في تيليجرام كما هي.</p>`;
  el.querySelectorAll('[data-kind]').forEach(b => b.onclick = () => { reportKind = b.dataset.kind; render(); });
  $('#repPrint').onclick = () => window.print();
};

// ---------- واتساب ----------
VIEWS.whatsapp = async (el) => {
  const d = await api('whatsapp');
  const ses = Array.isArray(d.sessions) ? d.sessions : [];
  const working = ses.some(s => s.status === 'WORKING');
  const quotes = Array.isArray(d.quotes) ? d.quotes : [];
  el.innerHTML = `<div class="card stack"><div class="row"><h2 style="margin:0">جلسة واتساب</h2><span class="pill ${working ? 'ok' : 'bad'}"><span class="dot"></span>${working ? 'متصلة' : 'غير متصلة'}</span></div>
      <div class="muted">${d.sessions?.error ? esc(d.sessions.error) : ses.map(s => `${esc(s.name)}: ${esc(s.status)}${s.me ? ' · ' + esc(s.me) : ''}`).join('، ') || 'لا توجد جلسة'}</div>
      <div class="btn-row"><button class="btn" id="waQr">عرض رمز الربط</button><button class="btn" id="waRestart">إعادة تشغيل الجلسة</button></div><div id="waQrBox"></div>
      <p class="muted" style="font-size:13px;margin:0">الرد الآلي ما زال مقيدًا بأرقام الاختبار حتى تقرر فتحه. WAHA طريقة غير رسمية، وفيها خطر حظر الرقم.</p></div>
    <div class="card"><h2>عروض الأسعار</h2>${d.quotes?.error ? `<div class="banner warn">تعذّرت القراءة: ${esc(d.quotes.error)}</div>` : ''}<div class="list">
      ${quotes.map(x => `<div class="stack"><div class="row"><strong>${esc(x.customer)}</strong>${pill(x.status)}</div><div class="preview-box">${esc(String(x.text || '').slice(0, 700))}</div>
        ${x.status === 'pending' ? `<div class="btn-row"><button class="btn ok small" data-q="${esc(x.token)}" data-a="send">✅ أرسل للعميل</button><button class="btn bad small" data-q="${esc(x.token)}" data-a="decline">❌ لا ترسل</button></div>` : ''}</div>`).join('') || '<div class="muted">لا عروض بعد</div>'}
    </div></div>`;
  $('#waQr').onclick = async () => {
    try { const r = await api('whatsapp/qr'); $('#waQrBox').innerHTML = `<img src="${esc(r.image)}" alt="رمز ربط واتساب" width="260" height="260" class="qr"><div class="muted" style="font-size:13px">امسحه من جوال المحل: الأجهزة المرتبطة ثم ربط جهاز.</div>`; }
    catch (e) { $('#waQrBox').innerHTML = `<div class="banner warn">${esc(e.message)}</div>`; }
  };
  $('#waRestart').onclick = async () => { if (!confirm('إعادة تشغيل جلسة واتساب؟ قد تتأخر الرسائل قليلًا.')) return; try { await api('whatsapp/restart', { method: 'POST', body: {} }); toast('أعيد التشغيل'); } catch (e) { toast(e.message); } setTimeout(render, 4000); };
  el.querySelectorAll('[data-q]').forEach(b => b.onclick = async () => {
    const send = b.dataset.a === 'send';
    if (send && !confirm('إرسال عرض السعر للعميل الآن؟')) return;
    b.disabled = true;
    try { await api(`whatsapp/quotes/${b.dataset.q}/${b.dataset.a}`, { method: 'POST', body: {} }); toast(send ? 'أُرسل الطلب، والتأكيد في تيليجرام' : 'لن يُرسل العرض'); } catch (e) { toast(e.message); }
    setTimeout(render, 1500);
  });
};

// ---------- ملف جوجل التجاري ----------
VIEWS.gbp = async (el) => {
  const d = await api('gbp');
  const done = d.checklist.filter(c => c.done).length;
  const asks = [['منشور خرائط لهذا الأسبوع', 'اكتب منشور خرائط جوجل لهذا الأسبوع عن قسم مناسب من المحل، بلهجة بسيطة وبلا أسعار، مع عبارة دعوة للزيارة.'],
    ['خطة تحسين للترتيب المحلي', 'راجع قائمة تحسين ملف جوجل التجاري، ورتب لي أهم 3 خطوات بقيت لتحسين الترتيب في الحشيبرية وصبيا.'],
    ['رد على تقييم', 'اكتب لي 3 قوالب رد قصيرة: تقييم ممتاز، تقييم متوسط، تقييم سلبي. بلا وعود ولا خصومات.']];
  el.innerHTML = `<div class="banner info">النشر الآلي في الملف ينتظر موافقة Google على API، والمتابعة 17 نوفمبر. حتى ذلك الوقت: تجهز المسودات هنا وتنشرها أنت من الملف.</div>
    <div class="card stack"><div class="row"><h2 style="margin:0">قائمة التحسين</h2><span class="muted">${done} من ${d.checklist.length}</span></div><div class="meter"><i style="width:${Math.round(done / d.checklist.length * 100)}%"></i></div>
      <div class="list">${d.checklist.map(c => `<label class="switch check"><input type="checkbox" data-key="${esc(c.key)}" ${c.done ? 'checked' : ''}><span>${esc(c.title)}</span></label>`).join('')}</div></div>
    <div class="card stack"><h2 style="margin:0">اطلب من الرئيس التنفيذي</h2><div class="btn-row">${asks.map(a => `<a class="btn" href="#ceo" data-ask="${esc(a[1])}">${esc(a[0])}</a>`).join('')}</div></div>
    <div class="card"><h2>الوكلاء</h2><div class="list">${(Array.isArray(d.workflows) ? d.workflows : []).map(w => `<div class="row"><span>${esc(w.name)}</span>${w.active ? '<span class="pill ok"><span class="dot"></span>مفعّل</span>' : '<span class="pill">متوقف</span>'}</div>`).join('') || '<div class="muted">لا يوجد</div>'}</div>
      <p class="muted" style="font-size:13px;margin:8px 0 0">طلبات التقييم تصلك يوميًا 9:40 مساءً في تيليجرام، وترسلها بنفسك.</p></div>`;
  el.querySelectorAll('[data-key]').forEach(i => i.onchange = async () => { try { await api('gbp/' + i.dataset.key, { method: 'PUT', body: { done: i.checked } }); render(); } catch (e) { toast(e.message); } });
};

// ---------- الرئيس التنفيذي ----------
let pendingAsk = '';
document.addEventListener('click', (e) => { const a = e.target.closest('[data-ask]'); if (a) pendingAsk = a.dataset.ask; });
const rich = (t) => esc(t).replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
const PSTATUS = { pending: 'warn', running: 'info', done: 'ok', failed: 'bad', rejected: '', expired: '' };
const PLABEL = { pending: 'بانتظار قرارك', running: 'قيد التنفيذ', done: 'نُفذ', failed: 'فشل', rejected: 'مرفوض', expired: 'انتهت المهلة' };
const propCard = (p) => `<div class="card prop stack" data-prop="${p.id}"><div class="row"><strong>${esc(p.title)}</strong><span class="pill ${PSTATUS[p.status] || ''}"><span class="dot"></span>${esc(PLABEL[p.status] || p.status)}</span></div>
    ${p.reason ? `<div class="muted" style="font-size:14px">${esc(p.reason)}</div>` : ''}${p.result ? `<div style="font-size:14px">${esc(p.result)}</div>` : ''}
    ${p.status === 'pending' ? `<div class="btn-row"><button class="btn ok small" data-pc="confirm">✅ موافق</button><button class="btn bad small" data-pc="reject">❌ رفض</button></div>` : ''}</div>`;
const CHIPS = [['موجز اليوم', 'أعطني موجز اليوم: المبيعات والهدف والذمم، وأهم قرار ينتظرني.'], ['وش ناقص؟', 'ما الأصناف التي قاربت النفاد؟ وهل أشغل وكيل المشتريات؟'], ['من أتابع؟', 'من أهم العملاء الذين أتابعهم اليوم في الذمم والمتوقفين؟'], ['حالة المنظومة', 'افحص المنظومة: هل يوجد وكيل معطل أو فاشل؟'], ['الإعلانات', 'كيف أداء الإعلانات؟ وما أهم تحسين؟'], ['الخرائط', 'ما أهم خطوة بقيت لتحسين ملفنا في خرائط جوجل؟']];
VIEWS.ceo = async (el) => {
  const d = await api('chat');
  api('overview').then(header).catch(() => {});
  const props = Object.fromEntries(d.proposals.map(p => [p.id, p]));
  const shown = new Set();
  const msgs = d.messages.map(m => {
    const cards = (m.meta?.proposals || []).map(id => { shown.add(Number(id)); return props[id] ? propCard(props[id]) : ''; }).join('');
    return `<div class="msg ${m.role}"><div class="bubble">${rich(m.content)}</div></div>${cards}`;
  }).join('');
  const extra = d.proposals.filter(p => p.status === 'pending' && !shown.has(Number(p.id))).map(propCard).join('');
  
  const draft = $('#ceoIn')?.value || '';
  el.innerHTML = `<div class="chat">
      <div class="chat-log" id="ceoLog" aria-live="polite">${msgs || `<div class="chat-empty"><h2>أهلًا عبدالوهاب</h2><p class="muted">اسأل عن المحل، أو اطلب توجيه وكيل. لا يُنفذ شيء إلا بعد موافقتك على البطاقة.</p></div>`}${extra}</div>
      <div class="chips">${CHIPS.map(c => `<button class="chip" data-chip="${esc(c[1])}">${esc(c[0])}</button>`).join('')}</div>
      <form class="chat-form" id="ceoForm"><textarea id="ceoIn" rows="1" placeholder="اكتب للرئيس التنفيذي…" aria-label="رسالتك"></textarea><button class="btn primary" id="ceoSend">إرسال</button></form>
      <div class="row muted chat-foot"><span>العقل: ${esc(d.model)} على اللابتوب. البيانات لا تخرج إلى السحابة.</span><button class="btn small" id="ceoReset">محادثة جديدة</button></div></div>`;
  const log = $('#ceoLog'), input = $('#ceoIn');
  input.value = draft;
  log.scrollTop = log.scrollHeight;
  const send = async (text) => {
    text = String(text || '').trim(); if (!text) return;
    input.value = ''; $('#ceoSend').disabled = true;
    log.querySelector('.chat-empty')?.remove();
    log.insertAdjacentHTML('beforeend', `<div class="msg user"><div class="bubble">${rich(text)}</div></div><div class="msg assistant" id="ceoWait"><div class="bubble muted">الرئيس يفكر… <span id="ceoStep"></span></div></div>`);
    log.scrollTop = log.scrollHeight;
    try {
      const r = await fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'wameed' }, body: JSON.stringify({ message: text }) });
      if (r.status === 401) return showLogin();
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'خطأ ' + r.status);
      const reader = r.body.getReader(), dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n'); buf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          const ev = JSON.parse(line);
          if (ev.type === 'step') { const s = $('#ceoStep'); if (s) s.textContent = '· ' + ev.text; }
        }
      }
    } catch (e) { toast(e.message); }
    if (current === 'ceo') render();
  };
  $('#ceoForm').onsubmit = (e) => { e.preventDefault(); send(input.value); };
  input.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !('ontouchstart' in window)) { e.preventDefault(); send(input.value); } };
  el.querySelectorAll('[data-chip]').forEach(b => b.onclick = () => send(b.dataset.chip));
  $('#ceoReset').onclick = async () => { await api('chat/reset', { method: 'POST', body: {} }).catch(() => {}); render(); };
  el.querySelectorAll('[data-pc]').forEach(b => b.onclick = async () => {
    const card = b.closest('[data-prop]'), id = card.dataset.prop, ok = b.dataset.pc === 'confirm';
    card.querySelectorAll('button').forEach(x => x.disabled = true);
    try { toast((await api(`proposals/${id}/${ok ? 'confirm' : 'reject'}`, { method: 'POST', body: {} })).message); } catch (e) { toast(e.message); }
    render();
  });
  if (pendingAsk) { const a = pendingAsk; pendingAsk = ''; send(a); }
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
