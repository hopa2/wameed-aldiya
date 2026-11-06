// وكيل مراقبة عمليات المحل: قواعد في الكود بلا نموذج ذكاء، وقراءة فقط من Manager.io.
// يكمل BIZ - Change Log (الحذف والتعديل الفوري). كل نتيجة «ملاحظة تحتاج مراجعة» وليست اتهامًا:
// Manager لا يذكر من نفّذ العملية، فلا ينسب الوكيل أي عملية إلى شخص.
const LIMITS = { below_list_pct: 10, big_return: 100, big_payment: 1000, dup_minutes: 10, min_amount: 5 };
const parse = (n) => { try { const j = $(n).first().json; if (j.error || !j.data) return null; return JSON.parse(j.data); } catch (e) { return null; } };
const val = (x) => (x && typeof x.value === 'number') ? x.value : 0;
const R = (n) => Math.round(n * 100) / 100;
const inv = parse('Get Invoices'), itm = parse('Get Items'), cn = parse('Get Credit Notes'), pay = parse('Get Payments');
const test = $execution.mode !== 'production';
if (!inv || !itm) return [{ json: { test, failed: true, text: '⚠️ مراقب العمليات: تعذّرت القراءة من Manager، فلم يكتمل فحص اليوم.', findings: [], counts: {} } }];
const now = new Date(Date.now() + 3 * 3600e3);
const ds = (o) => new Date(now.getTime() - o * 86400e3).toISOString().slice(0, 10);
const since = test ? ds(14) : ds(1);
const short = (f) => f ? String(f).split(':')[0].replace(/\(.*?\)/g, '').replace(/\d{6,}/g, '').trim() : 'زبون نقدي';
const method = (d) => { d = String(d || ''); if (d.includes('اجل') || d.includes('آجل')) return 'آجل'; if (d.includes('شبك') || d.includes('شيك')) return 'شبكة'; if (d.includes('نقد')) return 'نقدي'; return ''; };
const riyadh = (t) => t ? new Date(new Date(t).getTime() + 3 * 3600e3) : null;
const isOpen = (d) => { const h = d.getUTCHours() + d.getUTCMinutes() / 60; return d.getUTCDay() === 5 ? (h >= 15.5 && h < 23.5) : ((h >= 6.5 && h < 13.5) || (h >= 15.5 && h < 23.5)); };
const items = {}; (itm.inventoryItems || []).forEach(i => { items[i.key] = { name: i.itemName, sale: val(i.salePrice), buy: val(i.purchasePrice) }; });
const F = [];
const add = (rule, level, ref, text, advice) => F.push({ rule, level, ref: String(ref), text, advice });
const list = (inv.salesInvoices || []).filter(i => i.issueDate >= since);
const byKey = {}; list.forEach(i => { byKey[i.key] = i; });
const seen = new Set();
// 1) البيع تحت الشراء أو الخصم الكبير، من بنود الفاتورة
const P = $('Prepare').all();
$input.all().forEach((f, idx) => {
  let form; try { form = JSON.parse(f.json.data); } catch (e) { return; }
  const i = byKey[(P[idx] && P[idx].json.key)]; if (!i) return;
  (form.Lines || []).forEach(l => {
    const it = items[l.Item]; if (!it) return;
    const q = Number(l.Qty) || 0; if (q <= 0) return;
    const unit = (q * (Number(l.SalesUnitPrice) || 0) - (Number(l.DiscountAmount) || 0)) / q;
    const loss = (it.buy - unit) * q;
    if (it.buy > 0 && unit < it.buy && loss >= LIMITS.min_amount) add('below_cost', 'high', i.reference, `فاتورة #${i.reference} (${short(i.customer)}): «${it.name}» بيع بـ ${R(unit)} وسعر شراء الصنف ${R(it.buy)}، فرق ${R(loss)} ر.س`, 'تأكد من سعر الشراء في الصنف، أو اسأل عن سبب السعر');
    else if (it.sale > 0 && unit < it.sale * (1 - LIMITS.below_list_pct / 100) && (it.sale - unit) * q >= LIMITS.min_amount) add('below_list', 'medium', i.reference, `فاتورة #${i.reference} (${short(i.customer)}): «${it.name}» بيع بـ ${R(unit)} وسعره ${R(it.sale)}، خصم ${Math.round((1 - unit / it.sale) * 100)}%`, 'راجع هل الخصم متفق عليه');
  });
});
// 2) فواتير: وقت الإدخال وطريقة الدفع والتكرار والتعديل المتأخر
list.forEach(i => {
  const a = val(i.invoiceAmount), m = method(i.description), t = riyadh(i.timestamp);
  if (t && !isOpen(t) && t.toISOString().slice(0, 10) >= since) add('off_hours', 'medium', i.reference, `فاتورة #${i.reference} بمبلغ ${R(a)} ر.س سُجلت أو عُدلت الساعة ${t.toISOString().slice(11, 16)} خارج الدوام`, 'تأكد من سبب العمل خارج الدوام');
  if (m === 'نقدي' && val(i.balanceDue) > 0.5) add('cash_unpaid', 'high', i.reference, `فاتورة #${i.reference} وصفها نقدي وعليها ${R(val(i.balanceDue))} ر.س غير مسددة`, 'طابق المبلغ مع الصندوق، وسجل سند القبض');
  if (m === 'آجل' && !i.customer) add('credit_no_customer', 'high', i.reference, `فاتورة آجل #${i.reference} بمبلغ ${R(a)} ر.س بلا عميل`, 'حدد العميل حتى يمكن تحصيل المبلغ');
  if (!m && a >= LIMITS.min_amount) add('no_method', 'low', i.reference, `فاتورة #${i.reference} بمبلغ ${R(a)} ر.س بلا طريقة دفع واضحة`, 'اكتب نقدي أو شبكة أو آجل في الوصف');
  if (t && i.issueDate && (t - new Date(i.issueDate + 'T23:59:59Z')) > 2 * 86400e3 && a >= LIMITS.min_amount) add('late_edit', 'medium', i.reference, `فاتورة #${i.reference} بتاريخ ${i.issueDate} آخر تعديل عليها ${t.toISOString().slice(0, 10)}`, 'راجع ما تغيّر في سجل التعديلات');
});
const sorted = list.filter(i => i.timestamp).slice().sort((a, b) => a.timestamp < b.timestamp ? -1 : 1);
sorted.forEach((a, k) => { const b = sorted[k + 1]; if (!b) return; if (val(a.invoiceAmount) === val(b.invoiceAmount) && val(a.invoiceAmount) >= LIMITS.min_amount && a.customer === b.customer && a.customer && (new Date(b.timestamp) - new Date(a.timestamp)) <= LIMITS.dup_minutes * 60e3) add('duplicate', 'medium', b.reference, `فاتورتان متطابقتان #${a.reference} و#${b.reference} للعميل نفسه خلال ${LIMITS.dup_minutes} دقائق بمبلغ ${R(val(a.invoiceAmount))} ر.س`, 'تأكد أنها ليست مكررة'); });
// 3) أرقام ناقصة في تسلسل الفواتير
const refs = list.map(i => Number(i.reference)).filter(Number.isInteger).sort((a, b) => a - b);
const allRefs = new Set((inv.salesInvoices || []).map(i => Number(i.reference)));
for (let k = 0; k + 1 < refs.length; k++) for (let n = refs[k] + 1; n < refs[k + 1]; n++) if (!allRefs.has(n)) add('gap', 'high', n, `رقم الفاتورة #${n} غير موجود في التسلسل`, 'تأكد هل حُذفت فاتورة بهذا الرقم');
// 4) المرتجعات والصرف
((cn && cn.creditNotes) || []).filter(c => (c.issueDate || c.date || '') >= since).forEach(c => { const a = val(c.creditNoteAmount || c.amount); add('return', a >= LIMITS.big_return ? 'high' : 'low', c.reference || '-', `مرتجع #${c.reference || '-'} بمبلغ ${R(a)} ر.س (${short(c.customer)})`, 'طابق البضاعة العائدة مع المخزون والمبلغ مع الصندوق'); });
((pay && pay.payments) || []).filter(p => (p.date || '') >= since).forEach(p => { const a = val(p.amount); if (!String(p.description || '').trim()) add('payment_no_desc', 'medium', p.reference, `سند صرف #${p.reference} بمبلغ ${R(a)} ر.س بلا وصف (${short(p.payee)})`, 'اطلب سبب الصرف ومستنده'); else if (a >= LIMITS.big_payment) add('big_payment', 'low', p.reference, `سند صرف #${p.reference} بمبلغ ${R(a)} ر.س إلى ${short(p.payee)}`, 'تأكد أنه معتمد ومستنده موجود'); });
const counts = {}; F.forEach(x => { counts[x.rule] = (counts[x.rule] || 0) + 1; });
const order = { high: 0, medium: 1, low: 2 };
const top = F.slice().sort((a, b) => order[a.level] - order[b.level]);
const icon = { high: '🔴', medium: '🟠', low: '⚪' };
let text = '';
if (F.length) text = `👁️ مراقب عمليات المحل | ${ds(0)}\n${F.length} ملاحظة تحتاج مراجعة. هذه مؤشرات وليست اتهامًا.\n\n` + top.slice(0, 20).map(x => `${icon[x.level]} ${x.text}\n💡 ${x.advice}`).join('\n\n') + (F.length > 20 ? `\n\n+ ${F.length - 20} ملاحظة أخرى` : '');
return [{ json: { test, invoices: list.length, forms: $input.all().length, counts, sample: test ? top.slice(0, 40) : undefined, findings: test ? [] : F, text: test ? '' : text } }];
