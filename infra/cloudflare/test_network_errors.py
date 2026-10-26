import urllib.error

import pytest

import apply_security


def test_network_failure_becomes_runtime_error(monkeypatch):
    def offline(*_args, **_kwargs):
        raise urllib.error.URLError("offline")

    monkeypatch.setattr(apply_security.urllib.request, "urlopen", offline)
    with pytest.raises(RuntimeError, match="sem resposta"):
        apply_security.call("PATCH", "/zones/Z/settings/ssl", {"value": "full"}, "token-secreto")


def test_error_message_never_contains_token(monkeypatch):
    def offline(*_args, **_kwargs):
        raise urllib.error.URLError("offline")

    monkeypatch.setattr(apply_security.urllib.request, "urlopen", offline)
    with pytest.raises(RuntimeError) as info:
        apply_security.call("PATCH", "/zones/Z/settings/ssl", {"value": "full"}, "token-secreto")
    assert "token-secreto" not in str(info.value)
