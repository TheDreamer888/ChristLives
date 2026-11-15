#!/usr/bin/env bash
# Gera a blocklist de IPs do nginx (firewall de perímetro do frontend) a partir de listas
# públicas reais: FireHOL nível 1, Spamhaus DROP e Emerging Threats (IPs comprometidos).
# Descarrega com curl (ou wget, se não houver curl), valida cada linha, remove redes
# privadas/reservadas e escreve um ficheiro `geo` que o nginx.conf inclui.
#
#   infra/scripts/update-nginx-blocklist.sh [ficheiro-de-saída]
#   (por omissão: apps/frontend/nginx-blocklist.conf)
#
# Em produção, agenda-o (cron/systemd timer, ex.: a cada 6 h) e recarrega o nginx:
#   infra/scripts/update-nginx-blocklist.sh /etc/nginx/aegis-blocklist.conf && nginx -t && nginx -s reload
set -euo pipefail

OUT="${1:-$(dirname "$0")/../../apps/frontend/nginx-blocklist.conf}"
CURL="${CURL:-curl}"
FEEDS=(
  "https://raw.githubusercontent.com/firehol/blocklist-ipsets/master/firehol_level1.netset"
  "https://www.spamhaus.org/drop/drop.txt"
  "https://rules.emergingthreats.net/blockrules/compromised-ips.txt"
)
MAX_BYTES=$((8 * 1024 * 1024))

fetch() {
  if command -v "$CURL" >/dev/null 2>&1; then
    "$CURL" -fsSL --proto '=https' --tlsv1.2 --max-time 60 --max-filesize "$MAX_BYTES" -A "Aegis-Firewall/1.0" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O - --https-only --timeout=60 -U "Aegis-Firewall/1.0" "$1" | head -c "$MAX_BYTES"
  else
    echo "Erro: é preciso curl ou wget." >&2; return 1
  fi
}

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
loaded=0
for url in "${FEEDS[@]}"; do
  if body="$(fetch "$url")"; then
    count=$(printf '%s\n' "$body" | wc -l)
    printf '%s\n' "$body" >>"$tmp"
    loaded=$((loaded + 1))
    echo "✔ $url ($count linhas)" >&2
  else
    echo "✘ falhou: $url" >&2
  fi
done
[[ "$loaded" -gt 0 ]] || { echo "Nenhuma lista descarregada; ficheiro existente mantido." >&2; exit 1; }

# Primeiro campo de cada linha; só IPv4/CIDR válidos; fora redes privadas, loopback,
# link-local, CGNAT, multicast e reservadas (as listas incluem bogons).
entries="$(
  sed -e 's/[;#].*$//' "$tmp" | awk '{print $1}' |
  grep -E '^([0-9]{1,3}\.){3}[0-9]{1,3}(/([89]|[12][0-9]|3[0-2]))?$' |
  grep -Ev '^(0|10|127)\.|^169\.254\.|^172\.(1[6-9]|2[0-9]|3[01])\.|^192\.168\.|^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.|^(22[4-9]|2[3-5][0-9])\.' |
  sort -u
)"
total=$(printf '%s\n' "$entries" | grep -c . || true)
[[ "$total" -gt 100 ]] || { echo "Lista suspeitamente pequena ($total); ficheiro existente mantido." >&2; exit 1; }

{
  echo "# Gerado por infra/scripts/update-nginx-blocklist.sh em $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# $total redes de: FireHOL nível 1, Spamhaus DROP, Emerging Threats. Não editar à mão."
  printf '%s 1;\n' $entries
} >"$OUT.tmp"
mv "$OUT.tmp" "$OUT"
echo "Escritas $total redes em $OUT" >&2
