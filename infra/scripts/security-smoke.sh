#!/usr/bin/env bash
# Testes de segurança reais, com curl, contra a API e o frontend do Aegis.
#
#   API_URL=https://api.exemplo.pt FRONTEND_URL=https://exemplo.pt infra/scripts/security-smoke.sh
#
# Verifica: health, cabeçalhos de segurança, bloqueio de ataques pelo firewall (path
# traversal, ficheiros sensíveis, SQLi, XSS, injeção de comandos, SSRF, scanners), métodos
# não permitidos, pedidos grandes e (opcional, RATE_LIMIT_TEST=1) o limite de pedidos.
# Cada ataque conta como violação: corre no máximo algumas vezes por hora contra o mesmo
# IP ou junta o IP de testes a FIREWALL_ALLOWLIST… mas então os bloqueios não se aplicam.
# Sai com código 1 se alguma verificação falhar.
set -euo pipefail

API_URL="${API_URL:-http://127.0.0.1:8000}"
FRONTEND_URL="${FRONTEND_URL:-}"
CURL="${CURL:-curl}"            # ex.: CURL=curl.exe na WSL
NULL_OUT="${NULL_OUT:-/dev/null}" # ex.: NULL_OUT=NUL com curl.exe
RATE_LIMIT_TEST="${RATE_LIMIT_TEST:-0}"
UA="Aegis-Security-Smoke/1.0"

pass=0
fail=0
ok()  { pass=$((pass + 1)); printf '  \033[32m✔\033[0m %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  \033[31m✘\033[0m %s\n' "$1"; }

status_of() { # método url [extra args...]
  local method="$1" url="$2" code; shift 2
  code="$("$CURL" -s -o "$NULL_OUT" -w '%{http_code}' -A "$UA" -X "$method" --max-time 20 "$@" "$url")" || true
  echo "${code:-000}"
}

expect_status() { # descrição esperado método url [args...]
  local label="$1" expected="$2"; shift 2
  local got
  got="$(status_of "$@")"
  if [[ "$got" == "$expected" ]]; then ok "$label → $got"; else bad "$label → $got (esperado $expected)"; fi
}

headers_of() { { "$CURL" -s -D - -o "$NULL_OUT" -A "$UA" --max-time 20 "$1" || true; } | tr -d '\r' | tr 'A-Z' 'a-z'; }

expect_header() { # cabeçalhos nome
  if grep -q "^$2:" <<<"$1"; then ok "cabeçalho $2"; else bad "cabeçalho $2 em falta"; fi
}

echo "API: $API_URL"
expect_status "health" 200 GET "$API_URL/health"

api_headers="$(headers_of "$API_URL/health")"
for h in x-content-type-options x-frame-options content-security-policy referrer-policy permissions-policy cross-origin-opener-policy; do
  expect_header "$api_headers" "$h"
done

echo "Firewall (cada pedido abaixo deve ser bloqueado):"
expect_status "path traversal"      403 GET "$API_URL/api/protect/status?f=../../etc/passwd"
expect_status "ficheiro .env"       403 GET "$API_URL/.env"
expect_status "painel wp-login"     403 GET "$API_URL/wp-login.php"
expect_status "injeção SQL"         403 GET "$API_URL/api/protect/status?id=1%27%20OR%20%271%27%3D%271"
expect_status "XSS"                 403 GET "$API_URL/api/protect/status?q=%3Cscript%3Ealert(1)%3C/script%3E"
expect_status "injeção de comandos" 403 GET "$API_URL/api/protect/status?h=x%3Bcat%20/etc/passwd"
expect_status "SSRF metadados"      403 GET "$API_URL/api/protect/status?u=http://169.254.169.254/latest/meta-data"
expect_status "scanner sqlmap"      403 GET "$API_URL/api/protect/status" -A "sqlmap/1.8#stable"
expect_status "método TRACE"        405 TRACE "$API_URL/api/protect/status"
expect_status "corpo de 50 MB"      413 POST "$API_URL/api/chat" -H "Content-Type: application/json" -H "Content-Length: 52428800" --data-binary '{}'
expect_status "pedido legítimo"     200 GET "$API_URL/api/protect/status"

if [[ "$RATE_LIMIT_TEST" == "1" ]]; then
  echo "Limite de pedidos (envia 400 pedidos rápidos):"
  limited=0
  for _ in $(seq 1 400); do
    [[ "$(status_of GET "$API_URL/api/protect/status")" == "429" ]] && { limited=1; break; }
  done
  if [[ "$limited" == "1" ]]; then ok "limite de pedidos devolve 429"; else bad "nenhum 429 após 400 pedidos"; fi
fi

if [[ -n "$FRONTEND_URL" ]]; then
  echo "Frontend: $FRONTEND_URL"
  expect_status "página inicial" 200 GET "$FRONTEND_URL/"
  fe_headers="$(headers_of "$FRONTEND_URL/")"
  for h in content-security-policy x-content-type-options x-frame-options referrer-policy strict-transport-security; do
    expect_header "$fe_headers" "$h"
  done
  if grep -q '^server: nginx/[0-9]' <<<"$fe_headers"; then bad "versão do nginx exposta"; else ok "versão do servidor oculta"; fi
  expect_status "dotfile /.git/config" 404 GET "$FRONTEND_URL/.git/config"
  expect_status "método POST no estático" 405 POST "$FRONTEND_URL/"
  if [[ "$FRONTEND_URL" == https://* ]]; then
    expiry="$("$CURL" -s -o "$NULL_OUT" -w '%{certs}' --max-time 20 "$FRONTEND_URL/" 2>/dev/null | grep -i -m1 '^expire date' || true)"
    [[ -n "$expiry" ]] && ok "certificado TLS: ${expiry#*:}" || ok "TLS ativo (curl sem detalhe do certificado)"
  fi
fi

echo
echo "Resultado: $pass ok, $fail falhas"
[[ "$fail" == "0" ]]
