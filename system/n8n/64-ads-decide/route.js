// ADS-33: قرار المالك على إجراء اقترحه وكيل الإعلانات (من تيليجرام أو اللوحة).
// قرار المالك 2026-11-06: كل إجراء على Google Ads أو صفحة الهبوط ينتظر موافقته، ولا تنفيذ تلقائي.
const req = $('Request').first().json;
const row = $input.first().json || {};
const id = Number(req.action_id);
if (!row.action_id) return [{ json: { kind: 'info', text: `الإجراء #${id} لم يعد بانتظار الموافقة: نُفذ أو رُفض أو مرت عليه 72 ساعة.` } }];
if (row.decision === 'reject') return [{ json: { kind: 'info', text: `❌ رفضت الإجراء #${id}، ولم يتغير شيء.` } }];
if (row.action_type === 'update_landing_page') return [{ json: { kind: 'landing', action_id: id, landing_content: row.payload } }];
// test: مسار فحص فقط (validateOnly) لاختبار السلسلة دون تغيير الحساب
return [{ json: { kind: 'ads', action_id: id, type: row.action_type, payload: row.payload, mode: 'execute', live_reason: req.test === true ? 'owner_test' : 'owner_approved' } }];
