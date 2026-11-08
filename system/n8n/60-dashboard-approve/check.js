// يستقبل «موافقة» من لوحة التحكم ويحوّلها إلى ضغطة زر تيليجرام مكافئة،
// ثم تمرّ على SYS - Approval Gate كما هي: نفس الحواجز ونفس التنفيذ في Manager.io ونفس رسالة التأكيد.
const OWNER = '367407052';
const req = $input.first().json;
const want = String($env.WAMEED_DASH_TOKEN || '');
const got = String((req.headers || {})['x-wameed-token'] || '');
if (want.length < 20 || got !== want) throw new Error('unauthorized');
const id = Number((req.body || {}).approval_id);
if (!Number.isInteger(id) || id <= 0) throw new Error('approval_id غير صالح');
return [{ json: {
  update_id: 0,
  callback_query: {
    id: 'dashboard-' + id + '-' + Date.now(),
    data: 'apv:' + id + ':y',
    from: { id: Number(OWNER) },
    message: { chat: { id: Number(OWNER) } },
  },
} }];
