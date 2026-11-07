// قراءة فقط من Manager.io للوحة التحكم. محمي بسر WAMEED_DASH_TOKEN، ولا يذهب شيء منه إلى السحابة.
const req = $input.first().json;
const want = String($env.WAMEED_DASH_TOKEN || '');
const got = String((req.headers || {})['x-wameed-token'] || '');
if (want.length < 20 || got !== want) throw new Error('unauthorized');
return [{ json: { ok: true } }];
