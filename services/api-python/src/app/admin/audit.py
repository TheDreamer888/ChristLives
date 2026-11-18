"""Registo de auditoria só de acrescentar, encadeado por HMAC (à prova de alteração).

Cada entrada guarda o hash da anterior; o hash é um HMAC-SHA256 com uma chave
que só o servidor tem (AUDIT_HMAC_KEY). Apagar, reordenar ou editar uma entrada
quebra a cadeia e `verify()` aponta a primeira entrada inválida.

Com DATABASE_URL, as entradas vão para a tabela `audit_log` (partilhada por
todas as instâncias). Opcionalmente escreve também em AUDIT_LOG_PATH (JSONL)
para envio a um SIEM.
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

from src.app import db

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
    """Motor em memória (desenvolvimento e testes)."""

    def __init__(self, key: bytes | None = None, path: str | None = None) -> None:
        env_key = os.getenv("AUDIT_HMAC_KEY")
        self.key_is_ephemeral = key is None and not env_key
        self._key = key or (env_key.encode() if env_key else secrets.token_bytes(32))
        self._path = Path(path) if path else (Path(p) if (p := os.getenv("AUDIT_LOG_PATH")) else None)
        self._entries: list[AuditEntry] = []
        self._lock = threading.Lock()

    def _sign(self, entry: AuditEntry) -> str:
        return hmac.new(self._key, entry.payload(), hashlib.sha256).hexdigest()

    def _build(self, seq: int, prev: str, **kw) -> AuditEntry:
        entry = AuditEntry(seq=seq, ts=time.time(), prev_hash=prev, **kw)
        entry.hash = self._sign(entry)
        return entry

    def _append(self, **kw) -> AuditEntry:
        with self._lock:
            prev = self._entries[-1].hash if self._entries else GENESIS
            entry = self._build(len(self._entries) + 1, prev, **kw)
            self._entries.append(entry)
            return entry

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
        entry = self._append(
            actor_id=actor_id,
            action=action,
            outcome=outcome,
            target=target,
            ip=ip,
            reason=reason,
            details=details or {},
        )
        if self._path:
            try:
                with self._path.open("a", encoding="utf-8") as fh:
                    fh.write(json.dumps(asdict(entry), ensure_ascii=False) + "\n")
            except OSError:
                pass  # a cópia em ficheiro é extra; a cadeia principal continua válida
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


class SqlAuditLog(AuditLog):
    """Cadeia na tabela `audit_log`. Duas instâncias a escrever ao mesmo tempo
    colidem na chave `seq`; a que perde relê o último hash e tenta de novo."""

    def __init__(self, engine, key: bytes | None = None, path: str | None = None) -> None:
        super().__init__(key=key, path=path)
        self._engine = engine

    @staticmethod
    def _from_row(r) -> AuditEntry:
        return AuditEntry(
            seq=r.seq,
            ts=r.ts,
            actor_id=r.actor_id,
            action=r.action,
            outcome=r.outcome,
            target=r.target,
            ip=r.ip,
            reason=r.reason,
            details=json.loads(r.details),
            prev_hash=r.prev_hash,
            hash=r.hash,
        )

    def _append(self, **kw) -> AuditEntry:
        t = db.audit_log
        for _ in range(10):
            with self._engine.begin() as conn:
                last = conn.execute(db.select(t.c.seq, t.c.hash).order_by(t.c.seq.desc()).limit(1)).first()
                seq, prev = (last.seq + 1, last.hash) if last else (1, GENESIS)
                entry = self._build(seq, prev, **kw)
                row = asdict(entry)
                row["details"] = json.dumps(entry.details, ensure_ascii=False)
                try:
                    conn.execute(t.insert().values(**row))
                except db.IntegrityError:
                    continue  # outra instância escreveu o mesmo seq; tenta com o novo último
            return entry
        raise RuntimeError("Não foi possível escrever na auditoria (contenção).")

    def entries(self) -> list[AuditEntry]:
        t = db.audit_log
        with self._engine.connect() as conn:
            return [self._from_row(r) for r in conn.execute(db.select(t).order_by(t.c.seq)).all()]

    def clear(self) -> None:
        with self._engine.begin() as conn:
            conn.execute(db.audit_log.delete())


def make_audit_log() -> AuditLog:
    engine = db.get_engine()
    return SqlAuditLog(engine) if engine is not None else AuditLog()


audit_log = make_audit_log()
