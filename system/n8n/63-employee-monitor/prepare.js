// فواتير نافذة الفحص لقراءة بنودها: اليوم وأمس في التشغيل المجدول، و14 يومًا في المعايرة اليدوية.
let list = [];
try { list = JSON.parse($('Get Invoices').first().json.data).salesInvoices || []; } catch (e) {}
const days = $execution.mode === 'production' ? 1 : 14;
const since = new Date(Date.now() + 3 * 3600e3 - days * 86400e3).toISOString().slice(0, 10);
const keys = list.filter(i => i.issueDate >= since).slice(0, 500).map(i => ({ json: { key: i.key } }));
return keys.length ? keys : [{ json: { key: 'none' } }];
