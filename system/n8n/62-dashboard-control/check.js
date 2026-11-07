// أوامر اللوحة بعد ضغطة المالك فقط. محمي بسر WAMEED_DASH_TOKEN، والأوامر من قائمة ثابتة.
const req = $input.first().json;
const want = String($env.WAMEED_DASH_TOKEN || '');
const got = String((req.headers || {})['x-wameed-token'] || '');
if (want.length < 20 || got !== want) throw new Error('unauthorized');
const b = req.body || {};
if (!['reorder', 'pricing', 'ads_review', 'ads_undo', 'ads_resume', 'quote'].includes(b.agent)) throw new Error('أمر غير معروف');
return [{ json: b }];
