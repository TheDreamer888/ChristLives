# Aegis Guardian

Agente leve para Windows que aprende o que é normal no teu PC e avisa, com
notificações do Windows, quando aparecem **processos ou ligações de rede estranhos**.

- **Local:** nada sai do PC. A linha de base e os alertas ficam em
  `%LOCALAPPDATA%\AegisGuardian\`.
- **Leve:** só analisa processos novos; cerca de 0,03 s de CPU a cada 5 s, com
  prioridade baixa. A primeira passagem demora alguns segundos.
- **Não age sozinho:** avisa e regista, nunca termina processos. A decisão é tua.

## O que deteta

| Sinal | Pontos |
|---|---|
| Nome de sistema (`svchost.exe`, `lsass.exe`…) fora das pastas do Windows | 5 |
| Office/browser a lançar PowerShell, cmd, mshta, rundll32… | 4 |
| Ferramentas do Windows com argumentos de ataque (`-enc`, `IEX`, `DownloadString`…) | 4 |
| Ligação ou porta a escutar em portas de backdoor/IRC (4444, 31337, 6667…) | 3 |
| Executável em Temp, Downloads, AppData ou Public | 2 |
| Interpretador de comandos a abrir ligações de rede | 2 |
| Nova porta a escutar | 2 |
| Programa, par pai→filho ou porta remota nunca vistos | 1 cada |

Alerta a partir de **4 pontos**. O mesmo alerta não se repete durante 1 hora.

A "IA" é deteção de anomalias: nas primeiras 24 horas aprende os programas,
pares pai→filho e destinos de rede habituais. Depois, o que for novo soma
pontos. Processos suspeitos nunca entram na linha de base.

## Usar

```powershell
cd services\guardian
python -m pip install -r requirements.txt
python -m guardian test-notify     # confirma que as notificações aparecem
python -m guardian run             # vigia (Ctrl+C para parar)
python -m guardian status          # modo, linha de base e últimos alertas
python -m guardian alerts -n 20    # histórico de alertas com os motivos
python -m guardian report          # relatório HTML local, abre no browser
python -m guardian allow --last    # o último alerta era seguro: não voltar a avisar
python -m guardian allow "C:\Programas\X\x.exe" --remove   # voltar a vigiar
python -m guardian reset           # volta a aprender do zero
```

**Falsos positivos.** `allow` guarda a escolha em `allow.json`, e o agente relê-a
sem precisar de reiniciar. Para processos vale só o **caminho exato**: permitir
`C:\Ferramentas\svchost.exe` não desliga a deteção de um `svchost.exe` falso
noutra pasta. Um nome sem caminho só silencia alertas de rede.

Para arrancar sozinho ao iniciar sessão (sem janela):

```powershell
powershell -ExecutionPolicy Bypass -File services\guardian\install-task.ps1
powershell -ExecutionPolicy Bypass -File services\guardian\install-task.ps1 -Remove
```

Sem privilégios de administrador vê os teus processos e quase todas as
ligações. Alguns processos do sistema ficam invisíveis — é esperado.

## Limites

Regras e anomalias não substituem um antivírus: podem falhar ameaças e dar
falsos positivos. Usa o Guardian como camada extra, não como única defesa.
