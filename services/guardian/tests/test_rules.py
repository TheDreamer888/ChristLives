from guardian.rules import ConnInfo, ProcInfo, score_connection, score_process


def proc(name, exe, parent=None, cmd=""):
    return ProcInfo(pid=1, name=name, exe=exe, cmdline=cmd, parent_name=parent)


KNOWN_EXE = {"c:\\windows\\system32\\svchost.exe", "c:\\program files\\app\\app.exe"}
KNOWN_PAIRS = {"services.exe>svchost.exe", "explorer.exe>app.exe"}


def test_known_process_is_quiet():
    v = score_process(proc("svchost.exe", "C:\\Windows\\System32\\svchost.exe", "services.exe"), KNOWN_EXE, KNOWN_PAIRS)
    assert v.score == 0 and not v.alert


def test_masquerading_system_name_alerts():
    v = score_process(proc("svchost.exe", "C:\\Users\\A\\AppData\\Local\\Temp\\svchost.exe", "explorer.exe"), KNOWN_EXE, KNOWN_PAIRS)
    assert v.alert
    assert any("imitação" in r for r in v.reasons)


def test_office_spawning_encoded_powershell_alerts():
    v = score_process(
        proc("powershell.exe", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
             "WINWORD.EXE", "powershell -nop -w hidden -enc SQBFAFgA"),
        KNOWN_EXE, KNOWN_PAIRS,
    )
    assert v.alert and v.score >= 8


def test_new_but_benign_program_does_not_alert():
    v = score_process(proc("tool.exe", "C:\\Program Files\\Tool\\tool.exe", "explorer.exe"), KNOWN_EXE, KNOWN_PAIRS)
    assert not v.alert  # novo programa + novo par = 2 pontos, abaixo do limiar


def test_backdoor_port_connection_alerts():
    c = ConnInfo(pid=9, exe_name="update.exe", status="ESTABLISHED", local_port=50000, remote_ip="203.0.113.5", remote_port=4444)
    v = score_connection(c, known_endpoints=set(), known_listeners=set())
    assert v.alert


def test_known_https_connection_is_quiet():
    c = ConnInfo(pid=9, exe_name="chrome.exe", status="ESTABLISHED", local_port=50000, remote_ip="203.0.113.5", remote_port=443)
    v = score_connection(c, known_endpoints={"chrome.exe:443"}, known_listeners=set())
    assert v.score == 0


def test_new_listener_on_backdoor_port_alerts():
    c = ConnInfo(pid=9, exe_name="x.exe", status="LISTEN", local_port=31337, remote_ip=None, remote_port=None)
    assert score_connection(c, set(), set()).alert
