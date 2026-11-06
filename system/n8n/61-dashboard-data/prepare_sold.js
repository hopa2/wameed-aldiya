// فواتير آخر 30 يومًا لحساب الكمية المبيعة لكل صنف (نفس طريقة BIZ - Daily Inventory).
let list = [];
try { list = JSON.parse($input.first().json.data).salesInvoices || []; } catch (e) {}
const since = new Date(Date.now() + 3 * 3600e3 - 30 * 86400e3).toISOString().slice(0, 10);
const keys = list.filter(i => i.issueDate >= since).slice(0, 800).map(i => ({ json: { key: i.key } }));
return keys.length ? keys : [{ json: { key: 'none' } }];
