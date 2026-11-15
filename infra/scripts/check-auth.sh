#!/usr/bin/env bash
# Verifica auth da API Python com curl (sem DNS externo).
set -euo pipefail

API="${PUBLIC_API_URL:-http://localhost:8000}"
COOKIE_JAR="$(mktemp)"
trap 'rm -f "$COOKIE_JAR"' EXIT

echo "==> API: $API"
echo "==> GET /api/auth/providers"
curl -sS -f "$API/api/auth/providers" | (command -v jq >/dev/null && jq . || cat)
echo

echo "==> GET /api/auth/session (sem cookie)"
curl -sS -c "$COOKIE_JAR" -b "$COOKIE_JAR" "$API/api/auth/session" | (command -v jq >/dev/null && jq . || cat)
echo

for p in google microsoft github; do
  echo "==> GET /api/auth/oauth/$p/start"
  code=$(curl -sS -o /tmp/aegis_oauth_start.json -w "%{http_code}" \
    -c "$COOKIE_JAR" -b "$COOKIE_JAR" \
    "$API/api/auth/oauth/$p/start" || true)
  echo "HTTP $code"
  if command -v jq >/dev/null 2>&1 && [[ -f /tmp/aegis_oauth_start.json ]]; then
    jq -r 'if .authorize_url then "authorize_url: \(.authorize_url[0:80])..." else . end' /tmp/aegis_oauth_start.json 2>/dev/null || cat /tmp/aegis_oauth_start.json
  fi
  echo
done

echo "==> POST /api/auth/logout"
curl -sS -X POST -c "$COOKIE_JAR" -b "$COOKIE_JAR" "$API/api/auth/logout" | (command -v jq >/dev/null && jq . || cat)
echo
echo "OK — providers configurados aparecem em /api/auth/providers; start OAuth devolve authorize_url se CLIENT_ID/SECRET estiverem no .env."