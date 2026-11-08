const r = $('Results').first().json;
const id = r.action_id;
let text;
if (r.status === 'executed') text = `✅ نفّذت الإجراء #${id} على Google Ads بعد موافقتك.\nللتراجع: /ads_undo ${id}`;
else if (r.status === 'dry_run') text = `🧪 الإجراء #${id}: فحص فقط، ولم يتغير شيء في الحساب.`;
else text = `⚠️ فشل تنفيذ الإجراء #${id}: ${String(r.error || '').slice(0, 300)}`;
return [{ json: { text, status: r.status, action_id: id } }];
