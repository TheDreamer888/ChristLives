import json

import pytest

from guardian.baseline import load_allowlist, save_allowlist


@pytest.fixture
def guardian(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    from guardian.monitor import Guardian

    return Guardian(learn_hours=0, notify=False)


def test_allowlist_roundtrip_lowercases(tmp_path):
    path = tmp_path / "allow.json"
    save_allowlist(path, {"C:\\Tools\\Thing.exe"})
    assert load_allowlist(path) == {"c:\\tools\\thing.exe"}


def test_corrupt_allowlist_is_empty(tmp_path):
    path = tmp_path / "allow.json"
    path.write_text("{not json", encoding="utf-8")
    assert load_allowlist(path) == set()


def test_process_allowed_only_by_exact_path(guardian):
    save_allowlist(guardian.allow_path, {"c:\\tools\\svchost.exe", "svchost.exe"})
    guardian._refresh_allowlist()
    assert guardian._process_allowed("C:\\Tools\\svchost.exe")
    # um nome sem caminho não pode desligar a deteção de imitações noutras pastas
    assert not guardian._process_allowed("C:\\Users\\A\\AppData\\Local\\Temp\\svchost.exe")


def test_connection_allowed_by_name_or_path(guardian):
    save_allowlist(guardian.allow_path, {"c:\\tools\\agent.exe", "sync.exe"})
    guardian._refresh_allowlist()
    assert guardian._connection_allowed("agent.exe")
    assert guardian._connection_allowed("SYNC.EXE")
    assert not guardian._connection_allowed("other.exe")


def test_allowlist_reloads_when_file_changes(guardian):
    guardian._refresh_allowlist()
    assert not guardian._process_allowed("c:\\a\\b.exe")
    guardian.allow_path.write_text(json.dumps(["c:\\a\\b.exe"]), encoding="utf-8")
    guardian._allow_mtime = -2  # garantir que a mudança é vista mesmo com mtime grosso
    guardian._refresh_allowlist()
    assert guardian._process_allowed("C:\\a\\b.exe")
