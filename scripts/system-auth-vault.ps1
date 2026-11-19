param(
  [Parameter(Mandatory = $true)][ValidateSet('Save', 'Read')][string]$Action,
  [Parameter(Mandatory = $true)][string]$RootDir,
  [string]$SessionBase64,
  [switch]$SessionFromStdin
)

$ErrorActionPreference = 'Stop'
$vaultPath = Join-Path $RootDir '待处理\\系统管理员授权.dat'

if ($Action -eq 'Save') {
  if ($SessionFromStdin) { $SessionBase64 = [Console]::In.ReadToEnd().Trim() }
  if ([string]::IsNullOrWhiteSpace($SessionBase64)) { throw '未收到系统授权信息。' }
  $sessionJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($SessionBase64))
  $session = $sessionJson | ConvertFrom-Json
  if ([string]::IsNullOrWhiteSpace([string]$session.accessToken) -or [string]::IsNullOrWhiteSpace([string]$session.refreshToken)) {
    throw '系统授权信息不完整。'
  }
  $plain = [Text.Encoding]::UTF8.GetBytes($sessionJson)
  $encrypted = [Security.Cryptography.ProtectedData]::Protect($plain, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  [IO.Directory]::CreateDirectory((Split-Path -Parent $vaultPath)) | Out-Null
  [IO.File]::WriteAllBytes($vaultPath, $encrypted)
  Write-Output 'saved'
  exit 0
}

if (!(Test-Path -LiteralPath $vaultPath)) { throw '尚未保存系统管理员授权。' }
$encrypted = [IO.File]::ReadAllBytes($vaultPath)
$plain = [Security.Cryptography.ProtectedData]::Unprotect($encrypted, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Convert]::ToBase64String($plain)
