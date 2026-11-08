// يحسب أرقام اللوحة في الكود (لا في النموذج)، بنفس منطق تقارير BIZ.
const TARGET = 30000;
const parse = (n) => { try { const j = $(n).first().json; if (j.error || !j.data) return null; return JSON.parse(j.data); } catch (e) { return null; } };
const val = (x) => (x && typeof x.value === 'number') ? x.value : 0;
const inv = parse('Get Invoices'), cus = parse('Get Customers'), itm = parse('Get Items'), rec = parse('Get Receipts'), pay = parse('Get Payments');
if (!inv || !inv.salesInvoices) return [{ json: { ok: false, error: 'تعذّر الوصول إلى Manager.io في المحل' } }];
const now = new Date(Date.now() + 3 * 3600e3);
const ds = (off) => new Date(now.getTime() - off * 86400e3).toISOString().slice(0, 10);
const today = ds(0);
const sinceSat = (now.getUTCDay() + 1) % 7;
const y = now.getUTCFullYear(), mo = now.getUTCMonth(), day = now.getUTCDate();
const dim = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
const mStart = today.slice(0, 8) + '01';
const pm = new Date(Date.UTC(y, mo - 1, 1)).toISOString().slice(0, 10);
const pmEnd = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
const pmSame = (pm.slice(0, 8) + today.slice(8, 10)) > pmEnd ? pmEnd : pm.slice(0, 8) + today.slice(8, 10);
const short = (f) => String(f || '').split(':')[0].replace(/\(.*?\)/g, '').replace(/\d{6,}/g, '').trim();
const phoneOf = (f) => { const m = String(f || '').match(/(?:\+?966|0)5\d{8}/); return m ? '966' + m[0].replace(/^\+?966|^0/, '') : null; };
const method = (d) => { d = String(d || ''); if (d.includes('اجل') || d.includes('آجل')) return 'آجل'; if (d.includes('شبك') || d.includes('شيك')) return 'شبكة'; if (d.includes('نقد')) return 'نقدي'; return 'أخرى'; };
const L = inv.salesInvoices;
function period(a, b, label) {
  const s = L.filter(i => i.issueDate >= a && i.issueDate <= b);
  const total = s.reduce((x, i) => x + val(i.invoiceAmount), 0), cost = s.reduce((x, i) => x + val(i.costOfSales), 0);
  const methods = {};
  s.forEach(i => { const k = method(i.description); methods[k] = (methods[k] || 0) + val(i.invoiceAmount); });
  return { label, from: a, to: b, total: Math.round(total), count: s.length, avg: s.length ? Math.round(total / s.length) : 0, profit: Math.round(total - cost), methods };
}
const periods = {
  today: period(today, today, 'اليوم'), yesterday: period(ds(1), ds(1), 'أمس'),
  week: period(ds(sinceSat), today, 'هذا الأسبوع'), lastWeek: period(ds(sinceSat + 7), ds(sinceSat + 1), 'الأسبوع الماضي'),
  last7: period(ds(6), today, 'آخر 7 أيام'), month: period(mStart, today, 'هذا الشهر'),
  lastMonthSame: period(pm, pmSame, 'نفس الفترة من الشهر الماضي'), lastMonth: period(pm, pmEnd, 'الشهر الماضي'),
};
const daily = [];
for (let k = 29; k >= 0; k--) { const d = ds(k); const s = L.filter(i => i.issueDate === d); daily.push({ d, t: Math.round(s.reduce((x, i) => x + val(i.invoiceAmount), 0)), n: s.length }); }
const left = dim - day;
const mt = periods.month.total;
const goal = { target: TARGET, pct: Math.round(mt / TARGET * 100), gap: Math.max(0, TARGET - mt), need_daily: left > 0 ? Math.round(Math.max(0, TARGET - mt) / left) : 0, forecast: Math.round(mt / day * dim), days_left: left };
const todayList = L.filter(i => i.issueDate === today).map(i => ({ ref: i.reference, amount: Math.round(val(i.invoiceAmount)), method: method(i.description), customer: i.customer ? short(i.customer) : 'زبون نقدي' }));
// الذمم: أقدم فاتورة غير مسددة من الرصيد الفعلي (الأقدم يُسدد أولًا)، كما في BIZ - Assistant
const byC = {};
L.forEach(i => { if (i.customer) (byC[i.customer] = byC[i.customer] || []).push(i); });
const oldestFor = (name, a) => { const s = (byC[name] || []).slice().sort((x, z) => x.issueDate < z.issueDate ? 1 : -1); let acc = 0, d = ''; for (const i of s) { acc += val(i.invoiceAmount); d = i.issueDate; if (acc >= a - 0.5) break; } return d; };
const dayMs = 86400e3, age = (d) => d ? Math.round((new Date(today) - new Date(d)) / dayMs) : null;
const debtors = ((cus && cus.customers) || []).filter(c => val(c.accountsReceivable) > 0).map(c => { const a = val(c.accountsReceivable), o = oldestFor(c.name, a); return { name: short(c.name), amount: Math.round(a), oldest: o, days: age(o), wa: phoneOf(c.name) }; }).sort((a, b) => b.amount - a.amount);
const receivables = { total: debtors.reduce((x, c) => x + c.amount, 0), count: debtors.length, overdue30: debtors.filter(c => c.days > 30).reduce((x, c) => x + c.amount, 0), list: debtors };
// العملاء: الأعلى خلال 30 يومًا، والمتوقفون (اشتروا سابقًا ولم يشتروا منذ 60 يومًا)
const since30 = ds(29), custTotals = {};
L.filter(i => i.customer && i.issueDate >= since30).forEach(i => { const n = short(i.customer); custTotals[n] = (custTotals[n] || 0) + val(i.invoiceAmount); });
const topCustomers = Object.keys(custTotals).map(n => ({ name: n, total: Math.round(custTotals[n]) })).sort((a, b) => b.total - a.total).slice(0, 10);
const lapsed = Object.keys(byC).map(k => { const last = byC[k].map(i => i.issueDate).sort().pop(); return { name: short(k), last, days: age(last), wa: phoneOf(k), total: Math.round(byC[k].reduce((x, i) => x + val(i.invoiceAmount), 0)) }; }).filter(c => c.days >= 60 && c.days <= 365).sort((a, b) => b.total - a.total).slice(0, 15);
// النقدية
const moves = (list, f) => { const sum = (a, b) => Math.round((list || []).filter(r => r.date >= a && r.date <= b).reduce((x, r) => x + val(r.amount), 0)); return { today: sum(today, today), week: sum(ds(sinceSat), today), month: sum(mStart, today) }; };
const cash = { in: rec ? moves(rec.receipts) : null, out: pay ? moves(pay.payments) : null };
// المخزون
let items = [], inventory = null;
if (itm && itm.inventoryItems) {
  items = itm.inventoryItems.map(i => ({ key: i.key, name: i.itemName, unit: i.unitName || '', owned: Number(i.qtyOwned) || 0, hand: Number(i.qtyOnHand) || 0, price: val(i.salePrice), cost: val(i.purchasePrice), value: Math.round(val(i.totalCost)) }));
  inventory = { count: items.length, value: items.reduce((x, i) => x + (i.value > 0 ? i.value : 0), 0), negative: items.filter(i => i.owned < 0 || i.hand < 0).length, no_price: items.filter(i => i.price <= 0).length };
}
return [{ json: { ok: true, generated_at: new Date().toISOString(), today, periods, daily, goal, today_invoices: todayList, receivables, top_customers: topCustomers, lapsed, cash, inventory, items, partial: { customers: !cus, items: !itm, receipts: !rec, payments: !pay } } }];
