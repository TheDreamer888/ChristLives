"""Linha de base: o que é normal neste PC. Guardada só localmente."""
from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field
from pathlib import Path

_MAX_ITEMS = 20_000  # teto para o ficheiro não crescer sem limite


def data_dir() -> Path:
    base = os.getenv("LOCALAPPDATA") or str(Path.home() / ".local" / "share")
    path = Path(base) / "AegisGuardian"
    path.mkdir(parents=True, exist_ok=True)
    return path


@dataclass
class Baseline:
    exes: set[str] = field(default_factory=set)
    pairs: set[str] = field(default_factory=set)
    endpoints: set[str] = field(default_factory=set)
    listeners: set[str] = field(default_factory=set)
    learning_until: float = 0.0

    @property
    def learning(self) -> bool:
        return time.time() < self.learning_until

    def learn_process(self, exe: str | None, pair: str | None) -> None:
        if exe and len(self.exes) < _MAX_ITEMS:
            self.exes.add(exe)
        if pair and len(self.pairs) < _MAX_ITEMS:
            self.pairs.add(pair)

    def learn_connection(self, endpoint: str | None, listener: str | None) -> None:
        if endpoint and len(self.endpoints) < _MAX_ITEMS:
            self.endpoints.add(endpoint)
        if listener and len(self.listeners) < _MAX_ITEMS:
            self.listeners.add(listener)

    def save(self, path: Path) -> None:
        tmp = path.with_suffix(".tmp")
        tmp.write_text(
            json.dumps(
                {
                    "exes": sorted(self.exes),
                    "pairs": sorted(self.pairs),
                    "endpoints": sorted(self.endpoints),
                    "listeners": sorted(self.listeners),
                    "learning_until": self.learning_until,
                }
            ),
            encoding="utf-8",
        )
        tmp.replace(path)

    @classmethod
    def load(cls, path: Path) -> "Baseline | None":
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        return cls(
            exes=set(raw.get("exes", [])),
            pairs=set(raw.get("pairs", [])),
            endpoints=set(raw.get("endpoints", [])),
            listeners=set(raw.get("listeners", [])),
            learning_until=float(raw.get("learning_until", 0)),
        )
