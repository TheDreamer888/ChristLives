from guardian.report import build_html, write_report

ALERT = {
    "ts": 1_800_000_000,
    "tipo": "processo",
    "alvo": "svchost.exe (PID 42)",
    "exe": "C:\\Temp\\svchost.exe",
    "pontos": 9,
    "motivos": ["svchost.exe fora das pastas do Windows"],
}


def test_report_lists_alerts_and_counts():
    html = build_html([ALERT], {"c:\\tools\\ok.exe"}, now=1_800_000_100)
    assert "svchost.exe (PID 42)" in html
    assert "p-high" in html  # 9 pontos = nível alto
    assert "c:\\tools\\ok.exe" in html
    assert "<b>1</b><span>nas últimas 24 h" in html


def test_malicious_process_names_are_escaped():
    evil = dict(ALERT, alvo="<script>alert(1)</script>", motivos=["<img src=x onerror=alert(1)>"])
    html = build_html([evil], set())
    assert "<script>alert(1)</script>" not in html
    assert "&lt;script&gt;" in html
    assert "<img src=x" not in html


def test_report_has_strict_csp_and_no_external_resources():
    html = build_html([], set())
    assert "default-src 'none'" in html
    assert "http://" not in html and "https://" not in html
    assert "Sem alertas registados" in html


def test_write_report_creates_file(tmp_path):
    path = write_report(tmp_path, [ALERT], set())
    assert path.exists() and path.name == "relatorio.html"
