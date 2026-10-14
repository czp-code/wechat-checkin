#Requires -RunAsAdministrator
<#
    注册 Windows 计划任务：每天定时自动执行在寝打卡。

    用法（在【管理员】PowerShell 里执行一次）：
        powershell -ExecutionPolicy Bypass -File "D:\code\微信脚本\register-task.ps1"

    改打卡时间（默认 19:00）：
        powershell -ExecutionPolicy Bypass -File "D:\code\微信脚本\register-task.ps1" -At 19:30

    从某个日期起生效（默认今天）。举例：在 19:00 之后再注册、又不想让今天就补跑，就写明天：
        powershell -ExecutionPolicy Bypass -File "D:\code\微信脚本\register-task.ps1" -StartDate 2026-10-14

    卸载：
        Unregister-ScheduledTask -TaskName WeChatCheckin -Confirm:$false
#>

param(
    [string]$StartDate = (Get-Date -Format 'yyyy-MM-dd'),
    [string]$At = '19:00'
)

$ErrorActionPreference = 'Stop'

$TaskName = 'WeChatCheckin'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$BatPath = Join-Path $ScriptDir 'run-checkin.bat'

if (-not (Test-Path $BatPath)) {
    throw "找不到入口脚本：$BatPath"
}

$action = New-ScheduledTaskAction -Execute $BatPath -WorkingDirectory $ScriptDir

$trigger = New-ScheduledTaskTrigger -Daily -At $At
# 起始日：早于该时刻的触发点会被忽略，因此可以用它实现「从明天起生效」
$trigger.StartBoundary = "${StartDate}T${At}:00"

$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries

# Interactive 登录类型 = 「只在用户登录时运行」。
# GUI / 用户会话相关的任务不能用 SYSTEM 身份跑，否则拿不到用户环境。
$principal = New-ScheduledTaskPrincipal `
    -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive `
    -RunLevel Highest

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "每天 $At 自动完成在寝点名打卡" `
    -Force | Out-Null

Write-Host ""
Write-Host "已注册计划任务：$TaskName" -ForegroundColor Green
Write-Host "  触发时间：每天 $At（自 $StartDate 起生效）"
Write-Host "  入口脚本：$BatPath"
Write-Host "  日志文件：$ScriptDir\logs\checkin.log"
Write-Host ""
Write-Host "可在 taskschd.msc 里找到该任务，右键「运行」立即试跑一次。" -ForegroundColor Yellow
Write-Host "「上次运行结果」为 0x0 即表示成功。" -ForegroundColor Yellow
Write-Host ""

Get-ScheduledTask -TaskName $TaskName | Format-List TaskName, State, Description
