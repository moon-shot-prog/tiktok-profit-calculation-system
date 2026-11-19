param(
  [string]$Database = 'tiktok_profit_local',
  [string]$AppUser = 'tiktok_app'
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

$appPassword = Read-Host -AsSecureString 'tiktok_app password'
$env:PGPASSWORD = [System.Net.NetworkCredential]::new('', $appPassword).Password

$steps = @(
  (Join-Path $projectRoot 'local-postgres\02-local-import-archives.sql'),
  (Join-Path $projectRoot 'local-postgres\migrations\20260930032621_add_order_compact_import_retention.sql')
)
foreach ($step in $steps) {
  Write-Host ("Applying: " + (Split-Path $step -Leaf))
  & $psql -h localhost -p 5432 -U $AppUser -d $Database -v ON_ERROR_STOP=1 -f $step
  if ($LASTEXITCODE -ne 0) { throw ("Migration failed: " + (Split-Path $step -Leaf)) }
}

Write-Host 'Verifying required local tables...'
& $psql -h localhost -p 5432 -U $AppUser -d $Database -v ON_ERROR_STOP=1 -c "select tablename from pg_tables where schemaname = 'public' and tablename in ('orders','order_items','tiktok_bill_records','promotion_expenses','import_archives','order_import_changes') order by tablename;"
if ($LASTEXITCODE -ne 0) { throw 'Verification query failed.' }

Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
Write-Host 'Local business schema created and verified.'
