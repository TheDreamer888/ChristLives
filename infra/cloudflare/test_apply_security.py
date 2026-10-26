import copy

import pytest

from apply_security import load_config, plan, validate


def test_shipped_config_is_valid():
    load_config()


def test_plan_covers_settings_rules_and_rate_limit():
    cfg = load_config()
    reqs = plan(cfg, "Z")
    paths = [p for _, p, _ in reqs]
    assert "/zones/Z/settings/always_use_https" in paths
    assert "/zones/Z/rulesets/phases/http_request_firewall_custom/entrypoint" in paths
    assert "/zones/Z/rulesets/phases/http_ratelimit/entrypoint" in paths
    rl = [b for _, p, b in reqs if p.endswith("http_ratelimit/entrypoint")][0]["rules"][0]
    assert rl["ratelimit"]["period"] == 10 and rl["action"] == "block"


@pytest.mark.parametrize(
    "mutate, msg",
    [
        (lambda c: c["zone_settings"].update(ssl="maybe"), "ssl"),
        (lambda c: c["zone_settings"].update(nope="on"), "desconhecida"),
        (lambda c: c["custom_rules"][0].update(action="destroy"), "ação"),
        (lambda c: c["custom_rules"][0].update(expression="(a"), "parênteses"),
        (lambda c: c["rate_limit"].update(period=7), "period"),
        (lambda c: c["rate_limit"].update(characteristics=["ip.src"]), "cf.colo.id"),
    ],
)
def test_invalid_config_is_rejected(mutate, msg):
    cfg = copy.deepcopy(load_config())
    mutate(cfg)
    with pytest.raises(ValueError, match=msg):
        validate(cfg)
