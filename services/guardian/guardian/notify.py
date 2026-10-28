"""Notificações nativas do Windows, sem dependências externas.

Usa a API de toasts do Windows através do PowerShell. O XML (já escapado) passa
numa variável de ambiente e nunca é interpretado como código.
"""
from __future__ import annotations

import os
import subprocess
import sys
from xml.sax.saxutils import escape

_APP_ID = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe"

_SCRIPT = r"""
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
$doc = New-Object Windows.Data.Xml.Dom.XmlDocument
$doc.LoadXml($env:AEGIS_TOAST_XML)
$toast = [Windows.UI.Notifications.ToastNotification]::new($doc)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('%s').Show($toast)
""" % _APP_ID


def toast(title: str, body: str) -> bool:
    """Mostra uma notificação. Devolve False se não for possível (ex.: fora do Windows)."""
    if sys.platform != "win32":
        print(f"[Aegis Guardian] {title}: {body}")
        return False
    xml = (
        "<toast><visual><binding template='ToastGeneric'>"
        f"<text>{escape(title[:120])}</text><text>{escape(body[:400])}</text>"
        "</binding></visual></toast>"
    )
    try:
        subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", _SCRIPT],
            env={**os.environ, "AEGIS_TOAST_XML": xml},
            check=False,
            timeout=15,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        return True
    except (OSError, subprocess.SubprocessError):
        return False
