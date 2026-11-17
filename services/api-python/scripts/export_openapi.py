"""Exporta o contrato OpenAPI da API para o SDK (packages/sdk/openapi.json).

    python scripts/export_openapi.py           # escreve o ficheiro
    python scripts/export_openapi.py --check   # falha se o ficheiro estiver desatualizado (CI)

Só entram as operações públicas do SDK (auth, waitlist, admin). O JSON é
determinístico (chaves ordenadas) para os diffs no git serem legíveis.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT.parents[1] / "packages" / "sdk" / "openapi.json"
SDK_TAGS = {"auth", "waitlist", "admin"}


def build_spec() -> dict:
    os.environ.setdefault("ENV", "development")
    logging.disable(logging.CRITICAL)
    sys.path.insert(0, str(ROOT))
    from src.app.main import app

    spec = app.openapi()
    paths = {}
    for path, ops in spec["paths"].items():
        kept = {m: op for m, op in ops.items() if set(op.get("tags", [])) & SDK_TAGS}
        if kept:
            paths[path] = kept
    spec["paths"] = paths

    # Remove esquemas que deixaram de ser referenciados depois do filtro.
    used: set[str] = set()

    def walk(node: object) -> None:
        if isinstance(node, dict):
            ref = node.get("$ref")
            if isinstance(ref, str) and ref.startswith("#/components/schemas/"):
                name = ref.rsplit("/", 1)[1]
                if name not in used:
                    used.add(name)
                    walk(spec["components"]["schemas"].get(name, {}))
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(paths)
    schemas = spec.get("components", {}).get("schemas", {})
    spec.setdefault("components", {})["schemas"] = {k: v for k, v in schemas.items() if k in used}
    return spec


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="falha se o ficheiro estiver desatualizado")
    args = parser.parse_args()
    text = json.dumps(build_spec(), indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    if args.check:
        current = TARGET.read_text(encoding="utf-8").replace("\r\n", "\n") if TARGET.exists() else ""
        if current != text:
            print(f"{TARGET} está desatualizado. Corre: python scripts/export_openapi.py", file=sys.stderr)
            return 1
        print("Contrato OpenAPI do SDK em dia.")
        return 0
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    TARGET.write_text(text, encoding="utf-8", newline="\n")
    print(f"Escrito {TARGET.relative_to(ROOT.parents[1])} ({len(json.loads(text)['paths'])} caminhos)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
