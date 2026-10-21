"""Aegis Guardian — linha de comandos.

  python -m guardian run [--learn-hours 24] [--no-notify]
  python -m guardian status
  python -m guardian test-notify
  python -m guardian reset
"""
from __future__ import annotations

import argparse
import json
import sys
import time

from guardian.baseline import Baseline, data_dir


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
    sub.add_parser("test-notify", help="mostrar uma notificação de teste")
    sub.add_parser("reset", help="apagar a linha de base e voltar a aprender")
    args = parser.parse_args()

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
        log = folder / "alerts.jsonl"
        if log.exists():
            lines = log.read_text(encoding="utf-8").splitlines()[-5:]
            print(f"Últimos alertas ({len(lines)}):")
            for line in lines:
                e = json.loads(line)
                print(f"  {time.strftime('%Y-%m-%d %H:%M', time.localtime(e['ts']))}  {e['tipo']}: {e['alvo']} — {'; '.join(e['motivos'][:2])}")
    elif args.cmd == "test-notify":
        from guardian.notify import toast

        print("Notificação enviada." if toast("Aegis Guardian", "Teste de notificação — está tudo a funcionar.") else "Não foi possível notificar.")
    elif args.cmd == "reset":
        path = data_dir() / "baseline.json"
        path.unlink(missing_ok=True)
        print("Linha de base apagada. O próximo arranque volta a aprender.")


if __name__ == "__main__":
    main()
