"""Aplica a configuração de segurança de infra/cloudflare/security.json a uma zona.

Uso:
  CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ZONE_ID=... python apply_security.py [--apply]

Sem --apply corre em modo de simulação: valida o ficheiro e mostra os pedidos,
sem tocar na zona e sem precisar de credenciais.

Permissões mínimas do token (só para a zona em causa):
  Zone Settings: Edit, Zone WAF: Edit.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

API = "https://api.cloudflare.com/client/v4"
CONFIG = Path(__file__).with_name("security.json")

_ALLOWED_SETTINGS = {
    "always_use_https": {"on", "off"},
    "automatic_https_rewrites": {"on", "off"},
    "min_tls_version": {"1.0", "1.1", "1.2", "1.3"},
    "tls_1_3": {"on", "off", "zrt"},
    "ssl": {"off", "flexible", "full", "strict"},
    "security_level": {"off", "essentially_off", "low", "medium", "high", "under_attack"},
    "browser_check": {"on", "off"},
}
_ALLOWED_ACTIONS = {"block", "managed_challenge", "js_challenge", "challenge", "log", "skip"}
_PERIODS = {10, 60, 120, 300, 600, 3600}
_TIMEOUTS = {0, 10, 60, 120, 300, 600, 3600, 86400}


def load_config(path: Path = CONFIG) -> dict:
    cfg = json.loads(path.read_text(encoding="utf-8"))
    validate(cfg)
    return cfg


def validate(cfg: dict) -> None:
    errors: list[str] = []
    for key, value in cfg.get("zone_settings", {}).items():
        allowed = _ALLOWED_SETTINGS.get(key)
        if allowed is None:
            errors.append(f"definição desconhecida: {key}")
        elif value not in allowed:
            errors.append(f"{key}={value!r} inválido (aceita {sorted(allowed)})")
    for i, rule in enumerate(cfg.get("custom_rules", [])):
        if rule.get("action") not in _ALLOWED_ACTIONS:
            errors.append(f"custom_rules[{i}]: ação inválida {rule.get('action')!r}")
        expr = rule.get("expression", "")
        if not expr or expr.count("(") != expr.count(")") or expr.count('"') % 2:
            errors.append(f"custom_rules[{i}]: expressão vazia ou com parênteses/aspas desequilibrados")
        if not rule.get("description"):
            errors.append(f"custom_rules[{i}]: falta description")
    rl = cfg.get("rate_limit")
    if rl:
        if rl.get("period") not in _PERIODS:
            errors.append(f"rate_limit.period inválido (aceita {sorted(_PERIODS)})")
        if rl.get("mitigation_timeout") not in _TIMEOUTS:
            errors.append(f"rate_limit.mitigation_timeout inválido (aceita {sorted(_TIMEOUTS)})")
        if not isinstance(rl.get("requests_per_period"), int) or rl["requests_per_period"] < 1:
            errors.append("rate_limit.requests_per_period tem de ser inteiro >= 1")
        if "cf.colo.id" not in rl.get("characteristics", []):
            errors.append("rate_limit.characteristics tem de incluir cf.colo.id")
    if errors:
        raise ValueError("Configuração inválida:\n  - " + "\n  - ".join(errors))


def plan(cfg: dict, zone: str) -> list[tuple[str, str, dict]]:
    """Lista de (método, caminho, corpo) a enviar à API, por ordem."""
    reqs: list[tuple[str, str, dict]] = []
    for key, value in cfg.get("zone_settings", {}).items():
        reqs.append(("PATCH", f"/zones/{zone}/settings/{key}", {"value": value}))
    rules = [
        {"description": r["description"], "action": r["action"], "expression": r["expression"], "enabled": True}
        for r in cfg.get("custom_rules", [])
    ]
    reqs.append(("PUT", f"/zones/{zone}/rulesets/phases/http_request_firewall_custom/entrypoint", {"rules": rules}))
    rl = cfg.get("rate_limit")
    if rl:
        rule = {
            "description": rl["description"],
            "action": "block",
            "expression": rl["expression"],
            "enabled": True,
            "ratelimit": {
                "characteristics": rl["characteristics"],
                "period": rl["period"],
                "requests_per_period": rl["requests_per_period"],
                "mitigation_timeout": rl["mitigation_timeout"],
            },
        }
        reqs.append(("PUT", f"/zones/{zone}/rulesets/phases/http_ratelimit/entrypoint", {"rules": [rule]}))
    return reqs


def call(method: str, path: str, body: dict, token: str) -> dict:
    req = urllib.request.Request(
        API + path,
        data=json.dumps(body).encode(),
        method=method,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")[:500]
        raise RuntimeError(f"{method} {path} -> HTTP {exc.code}: {detail}") from exc


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--apply", action="store_true", help="aplicar de facto (sem isto, só simula)")
    args = parser.parse_args()

    cfg = load_config()
    zone = os.getenv("CLOUDFLARE_ZONE_ID", "")
    token = os.getenv("CLOUDFLARE_API_TOKEN", "")
    requests = plan(cfg, zone or "<ZONE_ID>")

    if not args.apply:
        print(f"Simulação: {len(requests)} pedidos (nada é alterado).")
        for method, path, body in requests:
            print(f"  {method} {path}")
            if "rules" in body:
                for r in body["rules"]:
                    print(f"      - [{r['action']}] {r['description']}")
            else:
                print(f"      value = {body['value']!r}")
        return 0

    if not zone or not token:
        print("Faltam CLOUDFLARE_ZONE_ID e/ou CLOUDFLARE_API_TOKEN.", file=sys.stderr)
        return 2
    failed = 0
    for method, path, body in requests:
        try:
            result = call(method, path, body, token)
            print(f"OK   {method} {path}" if result.get("success") else f"FALHA {method} {path}: {result.get('errors')}")
            failed += 0 if result.get("success") else 1
        except RuntimeError as exc:
            # O token nunca aparece nas mensagens: só o método, o caminho e a resposta da API.
            print(f"FALHA {exc}", file=sys.stderr)
            failed += 1
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
