# Regista (ou remove) o Aegis Guardian como tarefa agendada ao iniciar sessão.
# Corre só para o utilizador atual, sem privilégios elevados e sem janela.
param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$taskName = 'AegisGuardian'

if ($Remove) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Output 'Tarefa removida.'
    return
}

$pythonw = (Get-Command pythonw.exe -ErrorAction SilentlyContinue).Source
if (-not $pythonw) { throw 'pythonw.exe não encontrado no PATH.' }

$action = New-ScheduledTaskAction -Execute $pythonw -Argument '-m guardian run' -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -Priority 7
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
    -Principal $principal -Description 'Aegis Guardian: vigilância local de processos e rede.' -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Output "Tarefa '$taskName' registada e iniciada."
