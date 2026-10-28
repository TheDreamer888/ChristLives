"""Ciclo de vigilância com baixo consumo.

- Só inspeciona processos novos (comparação de PIDs), nunca re-analisa tudo.
- Processos a cada 5 s e ligações a cada 20 s; o próprio agente corre com
  prioridade baixa.
- Nunca termina processos: só avisa e regista.
"""
from __future__ import annotations

import ipaddress
import json
import sys
import time
from pathlib import Path

import psutil

from guardian.baseline import Baseline, data_dir, load_allowlist
from guardian.notify import toast
from guardian.rules import ConnInfo, ProcInfo, Verdict, score_connection, score_process

PROC_INTERVAL = 5
NET_INTERVAL = 20
SAVE_INTERVAL = 300
DEDUPE_SECONDS = 3600
_LOG_MAX_BYTES = 5 * 1024 * 1024


def _lower_own_priority() -> None:
    try:
        me = psutil.Process()
        if sys.platform == "win32":
            me.nice(psutil.BELOW_NORMAL_PRIORITY_CLASS)
        else:
            me.nice(10)
    except (psutil.Error, OSError):
        pass


def _is_loopback(ip: str | None) -> bool:
    try:
        return ip is not None and ipaddress.ip_address(ip).is_loopback
    except ValueError:
        return False


class Guardian:
    def __init__(self, learn_hours: float = 24.0, notify: bool = True) -> None:
        self.dir: Path = data_dir()
        self.baseline_path = self.dir / "baseline.json"
        self.log_path = self.dir / "alerts.jsonl"
        loaded = Baseline.load(self.baseline_path)
        if loaded is None:
            loaded = Baseline(learning_until=time.time() + learn_hours * 3600)
        self.baseline = loaded
        self.notify = notify
        self.seen: set[tuple[int, float]] = set()
        self.names: dict[int, str] = {}
        self.recent_alerts: dict[str, float] = {}
        self.dirty = False
        # Lista de permitidos num ficheiro à parte: `guardian allow` pode editá-la
        # com o agente a correr; é relida só quando o ficheiro muda.
        self.allow_path = self.dir / "allow.json"
        self.allowed: set[str] = set()
        self._allow_mtime = -1.0

    def _refresh_allowlist(self) -> None:
        try:
            mtime = self.allow_path.stat().st_mtime
        except OSError:
            mtime = 0.0
        if mtime != self._allow_mtime:
            self._allow_mtime = mtime
            self.allowed = load_allowlist(self.allow_path)

    def _process_allowed(self, exe: str | None) -> bool:
        # Só o caminho exato: permitir um nome (ex.: svchost.exe) desligaria a
        # deteção de imitações noutras pastas.
        return bool(exe) and exe.lower() in self.allowed

    def _connection_allowed(self, name: str | None) -> bool:
        if not name or not self.allowed:
            return False
        name = name.lower()
        return name in self.allowed or any(a.endswith("\\" + name) for a in self.allowed)

    # ---- processos ----
    def scan_processes(self, first_pass: bool = False) -> list[Verdict]:
        self._refresh_allowlist()
        verdicts: list[Verdict] = []
        alive: set[tuple[int, float]] = set()
        fresh: list[tuple[psutil.Process, str]] = []
        # process_iter reutiliza os objetos entre chamadas: create_time() fica em cache.
        for proc in psutil.process_iter():
            try:
                key = (proc.pid, proc.create_time())
                if key not in self.seen:
                    fresh.append((proc, proc.name()))
                    self.names[proc.pid] = fresh[-1][1]
            except (psutil.NoSuchProcess, psutil.ZombieProcess, psutil.AccessDenied):
                continue
            alive.add(key)
        self.seen = alive
        alive_pids = {pid for pid, _ in alive}
        self.names = {pid: n for pid, n in self.names.items() if pid in alive_pids}
        if not fresh:
            return verdicts

        parents = _ppid_map()  # uma só leitura para todos os processos novos
        for proc, name in fresh:
            ppid = parents.get(proc.pid)
            info = ProcInfo(
                pid=proc.pid,
                name=name,
                exe=_safe(proc.exe),
                cmdline=" ".join(_safe(proc.cmdline) or [])[:2000],
                parent_name=self.names.get(ppid) if ppid else None,
            )
            exe = (info.exe or "").lower() or None
            pair = f"{(info.parent_name or '').lower()}>{name.lower()}" if info.parent_name else None
            if not (first_pass or self.baseline.learning or self._process_allowed(exe)):
                v = score_process(info, self.baseline.exes, self.baseline.pairs)
                if v.alert:
                    self._raise("processo", f"{name} (PID {proc.pid})", info.exe, v)
                    verdicts.append(v)
                    continue  # suspeito não entra na linha de base
            self.baseline.learn_process(exe, pair)
            self.dirty = True
        return verdicts

    # ---- rede ----
    def scan_connections(self) -> list[Verdict]:
        verdicts: list[Verdict] = []
        try:
            conns = psutil.net_connections(kind="inet")
        except (psutil.AccessDenied, OSError):
            return verdicts  # sem privilégios: só processos
        for c in conns:
            remote_ip = c.raddr.ip if c.raddr else None
            if c.status != "LISTEN" and (remote_ip is None or _is_loopback(remote_ip)):
                continue
            info = ConnInfo(
                pid=c.pid,
                exe_name=self.names.get(c.pid) if c.pid else None,
                status=c.status,
                local_port=c.laddr.port if c.laddr else None,
                remote_ip=remote_ip,
                remote_port=c.raddr.port if c.raddr else None,
            )
            who = (info.exe_name or "processo desconhecido").lower()
            endpoint = f"{who}:{info.remote_port}" if info.remote_port else None
            listener = f"{who}:{info.local_port}" if info.status == "LISTEN" else None
            if not (self.baseline.learning or self._connection_allowed(info.exe_name)):
                v = score_connection(info, self.baseline.endpoints, self.baseline.listeners)
                if v.alert:
                    target = f"{info.remote_ip}:{info.remote_port}" if info.remote_port else f"porta {info.local_port}"
                    self._raise("rede", f"{who} → {target}", who, v)
                    verdicts.append(v)
                    continue
            self.baseline.learn_connection(endpoint, listener)
            self.dirty = True
        return verdicts

    # ---- alertas ----
    def _raise(self, kind: str, subject: str, ident: str | None, v: Verdict) -> None:
        key = f"{kind}|{(ident or subject).lower()}|{v.reasons[0]}"
        now = time.time()
        if now - self.recent_alerts.get(key, 0) < DEDUPE_SECONDS:
            return
        self.recent_alerts[key] = now
        entry = {"ts": now, "tipo": kind, "alvo": subject, "exe": ident, "pontos": v.score, "motivos": v.reasons}
        self._log(entry)
        if self.notify:
            toast(
                f"Aegis Guardian: {kind} suspeito",
                f"{subject}\n" + "; ".join(v.reasons[:2]) + "\nSe é seguro: python -m guardian allow --last",
            )

    def _log(self, entry: dict) -> None:
        try:
            if self.log_path.exists() and self.log_path.stat().st_size > _LOG_MAX_BYTES:
                self.log_path.replace(self.log_path.with_suffix(".jsonl.1"))
            with self.log_path.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
        except OSError:
            pass

    def save(self) -> None:
        if self.dirty:
            self.baseline.save(self.baseline_path)
            self.dirty = False

    def run(self, once: bool = False) -> None:
        _lower_own_priority()
        self.scan_processes(first_pass=True)
        self.scan_connections()
        self.save()
        if once:
            return
        last_net = last_save = time.monotonic()
        while True:
            time.sleep(PROC_INTERVAL)
            self.scan_processes()
            now = time.monotonic()
            if now - last_net >= NET_INTERVAL:
                self.scan_connections()
                last_net = now
            if now - last_save >= SAVE_INTERVAL:
                self.save()
                last_save = now


def _ppid_map() -> dict[int, int]:
    """PID -> PID do pai numa única leitura (no Windows, ppid() por processo é caro)."""
    try:
        from psutil import _psplatform

        if hasattr(_psplatform, "ppid_map"):
            return dict(_psplatform.ppid_map())
    except (ImportError, OSError):
        pass
    out: dict[int, int] = {}
    for proc in psutil.process_iter(["ppid"]):
        ppid = proc.info.get("ppid")
        if ppid is not None:
            out[proc.pid] = ppid
    return out


def _safe(fn):
    try:
        return fn()
    except (psutil.AccessDenied, psutil.NoSuchProcess, psutil.ZombieProcess, OSError):
        return None
