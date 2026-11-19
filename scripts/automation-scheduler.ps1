Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = 'Stop'
$taskName = 'TikTokShop自动下载并导入-FeilinkaTH'
$projectDir = Split-Path -Parent $PSScriptRoot
$rootDir = 'G:\源文件\自动同步'
$settingsPath = Join-Path $rootDir '自动任务设置.json'
$nodeExe = 'C:\Program Files\nodejs\node.exe'
$jobScript = Join-Path $PSScriptRoot 'tiktok-daily-job.js'
$logPath = Join-Path $rootDir '自动任务.log'
$automationConfigPath = Join-Path $PSScriptRoot 'tiktok-automation.config.json'

function Get-Settings {
  try { return Get-Content -Raw $settingsPath | ConvertFrom-Json } catch { return [pscustomobject]@{ time = '09:30'; enabled = $true } }
}

function Save-Settings($time, $enabled) {
  @{ time = $time; enabled = $enabled } | ConvertTo-Json | Set-Content -Encoding UTF8 $settingsPath
}

function Get-StoreMappings {
  try { return @((Get-Content -Raw $automationConfigPath | ConvertFrom-Json).shopMappings) } catch { return @() }
}

function Save-StoreMappings($mappings) {
  $config = Get-Content -Raw $automationConfigPath | ConvertFrom-Json
  $config.shopMappings = @($mappings)
  $json = $config | ConvertTo-Json -Depth 6
  [System.IO.File]::WriteAllText($automationConfigPath, $json, [System.Text.UTF8Encoding]::new($false))
}

function Get-TaskSummary {
  try {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
    $info = Get-ScheduledTaskInfo -TaskName $taskName
    $next = if ($info.NextRunTime -and $info.NextRunTime.Year -gt 2000) { $info.NextRunTime.ToString('yyyy-MM-dd HH:mm') } else { '等待计划' }
    return "状态：$($task.State)    下次运行：$next"
  } catch { return '状态：未启用定时任务' }
}

function Set-Task($time) {
  $mappings = Get-StoreMappings
  if (!$mappings.Count) { throw '请先添加至少一个店铺。' }
  foreach ($mapping in $mappings) {
    $key = if ($mapping.profileKey) { $mapping.profileKey } else { 'default' }
    $name = if ($key -eq 'default') { $taskName } else { "TikTokShop自动下载并导入-$key" }
    $command = '"' + $nodeExe + '" "' + $jobScript + '" --store "' + $key + '" >> "' + $logPath + '" 2>&1'
    $action = New-ScheduledTaskAction -Execute 'C:\Windows\System32\cmd.exe' -Argument ('/c ' + $command)
    $trigger = New-ScheduledTaskTrigger -Daily -At ([datetime]::ParseExact($time, 'HH:mm', $null))
    $principal = New-ScheduledTaskPrincipal -UserId ("$env:USERDOMAIN\$env:USERNAME") -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal -Description "每日下载并导入 $($mapping.systemShopCode) 前一天订单；异常停止。" -Force | Out-Null
  }
}

$settings = Get-Settings
$form = New-Object System.Windows.Forms.Form
$form.Text = 'TikTok Shop 自动同步助手'
$form.Size = New-Object System.Drawing.Size(520, 420)
$form.StartPosition = 'CenterScreen'
$form.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false

$title = New-Object System.Windows.Forms.Label
$title.Text = 'Feilinka TH · 每日订单自动下载与导入'
$title.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 12, [System.Drawing.FontStyle]::Bold)
$title.Location = New-Object System.Drawing.Point(24, 22)
$title.AutoSize = $true
$form.Controls.Add($title)

$description = New-Object System.Windows.Forms.Label
$description.Text = '自动下载泰国站点前一天订单；仅校验通过且全部为新增时写入系统。更新、重复或登录失效会停止。'
$description.Location = New-Object System.Drawing.Point(24, 58)
$description.Size = New-Object System.Drawing.Size(460, 42)
$form.Controls.Add($description)

$enabledBox = New-Object System.Windows.Forms.CheckBox
$enabledBox.Text = '启用每日自动任务'
$enabledBox.Location = New-Object System.Drawing.Point(26, 118)
$enabledBox.AutoSize = $true
$enabledBox.Checked = [bool]$settings.enabled
$form.Controls.Add($enabledBox)

$timeLabel = New-Object System.Windows.Forms.Label
$timeLabel.Text = '每日运行时间：'
$timeLabel.Location = New-Object System.Drawing.Point(26, 157)
$timeLabel.AutoSize = $true
$form.Controls.Add($timeLabel)

$timePicker = New-Object System.Windows.Forms.DateTimePicker
$timePicker.Format = [System.Windows.Forms.DateTimePickerFormat]::Custom
$timePicker.CustomFormat = 'HH:mm'
$timePicker.ShowUpDown = $true
$timePicker.Location = New-Object System.Drawing.Point(132, 152)
$timePicker.Width = 90
$timePicker.Value = [datetime]::ParseExact([string]$settings.time, 'HH:mm', $null)
$form.Controls.Add($timePicker)

$status = New-Object System.Windows.Forms.Label
$status.Location = New-Object System.Drawing.Point(26, 196)
$status.Size = New-Object System.Drawing.Size(450, 38)
$status.Text = Get-TaskSummary
$form.Controls.Add($status)

$storesLabel = New-Object System.Windows.Forms.Label
$storesLabel.Location = New-Object System.Drawing.Point(26, 224)
$storesLabel.Size = New-Object System.Drawing.Size(450, 22)
$storesLabel.Text = "已配置店铺：$((Get-StoreMappings | ForEach-Object { $_.sellerCenterName }) -join '、')"
$form.Controls.Add($storesLabel)

$addStoreButton = New-Object System.Windows.Forms.Button
$addStoreButton.Text = '添加店铺'
$addStoreButton.Location = New-Object System.Drawing.Point(26, 258)
$addStoreButton.Size = New-Object System.Drawing.Size(110, 36)
$addStoreButton.Add_Click({
  try {
    Add-Type -AssemblyName Microsoft.VisualBasic
    $sellerName = [Microsoft.VisualBasic.Interaction]::InputBox('填写 TikTok Shop 后台右上角显示的店铺名称：', '添加店铺')
    if (!$sellerName) { return }
    $country = [Microsoft.VisualBasic.Interaction]::InputBox('填写国家站点代码，例如 TH、VN：', '添加店铺', 'TH').ToUpper()
    if (!$country) { return }
    $shopCode = [Microsoft.VisualBasic.Interaction]::InputBox('填写系统“店铺管理”中的店铺简称：', '添加店铺')
    if (!$shopCode) { return }
    $profileKey = ($shopCode -replace '[^a-zA-Z0-9_-]', '-').Trim('-').ToLower()
    if (!$profileKey) { $profileKey = "shop-$([DateTime]::Now.ToString('yyyyMMddHHmmss'))" }
    $mappings = Get-StoreMappings
    if ($mappings | Where-Object { $_.sellerCenterName -eq $sellerName -and $_.countryCode -eq $country }) { throw '该 TikTok 店铺已存在。' }
    $mappings += [pscustomobject]@{ sellerCenterName = $sellerName; countryCode = $country; systemShopCode = $shopCode; systemShopName = $shopCode; profileKey = $profileKey; verifiedAt = $null }
    Save-StoreMappings $mappings
    $storesLabel.Text = "已配置店铺：$((Get-StoreMappings | ForEach-Object { $_.sellerCenterName }) -join '、')"
    $profilePath = Join-Path $rootDir ("浏览器配置\\TikTokShop下载助手-" + $profileKey)
    New-Item -ItemType Directory -Path $profilePath -Force | Out-Null
    $chrome = @('C:\Program Files\Google\Chrome\Application\chrome.exe', 'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe') | Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($chrome) { Start-Process -FilePath $chrome -ArgumentList ("--user-data-dir=`"$profilePath`" https://seller.tiktokshopglobalselling.com/") }
    [System.Windows.Forms.MessageBox]::Show("店铺已添加，并已打开独立登录窗口。请先登录 TikTok 店铺，再访问 Render 系统登录管理员账号；完成后回到本面板点击保存计划。", '自动同步助手')
  } catch { [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, '添加失败') }
})
$form.Controls.Add($addStoreButton)

$saveButton = New-Object System.Windows.Forms.Button
$saveButton.Text = '保存计划'
$saveButton.Location = New-Object System.Drawing.Point(150, 258)
$saveButton.Size = New-Object System.Drawing.Size(110, 36)
$saveButton.Add_Click({
  try {
    $time = $timePicker.Value.ToString('HH:mm')
    if ($enabledBox.Checked) { Set-Task $time } else { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue }
    Save-Settings $time $enabledBox.Checked
    $status.Text = Get-TaskSummary
    [System.Windows.Forms.MessageBox]::Show('计划已保存。', '自动同步助手')
  } catch { [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, '保存失败') }
})
$form.Controls.Add($saveButton)

$testButton = New-Object System.Windows.Forms.Button
$testButton.Text = '只读演练'
$testButton.Location = New-Object System.Drawing.Point(274, 258)
$testButton.Size = New-Object System.Drawing.Size(110, 36)
$testButton.Add_Click({
  Start-Process -FilePath $nodeExe -ArgumentList ('"' + $jobScript + '" --dry-run') -WorkingDirectory $projectDir -WindowStyle Hidden
  [System.Windows.Forms.MessageBox]::Show('只读演练已开始：不会下载或导入。请稍后在运行记录中查看结果。', '自动同步助手')
})
$form.Controls.Add($testButton)

$folderButton = New-Object System.Windows.Forms.Button
$folderButton.Text = '打开日志目录'
$folderButton.Location = New-Object System.Drawing.Point(26, 310)
$folderButton.Size = New-Object System.Drawing.Size(110, 36)
$folderButton.Add_Click({ Start-Process explorer.exe $rootDir })
$form.Controls.Add($folderButton)

$closeButton = New-Object System.Windows.Forms.Button
$closeButton.Text = '关闭'
$closeButton.Location = New-Object System.Drawing.Point(398, 310)
$closeButton.Size = New-Object System.Drawing.Size(80, 36)
$closeButton.Add_Click({ $form.Close() })
$form.Controls.Add($closeButton)

[void]$form.ShowDialog()
