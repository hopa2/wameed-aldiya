# BIZ - WhatsApp Inbox: بحث الأصناف وخطة الرد (2026-11-06)

- `build_prompt.js` هو كود عقدة **Build Prompt** كما هو في n8n.
- عقدة **Parse** أضيف إليها قبل `const reply = String(o.reply)`:

```js
// النظام يحدد التسعيرة والتحويل للمالك، لا النموذج (2026-11-06)
const BP = $('Build Prompt').first().json;
if (BP.intent || BP.forceHuman) { o.needs_human = true; }
if (BP.forceHuman) { o.needs_quote = false; }
if (BP.intent) { o.needs_human = true; o.needs_quote = false; o.quote = []; }
else { o.quote = BP.codeQuote || []; o.quote_is_options = false; o.needs_quote = o.quote.length > 0 && !BP.forceHuman; }
if (BP.lineNote) o.owner_note = [o.owner_note, BP.lineNote].filter(Boolean).join(' | ');
```

النسخ السابقة محفوظة في سجل إصدارات الـ workflow داخل n8n.
