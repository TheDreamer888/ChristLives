#!/usr/bin/env bash
# Regras de firewall de perímetro (Cloudflare WAF) para o domínio do Aegis, via API real
# (Rulesets API) com curl. Complementa o firewall da API (src/app/firewall.py) bloqueando
# ataques antes de chegarem ao servidor.
#
#   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ZONE_ID=… infra/scripts/cloudflare-waf.sh          # só mostra
#   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ZONE_ID=… infra/scripts/cloudflare-waf.sh --apply  # aplica
#
# ATENÇÃO: --apply SUBSTITUI todas as regras personalizadas da zona nas fases
# http_request_firewall_custom e http_ratelimit. Revê o JSON antes. O token precisa de
# "Zone WAF: Edit" (e "Zone: Read"). Os limites usam valores aceites no plano gratuito.
set -euo pipefail

CURL="${CURL:-curl}"
API="https://api.cloudflare.com/client/v4"
APPLY=0
[[ "${1:-}" == "--apply" ]] && APPLY=1

read -r -d '' CUSTOM_RULES <<'JSON' || true
{
  "description": "Aegis — regras personalizadas de firewall",
  "rules": [
    {
      "description": "Bloquear ficheiros e painéis sensíveis",
      "action": "block",
      "expression": "(http.request.uri.path contains \"/.env\") or (http.request.uri.path contains \"/.git\") or (http.request.uri.path contains \"/wp-login.php\") or (http.request.uri.path contains \"/wp-admin\") or (http.request.uri.path contains \"/xmlrpc.php\") or (http.request.uri.path contains \"/phpmyadmin\") or (http.request.uri.path contains \"/.aws/\") or (http.request.uri.path contains \"/server-status\")"
    },
    {
      "description": "Bloquear scanners automáticos conhecidos",
      "action": "block",
      "expression": "(lower(http.user_agent) contains \"sqlmap\") or (lower(http.user_agent) contains \"nikto\") or (lower(http.user_agent) contains \"masscan\") or (lower(http.user_agent) contains \"zgrab\") or (lower(http.user_agent) contains \"nuclei\") or (lower(http.user_agent) contains \"wpscan\") or (lower(http.user_agent) contains \"gobuster\") or (lower(http.user_agent) contains \"ffuf\")"
    },
    {
      "description": "Bloquear travessia de diretórios e SSRF para metadados",
      "action": "block",
      "expression": "(http.request.uri contains \"../\") or (lower(url_decode(http.request.uri)) contains \"../\") or (http.request.uri.query contains \"169.254.169.254\")"
    },
    {
      "description": "API: só métodos permitidos",
      "action": "block",
      "expression": "(starts_with(http.request.uri.path, \"/api/\") and not http.request.method in {\"GET\" \"POST\" \"PUT\" \"PATCH\" \"DELETE\" \"OPTIONS\" \"HEAD\"})"
    }
  ]
}
JSON

read -r -d '' RATE_RULES <<'JSON' || true
{
  "description": "Aegis — limites de pedidos",
  "rules": [
    {
      "description": "Limitar tentativas de autenticação por IP",
      "action": "block",
      "expression": "(starts_with(http.request.uri.path, \"/api/auth/\"))",
      "ratelimit": {
        "characteristics": ["ip.src", "cf.colo.id"],
        "period": 10,
        "requests_per_period": 20,
        "mitigation_timeout": 10
      }
    }
  ]
}
JSON

if [[ "$APPLY" != "1" ]]; then
  echo "== http_request_firewall_custom =="; echo "$CUSTOM_RULES"
  echo "== http_ratelimit =="; echo "$RATE_RULES"
  echo
  echo "Modo de revisão: nada foi enviado. Usa --apply para aplicar na zona."
  exit 0
fi

: "${CLOUDFLARE_API_TOKEN:?Define CLOUDFLARE_API_TOKEN}"
: "${CLOUDFLARE_ZONE_ID:?Define CLOUDFLARE_ZONE_ID}"
[[ "$CLOUDFLARE_ZONE_ID" =~ ^[0-9a-f]{32}$ ]] || { echo "CLOUDFLARE_ZONE_ID inválido." >&2; exit 1; }

put_phase() { # fase json
  local response
  response="$("$CURL" -sS --fail-with-body --max-time 30 -X PUT \
    "$API/zones/$CLOUDFLARE_ZONE_ID/rulesets/phases/$1/entrypoint" \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    -H "Content-Type: application/json" \
    --data "$2")" || { echo "✘ $1: $response" >&2; return 1; }
  if grep -q '"success":true' <<<"$response"; then echo "✔ $1 aplicado"; else echo "✘ $1: $response" >&2; return 1; fi
}

put_phase http_request_firewall_custom "$CUSTOM_RULES"
put_phase http_ratelimit "$RATE_RULES"
