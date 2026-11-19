param(
  [Parameter(Mandatory = $true)]
  [string]$DataDirectory,
  [string]$Database = 'tiktok_profit_local',
  [string]$AppUser = 'tiktok_app',
  [switch]$ResetLocalData,
  [switch]$VerifyOnly
)

$ErrorActionPreference = 'Stop'
$env:PGCLIENTENCODING = 'UTF8'
$projectRoot = Split-Path -Parent $PSScriptRoot
$psql = @(
  (Get-Command psql.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source),
  (Get-ChildItem 'C:\Program Files\PostgreSQL' -Filter psql.exe -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName),
  (Get-ChildItem 'D:\PostgreSQL' -Filter psql.exe -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName)
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1

if (-not $psql) { throw 'psql.exe was not found. Install PostgreSQL Command Line Tools first.' }
if (-not (Test-Path (Join-Path $DataDirectory 'manifest.json'))) { throw 'The supplied export folder does not contain manifest.json.' }

$securePassword = Read-Host -AsSecureString 'Enter the local tiktok_app password'
$plainPassword = [System.Net.NetworkCredential]::new('', $securePassword).Password
$env:PGPASSWORD = $plainPassword

try {
  $nodeArguments = @((Join-Path $PSScriptRoot 'import-local-business-data.js'), '--data-dir', $DataDirectory, '--psql', $psql, '--database', $Database, '--user', $AppUser)
  if ($ResetLocalData) { $nodeArguments += '--reset-local-data' }
  if ($VerifyOnly) { $nodeArguments += '--verify-only' }
  & node @nodeArguments
  if ($LASTEXITCODE -ne 0) { throw 'Local data import failed. The failure is shown above; no online data was changed.' }
} finally {
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
}
