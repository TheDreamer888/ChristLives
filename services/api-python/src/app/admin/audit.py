"""Registo de auditoria só de acrescentar, encadeado por HMAC (à prova de alteração).

Cada entrada guarda o hash da anterior; o hash é um HMAC-SHA256 com uma chave
que só o servidor tem (AUDIT_HMAC_KEY). Apagar, reordenar ou editar uma entrada
quebra a cadeia e `verify()` aponta a primeira entrada inválida.

Opcionalmente escreve também em AUDIT_LOG_PATH (JSONL) para envio a um SIEM.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import threading
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

GENESIS = "0" * 64


@dataclass
class AuditEntry:
    seq: int
    ts: float
    actor_id: str | None
    action: str
    outcome: str  # success | denied | error
    target: str | None = None
    ip: str | None = None
    reason: str | None = None
    details: dict = field(default_factory=dict)
    prev_hash: str = GENESIS
    hash: str = ""

    def payload(self) -> bytes:
        data = asdict(self)
        data.pop("hash")
        return json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


class AuditLog:
    def __init__(self, key: bytes | None = None, path: str | None = None) -> None:
        env_key = os.getenv("AUDIT_HMAC_KEY")
        self.key_is_ephemeral = key is None and not env_key
        self._key = key or (env_key.encode() if env_key else secrets.token_bytes(32))
        self._path = Path(path) if path else (Path(p) if (p := os.getenv("AUDIT_LOG_PATH")) else None)
        self._entries: list[AuditEntry] = []
        self._lock = threading.Lock()

    def _sign(self, entry: AuditEntry) -> str:
        return hmac.new(self._key, entry.payload(), hashlib.sha256).hexdigest()

    def record(
        self,
        action: str,
        outcome: str,
        actor_id: str | None,
        target: str | None = None,
        ip: str | None = None,
        reason: str | None = None,
        details: dict | None = None,
    ) -> AuditEntry:
        with self._lock:
            prev = self._entries[-1].hash if self._entries else GENESIS
            entry = AuditEntry(
                seq=len(self._entries) + 1,
                ts=time.time(),
                actor_id=actor_id,
                action=action,
                outcome=outcome,
                target=target,
                ip=ip,
                reason=reason,
                details=details or {},
                prev_hash=prev,
            )
            entry.hash = self._sign(entry)
            self._entries.append(entry)
            if self._path:
                try:
                    with self._path.open("a", encoding="utf-8") as fh:
                        fh.write(json.dumps(asdict(entry), ensure_ascii=False) + "\n")
                except OSError:
                    pass  # a cópia em ficheiro é extra; a cadeia em memória continua válida
            return entry

    def entries(self) -> list[AuditEntry]:
        with self._lock:
            return list(self._entries)

    def verify(self) -> dict:
        prev = GENESIS
        entries = self.entries()
        for i, entry in enumerate(entries, start=1):
            if entry.seq != i or entry.prev_hash != prev or not hmac.compare_digest(entry.hash, self._sign(entry)):
                return {"valid": False, "checked": i - 1, "total": len(entries), "broken_at": entry.seq}
            prev = entry.hash
        return {"valid": True, "checked": len(entries), "total": len(entries), "broken_at": None}

    def clear(self) -> None:  # só para testes
        with self._lock:
            self._entries.clear()


audit_log = AuditLog()
