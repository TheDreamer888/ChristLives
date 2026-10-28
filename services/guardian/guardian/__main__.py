"""Aegis Guardian — linha de comandos.

  python -m guardian run [--learn-hours 24] [--no-notify]
  python -m guardian status
  python -m guardian alerts [-n 20]
  python -m guardian allow (--last | CAMINHO_OU_NOME) [--remove]
  python -m guardian test-notify
  python -m guardian reset
"""
from __future__ import annotations

import argparse
import json
import ntpath
import sys
import time
from pathlib import Path

from guardian.baseline import Baseline, data_dir, load_allowlist, save_allowlist


def _read_alerts(folder: Path, limit: int) -> list[dict]:
    log = folder / "alerts.jsonl"
    if not log.exists():
        return []
    out = []
    for line in log.read_text(encoding="utf-8").splitlines()[-limit:]:
        try:
            out.append(json.loads(line))
        except ValueError:
            continue
    return out


def _print_alert(e: dict) -> None:
    when = time.strftime("%Y-%m-%d %H:%M", time.localtime(e["ts"]))
    print(f"  {when}  [{e.get('pontos', '?')} pts] {e['tipo']}: {e['alvo']}")
    for reason in e.get("motivos", [])[:3]:
        print(f"      - {reason}")


def main() -> None:
    # A consola do Windows usa cp1252 por omissão; acentos e setas exigem UTF-8.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(prog="guardian", description="Vigilância local de processos e rede.")
    sub = parser.add_subparsers(dest="cmd", required=True)
    run = sub.add_parser("run", help="vigiar em segundo plano")
    run.add_argument("--learn-hours", type=float, default=24.0, help="horas a aprender o normal (só na 1.ª vez)")
    run.add_argument("--no-notify", action="store_true", help="só registar, sem notificações")
    run.add_argument("--once", action="store_true", help="uma passagem e sair")
    sub.add_parser("status", help="estado da linha de base e últimos alertas")
    alerts = sub.add_parser("alerts", help="histórico de alertas com os motivos")
    alerts.add_argument("-n", type=int, default=20, help="quantos alertas mostrar")
    allow = sub.add_parser("allow", help="marcar um programa como seguro (falso positivo)")
    allow.add_argument("target", nargs="?", help="caminho completo ou nome do executável")
    allow.add_argument("--last", action="store_true", help="usar o programa do último alerta")
    allow.add_argument("--remove", action="store_true", help="retirar da lista de permitidos")
    report = sub.add_parser("report", help="gerar um relatório HTML local e abri-lo")
    report.add_argument("--no-open", action="store_true", help="só gerar, sem abrir no browser")
    sub.add_parser("test-notify", help="mostrar uma notificação de teste")
    sub.add_parser("reset", help="apagar a linha de base e voltar a aprender")
    args = parser.parse_args()

    if args.cmd == "report":
        import os

        from guardian.report import write_report

        folder = data_dir()
        path = write_report(folder, _read_alerts(folder, 500), load_allowlist(folder / "allow.json"))
        print(f"Relatório: {path}")
        if not args.no_open and hasattr(os, "startfile"):
            os.startfile(path)  # abre no browser predefinido (só Windows)
        return

    if args.cmd == "run":
        from guardian.monitor import Guardian

        try:
            Guardian(learn_hours=args.learn_hours, notify=not args.no_notify).run(once=args.once)
        except KeyboardInterrupt:
            pass
    elif args.cmd == "status":
        folder = data_dir()
        b = Baseline.load(folder / "baseline.json")
        if b is None:
            print("Sem linha de base. Corre: python -m guardian run")
            return
        left = max(0, b.learning_until - time.time())
        print(f"Pasta: {folder}")
        print(f"Modo: {'a aprender (' + str(round(left / 3600, 1)) + ' h restantes)' if left else 'a vigiar'}")
        print(f"Conhecidos: {len(b.exes)} programas, {len(b.pairs)} pares pai→filho, "
              f"{len(b.endpoints)} destinos de rede, {len(b.listeners)} portas a escutar")
        allowed = load_allowlist(folder / "allow.json")
        print(f"Permitidos: {len(allowed)}")
        recent = _read_alerts(folder, 5)
        if recent:
            print(f"Últimos alertas ({len(recent)}):")
            for e in recent:
                _print_alert(e)
    elif args.cmd == "alerts":
        recent = _read_alerts(data_dir(), max(1, args.n))
        if not recent:
            print("Sem alertas registados.")
        for e in recent:
            _print_alert(e)
    elif args.cmd == "allow":
        folder = data_dir()
        target = args.target
        if args.last:
            recent = _read_alerts(folder, 1)
            target = (recent[0].get("exe") or "") if recent else ""
        if not target:
            parser.error("indica um caminho/nome ou usa --last (o último alerta não tem programa associado)")
        path = folder / "allow.json"
        items = load_allowlist(path)
        keys = {target.lower()}
        if args.remove:
            items -= keys
            save_allowlist(path, items)
            print(f"Retirado dos permitidos: {target}")
        else:
            items |= keys
            save_allowlist(path, items)
            print(f"Marcado como seguro: {target}")
            if ntpath.basename(target) != target:
                print("Vale só para este caminho: uma cópia noutra pasta continua a ser vigiada.")
            else:
                print("Um nome sem caminho só silencia alertas de rede; para processos indica o caminho completo.")
    elif args.cmd == "test-notify":
        from guardian.notify import toast

        print("Notificação enviada." if toast("Aegis Guardian", "Teste de notificação — está tudo a funcionar.") else "Não foi possível notificar.")
    elif args.cmd == "reset":
        path = data_dir() / "baseline.json"
        path.unlink(missing_ok=True)
        print("Linha de base apagada. O próximo arranque volta a aprender.")


if __name__ == "__main__":
    main()
