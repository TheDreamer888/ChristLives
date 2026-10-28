"""Relatório HTML local com os alertas e a lista de permitidos.

A página é autónoma: CSS embutido, sem scripts nem recursos externos. Todo o
texto vindo de processos (nomes, caminhos, motivos) é escapado, porque um
programa malicioso escolhe o próprio nome.
"""
from __future__ import annotations

import time
from collections import Counter
from html import escape
from pathlib import Path

_CSS = """
:root { --bg:#0b1220; --card:#111a2e; --text:#e8eef9; --muted:#9fb0c8; --line:#22304a;
        --high:#fb7185; --mid:#fbbf24; --low:#5eead4; color-scheme: dark; }
* { box-sizing: border-box; }
body { margin:0; padding:32px 16px; background:var(--bg); color:var(--text);
       font:15px/1.5 system-ui, "Segoe UI", sans-serif; }
main { max-width:1000px; margin:0 auto; }
h1 { margin:0 0 4px; font-size:1.6rem; letter-spacing:.02em; }
.sub { color:var(--muted); margin:0 0 24px; }
.stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:12px; margin-bottom:24px; }
.stat { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px 16px; }
.stat b { display:block; font-size:1.8rem; }
.stat span { color:var(--muted); font-size:.85rem; }
section { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px; margin-bottom:20px; }
h2 { margin:0 0 12px; font-size:1.1rem; }
table { width:100%; border-collapse:collapse; }
th, td { text-align:left; padding:10px 8px; border-top:1px solid var(--line); vertical-align:top; }
th { color:var(--muted); font-weight:600; font-size:.8rem; text-transform:uppercase; letter-spacing:.06em; border-top:0; }
td.when { white-space:nowrap; color:var(--muted); }
.pts { display:inline-block; min-width:2.2em; text-align:center; border-radius:999px; padding:1px 8px; font-weight:700; color:#06101f; }
.p-high { background:var(--high); } .p-mid { background:var(--mid); } .p-low { background:var(--low); }
ul { margin:4px 0 0; padding-left:18px; color:var(--muted); }
code { background:#0b1220; border:1px solid var(--line); border-radius:6px; padding:1px 6px; word-break:break-all; }
.empty { color:var(--muted); margin:0; }
@media (max-width:640px) { th:nth-child(3), td:nth-child(3) { display:none; } }
"""


def _level(points: int) -> str:
    return "p-high" if points >= 8 else "p-mid" if points >= 5 else "p-low"


def build_html(alerts: list[dict], allowed: set[str], now: float | None = None) -> str:
    now = time.time() if now is None else now
    recent = sorted(alerts, key=lambda e: e.get("ts", 0), reverse=True)
    last_day = sum(1 for e in recent if now - e.get("ts", 0) < 86400)
    kinds = Counter(e.get("tipo", "?") for e in recent)

    rows = []
    for e in recent:
        when = time.strftime("%Y-%m-%d %H:%M", time.localtime(e.get("ts", 0)))
        pts = int(e.get("pontos", 0) or 0)
        reasons = "".join(f"<li>{escape(str(r))}</li>" for r in e.get("motivos", [])[:5])
        exe = e.get("exe")
        exe_html = f"<br><code>{escape(str(exe))}</code>" if exe else ""
        rows.append(
            f"<tr><td class='when'>{escape(when)}</td>"
            f"<td><span class='pts {_level(pts)}'>{pts}</span></td>"
            f"<td>{escape(str(e.get('tipo', '?')))}</td>"
            f"<td><strong>{escape(str(e.get('alvo', '?')))}</strong>{exe_html}<ul>{reasons}</ul></td></tr>"
        )
    alerts_html = (
        "<table><thead><tr><th>Quando</th><th>Pontos</th><th>Tipo</th><th>Alvo e motivos</th></tr></thead>"
        f"<tbody>{''.join(rows)}</tbody></table>"
        if rows else "<p class='empty'>Sem alertas registados. Bom sinal.</p>"
    )
    allowed_html = (
        "<ul>" + "".join(f"<li><code>{escape(a)}</code></li>" for a in sorted(allowed)) + "</ul>"
        if allowed else "<p class='empty'>Nenhum programa marcado como seguro.</p>"
    )
    generated = escape(time.strftime("%Y-%m-%d %H:%M", time.localtime(now)))
    return f"""<!doctype html>
<html lang="pt"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Aegis Guardian — relatório</title><style>{_CSS}</style></head>
<body><main>
<h1>Aegis Guardian</h1>
<p class="sub">Relatório gerado em {generated}. Só local: nada foi enviado para fora deste PC.</p>
<div class="stats">
  <div class="stat"><b>{len(recent)}</b><span>alertas no registo</span></div>
  <div class="stat"><b>{last_day}</b><span>nas últimas 24 h</span></div>
  <div class="stat"><b>{kinds.get('processo', 0)}</b><span>processos suspeitos</span></div>
  <div class="stat"><b>{kinds.get('rede', 0)}</b><span>ligações suspeitas</span></div>
</div>
<section><h2>Alertas</h2>{alerts_html}</section>
<section><h2>Programas permitidos</h2>{allowed_html}
<p class="empty">Para retirar: <code>python -m guardian allow CAMINHO --remove</code></p></section>
</main></body></html>
"""


def write_report(folder: Path, alerts: list[dict], allowed: set[str]) -> Path:
    path = folder / "relatorio.html"
    path.write_text(build_html(alerts, allowed), encoding="utf-8")
    return path
