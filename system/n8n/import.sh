#!/bin/sh
# يستورد Credentials وworkflows منظومة وميض إلى n8n ويفعّلها.
# يُشغَّل داخل حاوية n8n (انظر scripts/install.ps1):
#   docker compose exec n8n sh /wameed/n8n/import.sh
# آمن للتكرار: المعرّفات ثابتة، فيحدّث ولا يكرر.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp)"
node "$DIR/make_credentials.js" > "$TMP"
n8n import:credentials --input="$TMP"
rm -f "$TMP"
n8n import:workflow --separate --input="$DIR/workflows"
for f in "$DIR"/workflows/*.json; do
  id="$(basename "$f" .json)"
  n8n publish:workflow --id="$id"
done
echo "OK: أعد تشغيل n8n ليبدأ تشغيل الـ workflows (docker compose restart n8n)"
