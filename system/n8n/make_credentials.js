// يولّد ملف Credentials لمنظومة وميض من متغيرات البيئة، ليستورده n8n.
// يعمل داخل حاوية n8n: node make_credentials.js > /tmp/creds.json
// لا تحفظ الملف الناتج: فيه أسرار. سكربت الاستيراد يحذفه فورًا.
const e = process.env;
const need = ['DB_POSTGRESDB_PASSWORD', 'WAMEED_HOOK_TOKEN'];
for (const k of need) if (!e[k]) { console.error('missing env: ' + k); process.exit(1); }
const creds = [
  { id: 'wameedPostgres01', name: 'Wameed Postgres', type: 'postgres',
    data: { host: e.DB_POSTGRESDB_HOST || 'postgres', port: Number(e.DB_POSTGRESDB_PORT || 5432),
            database: e.DB_POSTGRESDB_DATABASE || 'n8n', user: e.DB_POSTGRESDB_USER || 'wameed',
            password: e.DB_POSTGRESDB_PASSWORD, ssl: 'disable' } },
  { id: 'wameedHookToken1', name: 'Wameed Hook Token', type: 'httpHeaderAuth',
    data: { name: 'x-wameed-token', value: e.WAMEED_HOOK_TOKEN } },
  { id: 'wameedWahaKey001', name: 'Wameed WAHA Key', type: 'httpHeaderAuth',
    data: { name: 'X-Api-Key', value: e.WAHA_API_KEY || 'not-set' } },
  { id: 'wameedTelegram01', name: 'Wameed Telegram', type: 'telegramApi',
    data: { accessToken: e.TELEGRAM_BOT_TOKEN || '000:not-set', baseUrl: e.TELEGRAM_API_BASE || 'https://api.telegram.org' } },
];
process.stdout.write(JSON.stringify(creds));
