param(
  [Parameter(Mandatory=$true)]
  [ValidatePattern('^([01]\d|2[0-3]):[0-5]\d$')]
  [string]$Time
)

$configPath = Join-Path $PSScriptRoot 'tiktok-automation.config.json'
$config = [IO.File]::ReadAllText($configPath, [Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
$node = 'C:\Program Files\nodejs\node.exe'
$job = Join-Path $PSScriptRoot 'tiktok-sync-runner.js'
$prefix = 'TikTokShop自动下载并导入'

Get-ScheduledTask -ErrorAction SilentlyContinue |
  Where-Object { $_.TaskName -like "$prefix*" } |
  ForEach-Object { Unregister-ScheduledTask -TaskName $_.TaskName -Confirm:$false }

$enabledCount = @($config.shopMappings | Where-Object { $_.automationEnabled -ne $false }).Count
# 直接执行 Node，避免 cmd.exe 在 Program Files 路径上产生引号解析错误。
# 同步过程的真实状态由 runner 写入“待处理\同步助手状态.json”。
$action = New-ScheduledTaskAction -Execute $node -Argument ('"' + $job + '"') -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -Daily -At ([datetime]::ParseExact($Time, 'HH:mm', $null))
$principal = New-ScheduledTaskPrincipal -UserId ("$env:USERDOMAIN\$env:USERNAME") -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $prefix -Action $action -Trigger $trigger -Principal $principal -Description ("TikTok Shop 自动同步：按顺序处理 " + $enabledCount + " 家店铺") -Force | Out-Null

$settingsPath = Join-Path $config.rootDir '自动任务设置.json'
[IO.File]::WriteAllText($settingsPath, (@{ time = $Time } | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
Write-Output ("已保存单任务串行自动同步：" + $Time + "，共 " + $enabledCount + " 家店铺")
