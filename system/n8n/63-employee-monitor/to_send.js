// الاختبار اليدوي لا يرسل شيئًا. يرسل فقط عند وجود ملاحظات، ويقسم الرسالة الطويلة.
const j = $input.first().json;
if (j.test || !j.text) return [];
const parts = []; let cur = '';
for (const line of String(j.text).split('\n')) { if ((cur + line + '\n').length > 3800) { parts.push(cur.trim()); cur = ''; } cur += line + '\n'; }
if (cur.trim()) parts.push(cur.trim());
return parts.map(text => ({ json: { text } }));
