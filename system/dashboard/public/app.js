'use strict';
// واجهة لوحة وميض الضياء: صفحة واحدة بلا مكتبات.
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
  ok: ['ok', 'نجح'], needs_data: ['warn', 'ينقصه بيانات'], paused: ['info', 'موقوف'], error: ['bad', 'فشل'], invalid_output: ['bad', 'رد غير صالح'],
  pending: ['warn', 'بانتظارك'], auto_approved: ['info', 'معتمد آليًا'], approved: ['info', 'اعتمدته'], rejected: ['', 'رفضته'],
  auto_rejected: ['bad', 'رفضته البوابة'], expired: ['', 'انتهت المهلة'], dry_run: ['info', 'تجربة: لم يُنفذ'], executing: ['info', 'يُنفذ'],
  executed: ['ok', 'نُفذ'], failed: ['bad', 'فشل التنفيذ'], needs_manual: ['warn', 'ينتظر تنفيذك اليدوي'],
};
const pill = (s) => { const [c, t] = STATUS[s] || ['', s || '—']; return `<span class="pill ${c}"><span class="dot"></span>${esc(t)}</span>`; };
const TRIGGER = { schedule: 'مجدول', dashboard: 'من اللوحة', whatsapp: 'واتساب', external: 'خارجي', chain: 'تسلسل', manual: 'يدوي', test: 'اختبار' };

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
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add('hidden'), 3500);
}
function dialog(html) { $('#dlgBody').innerHTML = html; $('#dlg').showModal(); }

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

async function refreshHeader(o) {
  o = o || await api('overview');
  const b = $('#pendingBadge'); b.textContent = o.pending; b.classList.toggle('hidden', !o.pending);
  $('#pauseBox').innerHTML = o.paused
    ? `<button class="btn ok" data-pause="0">▶️ استئناف</button>`
    : `<button class="btn bad" data-pause="1">⛔ إيقاف الكل</button>`;
  return o;
}
document.addEventListener('click', async (e) => {
  const p = e.target.closest('[data-pause]');
  if (!p) return;
  const paused = p.dataset.pause === '1';
  if (paused && !confirm('إيقاف كل الوكلاء والتنفيذ حتى تستأنف؟')) return;
  await api('pause', { method: 'POST', body: { paused } });
  toast(paused ? 'أُوقفت المنظومة' : 'استُؤنفت المنظومة'); render();
});

// ---------- الرئيسية ----------
VIEWS.home = async (el) => {
  const o = await refreshHeader();
  const banners = [];
  if (o.paused) banners.push(`<div class="banner bad">⛔ المنظومة موقوفة: لا تشغيل ولا تنفيذ حتى تضغط «استئناف».</div>`);
  if (!o.live.ollama.ok) banners.push(`<div class="banner bad">🚨 Ollama لا يرد: الوكلاء لن يعملوا، وموجز الصباح يصل بالقالب الثابت.</div>`);
  if (o.dry_run_until && o.dry_run_until > o.today) banners.push(`<div class="banner info">🧪 فترة التجربة حتى ${esc(o.dry_run_until)}: الإجراءات التلقائية تُسجل ولا تُنفذ (ما تعتمده أنت يُنفذ).</div>`);
  if (o.shadow_mode) banners.push(`<div class="banner warn">👁️ وضع الظل لواتساب: لا يصل أي رد لعميل إلا بموافقتك.</div>`);
  if (!o.stock_updated_at) banners.push(`<div class="banner warn">📥 لا توجد بيانات مخزون أو مبيعات بعد: الوكلاء سيقولون «غير متوفر» حتى تُربط مزامنة Manager.io.</div>`);

  const y = o.sales_yesterday, w = o.sales_week_ago;
  const change = y && w && Number(w.total_sales) ? ((y.total_sales - w.total_sales) / w.total_sales * 100) : null;
  const capPct = Math.min(100, Math.round((Number(o.cap_used) / Number(o.cap_daily || 1)) * 100));
  const health = Object.fromEntries((o.health || []).map(h => [h.component, h]));
  const hRow = (name, ok, detail, at) => `<div class="row"><span>${name}</span><span>${ok === null ? '<span class="pill">لم يُفحص</span>' : `<span class="pill ${ok ? 'ok' : 'bad'}"><span class="dot"></span>${ok ? 'يعمل' : 'متوقف'}</span>`}</span>
      <div class="muted" style="flex-basis:100%;font-size:13px">${esc(detail || '')}${at ? ' · ' + ago(at) : ''}</div></div>`;

  el.innerHTML = `
    ${banners.join('')}
    <section class="grid">
      <div class="card stat"><div class="label">مبيعات الأمس</div><div class="value">${y ? sar(y.total_sales) : '—'}</div>
        <div class="sub">${y ? num(y.invoice_count) + ' فاتورة' : 'لا بيانات'}${change !== null ? ` · ${change >= 0 ? '▲' : '▼'} ${num(Math.abs(change), 1)}% عن الأسبوع الماضي` : ''}</div></div>
      <a class="card stat" href="#approvals" style="text-decoration:none;color:inherit"><div class="label">بانتظار قرارك</div><div class="value">${num(o.pending)}</div>
        <div class="sub">${o.manual ? num(o.manual) + ' مهام يدوية معتمدة' : 'لا مهام يدوية'}</div></a>
      <div class="card stat"><div class="label">سقف اليوم المستخدم</div><div class="value">${sar(o.cap_used)}</div>
        <div class="meter"><i style="width:${capPct}%"></i></div><div class="sub">من ${sar(o.cap_daily)}</div></div>
      <div class="card stat"><div class="label">أصناف تحت حد الطلب</div><div class="value">${num(o.low_stock)}</div><div class="sub">${o.stock_updated_at ? 'آخر تحديث ' + ago(o.stock_updated_at) : '—'}</div></div>
      <div class="card stat"><div class="label">متأخرات +30 يوم</div><div class="value">${sar(o.overdue_30)}</div></div>
      <div class="card stat"><div class="label">آخر 24 ساعة</div><div class="value">${num(o.runs_24h)} <span style="font-size:1rem">تشغيل</span></div>
        <div class="sub">${o.errors_24h ? `<span style="color:var(--bad)">${num(o.errors_24h)} فشل</span>` : 'بلا فشل'} · ${num(o.blocked_24h)} رفض آلي</div></div>
    </section>
    <section class="grid wide">
      <div class="card"><h2>حالة الأجهزة</h2><div class="list">
        ${hRow('n8n (اللابتوب)', o.live.n8n.ok, o.live.n8n.error)}
        ${hRow('Ollama (العقل المحلي)', o.live.ollama.ok,
               o.live.ollama.ok ? (o.live.ollama.loaded.length ? 'في الذاكرة: ' + o.live.ollama.loaded.map(m => `${m.name} (${m.vram_gb}GB على كرت الشاشة)`).join('، ') : 'مثبت: ' + o.live.ollama.models.join('، ')) : o.live.ollama.error)}
        ${hRow('واتساب WAHA (Synology)', health.waha ? health.waha.ok : null, health.waha?.detail, health.waha?.checked_at)}
      </div></div>
      <div class="card"><h2>آخر الأحداث</h2><div class="list">
        ${(o.events || []).map(e => `<div><div class="row"><span class="pill ${e.level === 'error' ? 'bad' : e.level === 'warn' ? 'warn' : ''}">${esc(e.source)}</span><span class="muted" style="font-size:13px">${ago(e.ts)}</span></div><div>${esc(e.message)}</div></div>`).join('') || '<div class="muted">لا أحداث بعد</div>'}
      </div></div>
    </section>`;
};

// ---------- الموافقات ----------
VIEWS.approvals = async (el) => {
  const [pending, manual, all] = await Promise.all([api('actions?status=pending'), api('actions?status=manual'), api('actions?status=all')]);
  refreshHeader();
  const recent = all.filter(a => !['pending', 'needs_manual'].includes(a.status)).slice(0, 30);
  el.innerHTML = `
    <h2>بانتظار قرارك (${pending.length})</h2>
    ${pending.length ? '' : '<div class="card muted">لا شيء بانتظارك الآن 👍</div>'}
    ${pending.map(a => `
      <div class="card approval stack" data-id="${a.id}">
        <div class="row"><strong>#${a.id} · ${esc(a.type_label || a.type)}</strong><span class="muted" style="font-size:13px">${esc(a.agent_label)} · ينتهي ${when(a.expires_at)}</span></div>
        <div class="preview">${esc((a.preview || '').split('\n').slice(1, -2).join('\n'))}</div>
        <div class="muted" style="font-size:13px">${esc(a.gate_reason || '')}</div>
        <div class="actions"><button class="btn ok" data-decide="approve">✅ موافقة</button><button class="btn bad" data-decide="reject">❌ رفض</button></div>
      </div>`).join('')}
    ${manual.length ? `<h2>معتمد وينتظر تنفيذك اليدوي (${manual.length})</h2>
      ${manual.map(a => `<div class="card stack" data-id="${a.id}"><div class="row"><strong>#${a.id} · ${esc(a.type_label)}</strong>
        <button class="btn small" data-done="1">تم التنفيذ</button></div>
        <div class="muted">${esc(a.reason || '')} · ${a.total_sar > 0 ? sar(a.total_sar) : ''}</div>
        <details><summary class="muted">التفاصيل</summary><pre>${esc(JSON.stringify(a.payload, null, 2))}</pre></details></div>`).join('')}` : ''}
    <div class="card"><h2>آخر القرارات</h2><div class="table-wrap"><table>
      <tr><th>#</th><th>الإجراء</th><th class="hide-sm">الوكيل</th><th>الحالة</th><th class="hide-sm">السبب</th><th>متى</th></tr>
      ${recent.map(a => `<tr><td class="num">${a.id}</td><td>${esc(a.type_label || a.type)}${a.total_sar > 0 ? '<br><span class="muted">' + sar(a.total_sar) + '</span>' : ''}</td>
        <td class="hide-sm">${esc(a.agent_label)}</td><td>${pill(a.status)}</td><td class="hide-sm muted">${esc(a.gate_reason || '')}</td><td class="num">${when(a.decided_at || a.created_at)}</td></tr>`).join('')}
    </table></div></div>`;
  el.querySelectorAll('[data-decide]').forEach(b => b.onclick = async () => {
    const card = b.closest('[data-id]'); card.querySelectorAll('button').forEach(x => x.disabled = true);
    try {
      const r = await api(`actions/${card.dataset.id}/decide`, { method: 'POST', body: { decision: b.dataset.decide } });
      toast(r.status === 'approved' ? (r.exec && !r.exec.ok ? 'اعتُمد، لكن n8n لم يستلم التنفيذ: ' + r.exec.error : 'اعتُمد وأُرسل للتنفيذ')
          : r.status === 'rejected' ? 'رُفض، لم يُنفذ شيء' : (r.gate_reason || r.status));
    } catch (e) { toast(e.message); }
    render();
  });
  el.querySelectorAll('[data-done]').forEach(b => b.onclick = async () => {
    await api(`actions/${b.closest('[data-id]').dataset.id}/done`, { method: 'POST', body: {} }); toast('سُجل كمنفّذ'); render();
  });
};

// ---------- الوكلاء ----------
VIEWS.agents = async (el) => {
  const agents = await api('agents');
  el.innerHTML = `<section class="grid wide">${agents.map(a => `
    <div class="card stack" data-agent="${esc(a.name)}">
      <div class="row"><h3 style="margin:0">${esc(a.label_ar)}</h3>${a.last_status ? pill(a.last_status) : '<span class="pill">لم يعمل بعد</span>'}</div>
      <div class="muted" style="font-size:14px">${esc(a.description_ar || '')}</div>
      ${a.last_summary ? `<div style="white-space:pre-wrap">${esc(a.last_summary)}</div>` : ''}
      <div class="muted" style="font-size:13px">
        ${a.last_at ? 'آخر تشغيل ' + ago(a.last_at) + ' · ' : ''}${num(a.runs_7d)} تشغيل هذا الأسبوع${a.errors_7d ? ` · <span style="color:var(--bad)">${num(a.errors_7d)} فشل</span>` : ''}${a.pending ? ` · ${num(a.pending)} بانتظارك` : ''}
        <br>النموذج: <span class="ltr">${esc(a.model)}</span> · الموعد: <span class="ltr">${esc(a.schedule || (a.output_kind === 'whatsapp' ? 'عند وصول رسالة' : a.managed_by === 'external' ? 'workflow خاص' : 'عند الطلب'))}</span>
      </div>
      <div class="row">
        <label class="switch"><input type="checkbox" data-enable ${a.enabled ? 'checked' : ''}> مفعّل</label>
        <span style="display:flex;gap:6px;flex-wrap:wrap">
          ${a.managed_by === 'runner' ? `<button class="btn small" data-edit>الأمر والموعد</button>` : ''}
          ${a.managed_by === 'runner' && a.output_kind !== 'whatsapp' ? `<button class="btn small primary" data-run>تشغيل الآن</button>` : ''}
          <a class="btn small" href="#log" data-history>السجل</a>
        </span>
      </div>
    </div>`).join('')}</section>`;
  el.querySelectorAll('[data-agent]').forEach(card => {
    const name = card.dataset.agent;
    const run = card.querySelector('[data-run]');
    if (run) run.onclick = async () => {
      run.disabled = true;
      try { toast((await api(`agents/${name}/run`, { method: 'POST', body: {} })).message); } catch (e) { toast(e.message); }
      setTimeout(() => { run.disabled = false; }, 5000);
    };
    card.querySelector('[data-enable]').onchange = async (e) => {
      try { await api(`agents/${name}`, { method: 'PATCH', body: { enabled: e.target.checked } }); toast(e.target.checked ? 'فُعّل' : 'عُطّل'); }
      catch (err) { toast(err.message); e.target.checked = !e.target.checked; }
    };
    card.querySelector('[data-history]').onclick = () => { sessionStorage.setItem('logAgent', name); };
    const edit = card.querySelector('[data-edit]');
    if (edit) edit.onclick = async () => {
      const a = await api(`agents/${name}`);
      dialog(`<h2>${esc(a.label_ar)}</h2><div class="stack">
        <label class="field">الموعد (daily@07:00 · weekly@sat@03:00 · hourly@15 · فارغ = عند الطلب)<input type="text" id="eSched" class="ltr" value="${esc(a.schedule || '')}"></label>
        <label class="field">النموذج<input type="text" id="eModel" class="ltr" value="${esc(a.model)}"></label>
        <label class="field">الأمر (يُضاف بعد الدستور المشترك)<textarea id="ePrompt" style="min-height:300px">${esc(a.system_prompt || '')}</textarea></label>
        <button class="btn primary" id="eSave">حفظ</button><p class="err" id="eErr"></p></div>`);
      $('#eSave').onclick = async () => {
        try {
          await api(`agents/${name}`, { method: 'PATCH', body: { schedule: $('#eSched').value.trim(), model: $('#eModel').value.trim(), system_prompt: $('#ePrompt').value } });
          $('#dlg').close(); toast('حُفظ'); render();
        } catch (e) { $('#eErr').textContent = e.message; }
      };
    };
  });
};

// ---------- السجل ----------
VIEWS.log = async (el) => {
  const agents = await api('agents');
  let agent = sessionStorage.getItem('logAgent') || '';
  const draw = async () => {
    const [runs, events] = await Promise.all([api('runs' + (agent ? '?agent=' + encodeURIComponent(agent) : '')), api('events')]);
    el.innerHTML = `
      <div class="card"><div class="row"><h2 style="margin:0">تشغيلات الوكلاء</h2>
        <select id="fAgent" style="max-width:240px"><option value="">كل الوكلاء</option>${agents.map(a => `<option value="${esc(a.name)}" ${a.name === agent ? 'selected' : ''}>${esc(a.label_ar)}</option>`).join('')}</select></div>
        <div class="table-wrap"><table>
        <tr><th>#</th><th>الوكيل</th><th>الحالة</th><th>الملخص</th><th class="hide-sm">المصدر</th><th class="hide-sm">المدة</th><th>متى</th></tr>
        ${runs.map(r => `<tr data-run="${r.id}" style="cursor:pointer"><td class="num">${r.id}</td><td>${esc(r.agent_label || r.agent)}</td><td>${pill(r.status)}</td>
          <td>${esc((r.summary || r.error || '').slice(0, 140))}${r.actions ? `<br><span class="muted">${r.actions} إجراء</span>` : ''}</td>
          <td class="hide-sm">${esc(TRIGGER[r.trigger] || r.trigger)}</td><td class="hide-sm num">${r.duration_ms ? num(r.duration_ms / 1000, 1) + ' ث' : '—'}</td><td class="num">${when(r.started_at)}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">لا تشغيلات بعد</td></tr>'}
      </table></div></div>
      <div class="card"><h2>الأحداث</h2><div class="list">
        ${events.map(e => `<div><div class="row"><span class="pill ${e.level === 'error' ? 'bad' : e.level === 'warn' ? 'warn' : ''}">${esc(e.source)}</span><span class="muted" style="font-size:13px">${when(e.ts)}</span></div>${esc(e.message)}</div>`).join('') || '<div class="muted">لا أحداث</div>'}
      </div></div>`;
    $('#fAgent').onchange = (e) => { agent = e.target.value; sessionStorage.setItem('logAgent', agent); draw(); };
    el.querySelectorAll('[data-run]').forEach(tr => tr.onclick = async () => {
      const r = await api('runs/' + tr.dataset.run);
      dialog(`<h2>تشغيل #${r.id} · ${esc(r.agent)}</h2><div class="stack">
        <div>${pill(r.status)} <span class="muted">${when(r.started_at)} · ${esc(r.model || '')}</span></div>
        ${r.summary ? `<div style="white-space:pre-wrap">${esc(r.summary)}</div>` : ''}
        ${r.error ? `<div class="banner bad">${esc(r.error)}</div>` : ''}
        ${(r.risks || []).length ? `<div class="banner warn">⚠️ ${r.risks.map(esc).join('<br>⚠️ ')}</div>` : ''}
        ${(r.missing_data || []).length ? `<div class="banner info">ينقصه: ${r.missing_data.map(esc).join('، ')}</div>` : ''}
        ${r.actions.length ? `<table><tr><th>#</th><th>الإجراء</th><th>الحالة</th><th>السبب</th></tr>${r.actions.map(a => `<tr><td>${a.id}</td><td>${esc(a.type)}</td><td>${pill(a.status)}</td><td class="muted">${esc(a.gate_reason || '')}</td></tr>`).join('')}</table>` : ''}
        <details><summary>رد الوكيل (JSON)</summary><pre>${esc(JSON.stringify(r.envelope, null, 2))}</pre></details>
        <details><summary>البيانات التي استلمها</summary><pre>${esc(JSON.stringify(r.input, null, 2))}</pre></details></div>`);
    });
  };
  await draw();
};

// ---------- الإعدادات ----------
VIEWS.settings = async (el) => {
  const [{ config, policies }, data] = await Promise.all([api('config'), api('data')]);
  const groups = {};
  config.filter(c => c.key !== 'constitution').forEach(c => (groups[c.group_ar] = groups[c.group_ar] || []).push(c));
  const input = (c) => {
    const v = c.value;
    if (typeof v === 'boolean') return `<label class="switch"><input type="checkbox" data-k="${c.key}" ${v ? 'checked' : ''}> ${v ? 'مفعّل' : 'متوقف'}</label>`;
    if (typeof v === 'number') return `<input type="number" step="any" min="0" data-k="${c.key}" value="${v}">`;
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return `<input type="date" data-k="${c.key}" value="${esc(v)}">`;
    if (typeof v === 'string') return `<input type="text" data-k="${c.key}" value="${esc(v)}" class="${/url|chat_id|session/.test(c.key) ? 'ltr' : ''}">`;
    return `<textarea data-k="${c.key}" data-json="1" class="ltr" style="min-height:90px">${esc(JSON.stringify(v, null, 2))}</textarea>`;
  };
  const MODE = { auto: ['ok', 'تلقائي'], approval: ['warn', 'بموافقتك'], conditional: ['info', 'حسب الحالة'], forbidden: ['bad', 'ممنوع'] };
  el.innerHTML = `
    ${Object.entries(groups).map(([g, items]) => `<div class="card stack"><h2>${esc(g)}</h2>
      ${items.map(c => `<div class="stack" style="gap:4px"><label class="field">${esc(c.label_ar || c.key)} <span class="ltr" style="font-size:12px">${esc(c.key)}</span></label>
        <div class="row" style="flex-wrap:nowrap;align-items:flex-start">${input(c)}<button class="btn small" data-save="${c.key}">حفظ</button></div></div>`).join('')}
    </div>`).join('')}
    <div class="card stack"><h2>الموردون</h2>
      <p class="muted" style="margin:0">أمر الشراء ورسالة المورد لا يمرّان إلا لمورد «معتمد» هنا.</p>
      <div class="table-wrap"><table><tr><th>المورد</th><th>معتمد</th><th>واتساب</th><th class="hide-sm">ملاحظات</th></tr>
        ${data.suppliers.map(s => `<tr><td>${esc(s.name)}</td><td>${s.whitelisted ? '✅' : '—'}</td><td class="ltr">${esc(s.whatsapp || '')}</td><td class="hide-sm muted">${esc(s.notes || '')}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">لا موردين بعد</td></tr>'}
      </table></div>
      <div class="grid"><input type="text" id="sName" placeholder="اسم المورد كما في Manager"><input type="text" id="sWa" class="ltr" placeholder="9665xxxxxxxx">
        <label class="switch"><input type="checkbox" id="sOk" checked> معتمد</label><button class="btn primary" id="sSave">إضافة / تحديث</button></div>
    </div>
    <div class="card"><h2>صلاحيات الإجراءات</h2><p class="muted" style="margin-top:0">مثبتة في قاعدة البيانات، ولا يستطيع أي وكيل تجاوزها.</p><div class="table-wrap"><table>
      <tr><th>الإجراء</th><th>الوضع</th><th class="hide-sm">من يملكه</th><th class="hide-sm">ملاحظة</th></tr>
      ${policies.map(p => `<tr><td>${esc(p.label_ar)}</td><td><span class="pill ${MODE[p.mode][0]}">${MODE[p.mode][1]}</span></td>
        <td class="hide-sm ltr" style="font-size:12px">${esc((p.allowed_agents || []).join(', ') || '—')}</td><td class="hide-sm muted">${esc(p.note_ar || '')}</td></tr>`).join('')}
    </table></div></div>
    <div class="card row"><span>المظهر</span><span style="display:flex;gap:6px">
      <button class="btn small" data-theme="">تلقائي</button><button class="btn small" data-theme="light">فاتح</button><button class="btn small" data-theme="dark">داكن</button>
      <button class="btn small" id="logout">خروج</button></span></div>`;

  el.querySelectorAll('[data-save]').forEach(b => b.onclick = async () => {
    const k = b.dataset.save, f = el.querySelector(`[data-k="${k}"]`);
    let value;
    try {
      if (f.type === 'checkbox') value = f.checked;
      else if (f.type === 'number') value = Number(f.value);
      else if (f.dataset.json) value = JSON.parse(f.value);
      else value = f.value;
      await api('config/' + k, { method: 'PUT', body: { value } }); toast('حُفظ');
      if (k === 'system_paused') refreshHeader();
    } catch (e) { toast(e instanceof SyntaxError ? 'JSON غير صالح' : e.message); }
  });
  $('#sSave').onclick = async () => {
    try { await api('suppliers', { method: 'PUT', body: { name: $('#sName').value, whatsapp: $('#sWa').value, whitelisted: $('#sOk').checked } }); toast('حُفظ'); render(); }
    catch (e) { toast(e.message); }
  };
  el.querySelectorAll('[data-theme]').forEach(b => b.onclick = () => setTheme(b.dataset.theme));
  $('#logout').onclick = async () => { await api('logout', { method: 'POST', body: {} }); showLogin(); };
};

function setTheme(t) {
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  try { localStorage.setItem('theme', t); } catch {}
}
try { setTheme(localStorage.getItem('theme') || ''); } catch {}

async function start() {
  try { await api('overview'); } catch { return showLogin(); }
  $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
  go();
  clearInterval(timer);
  timer = setInterval(() => { if (!document.hidden && !$('#dlg').open && ['home', 'approvals'].includes(current)) render(); }, 30000);
}
start();
