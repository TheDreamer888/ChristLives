"""Regras de pontuação — funções puras, sem psutil, fáceis de testar.

Cada sinal soma pontos e explica-se a si próprio. Um alerta nasce quando a
soma passa o limiar (ver monitor.py). Nada aqui termina processos: o objetivo
é avisar com contexto, não agir sozinho.
"""
from __future__ import annotations

import ntpath
import re
from dataclasses import dataclass, field

# Pastas onde qualquer utilizador escreve — origem comum de malware.
_USER_WRITABLE = (
    "\\appdata\\local\\temp\\",
    "\\windows\\temp\\",
    "\\downloads\\",
    "\\users\\public\\",
    "\\appdata\\roaming\\",
    "\\programdata\\",
    "\\$recycle.bin\\",
)

# Binários do sistema que costumam ser imitados por nome.
_SYSTEM_NAMES = {
    "svchost.exe", "lsass.exe", "csrss.exe", "winlogon.exe", "services.exe",
    "smss.exe", "wininit.exe", "explorer.exe", "spoolsv.exe", "taskhostw.exe",
}
_SYSTEM_DIRS = ("\\windows\\system32\\", "\\windows\\syswow64\\", "\\windows\\")

# Pais que normalmente não lançam interpretadores de comandos.
_DOCUMENT_PARENTS = {
    "winword.exe", "excel.exe", "powerpnt.exe", "outlook.exe", "onenote.exe",
    "acrord32.exe", "acrobat.exe", "msedge.exe", "chrome.exe", "firefox.exe",
    "brave.exe", "opera.exe", "teams.exe", "wmiprvse.exe",
}
# Ferramentas do próprio Windows usadas em ataques ("living off the land").
_LOLBINS = {
    "powershell.exe", "pwsh.exe", "cmd.exe", "wscript.exe", "cscript.exe",
    "mshta.exe", "rundll32.exe", "regsvr32.exe", "certutil.exe", "bitsadmin.exe",
    "msiexec.exe", "installutil.exe", "wmic.exe",
}
_SUSPICIOUS_CMD = re.compile(
    r"(-enc(odedcommand)?\s|frombase64string|downloadstring|downloadfile|invoke-expression|\biex\b"
    r"|-w(indowstyle)?\s+hidden|-nop\b|bypass|urlcache|http[s]?://|\\\\[0-9.]+\\)",
    re.IGNORECASE,
)

# Portas associadas a ferramentas de controlo remoto/backdoors e IRC.
_SUSPICIOUS_PORTS = {23, 1337, 4444, 4445, 5555, 6666, 6667, 6697, 8081, 9001, 9050, 12345, 31337}

ALERT_THRESHOLD = 4


@dataclass(frozen=True)
class ProcInfo:
    pid: int
    name: str
    exe: str | None
    cmdline: str
    parent_name: str | None


@dataclass(frozen=True)
class ConnInfo:
    pid: int | None
    exe_name: str | None
    status: str
    local_port: int | None
    remote_ip: str | None
    remote_port: int | None


@dataclass
class Verdict:
    score: int = 0
    reasons: list[str] = field(default_factory=list)

    def add(self, points: int, reason: str) -> None:
        self.score += points
        self.reasons.append(reason)

    @property
    def alert(self) -> bool:
        return self.score >= ALERT_THRESHOLD


def _norm(path: str | None) -> str:
    return (path or "").replace("/", "\\").lower()


def score_process(p: ProcInfo, known_exes: set[str], known_pairs: set[str]) -> Verdict:
    v = Verdict()
    name = p.name.lower()
    exe = _norm(p.exe)
    parent = (p.parent_name or "").lower()

    if name in _SYSTEM_NAMES and exe and not any(d in exe for d in _SYSTEM_DIRS):
        v.add(5, f"{p.name} fora das pastas do Windows ({p.exe}) — possível imitação")
    if exe and any(d in exe for d in _USER_WRITABLE):
        v.add(2, f"executável numa pasta temporária ou de transferências ({p.exe})")
    if parent in _DOCUMENT_PARENTS and name in _LOLBINS:
        v.add(4, f"{p.parent_name} lançou {p.name}")
    if name in _LOLBINS and _SUSPICIOUS_CMD.search(p.cmdline or ""):
        v.add(4, f"{p.name} com argumentos típicos de ataque")
    if exe and exe not in known_exes:
        v.add(1, "programa nunca visto neste PC")
    pair = f"{parent}>{name}"
    if parent and pair not in known_pairs:
        v.add(1, f"combinação pai→filho nova ({p.parent_name} → {p.name})")
    if exe and ntpath.basename(exe) != name and name.endswith(".exe"):
        v.add(1, "nome do processo diferente do ficheiro executável")
    return v


def score_connection(c: ConnInfo, known_endpoints: set[str], known_listeners: set[str]) -> Verdict:
    v = Verdict()
    who = (c.exe_name or "processo desconhecido").lower()
    if c.status == "LISTEN" and c.local_port is not None:
        key = f"{who}:{c.local_port}"
        if key not in known_listeners:
            v.add(2, f"{who} começou a escutar na porta {c.local_port}")
            if c.local_port in _SUSPICIOUS_PORTS:
                v.add(3, f"porta {c.local_port} associada a backdoors")
        return v
    if c.remote_port is None:
        return v
    if c.remote_port in _SUSPICIOUS_PORTS:
        v.add(3, f"{who} ligado a {c.remote_ip}:{c.remote_port} (porta associada a backdoors/IRC)")
    if f"{who}:{c.remote_port}" not in known_endpoints:
        v.add(1, f"{who} usa a porta remota {c.remote_port} pela primeira vez")
    if c.pid is None or c.exe_name is None:
        v.add(1, "ligação sem processo identificável")
    if who in _LOLBINS:
        v.add(2, f"{who} a abrir ligações de rede")
    return v
