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

Write-Host 'Step 1/3: Enter the local postgres administrator password.'
$postgresPassword = Read-Host -AsSecureString 'postgres password'
$postgresPlain = [System.Net.NetworkCredential]::new('', $postgresPassword).Password
$env:PGPASSWORD = $postgresPlain
& $psql -h localhost -p 5432 -U postgres -d $Database -v ON_ERROR_STOP=1 -f (Join-Path $projectRoot 'local-postgres\00-local-auth-compat.sql')
if ($LASTEXITCODE -ne 0) { throw 'Postgres administrator authentication or bootstrap failed.' }

Write-Host 'Step 2/3: Enter the local tiktok_app password.'
$appPassword = Read-Host -AsSecureString 'tiktok_app password'
$appPlain = [System.Net.NetworkCredential]::new('', $appPassword).Password
$env:PGPASSWORD = $appPlain
& $psql -h localhost -p 5432 -U $AppUser -d $Database -v ON_ERROR_STOP=1 -f (Join-Path $projectRoot 'local-postgres\01-local-schema-bootstrap.sql')
if ($LASTEXITCODE -ne 0) { throw 'tiktok_app authentication or local bootstrap failed.' }

Write-Host 'Step 3/3: Creating local business tables.'
Get-ChildItem (Join-Path $projectRoot 'local-postgres\migrations') -Filter '*.sql' | Sort-Object Name | ForEach-Object {
  if ($_.Name -eq '20260929054428_add_import_archives_and_rollback_retention.sql') {
    # This legacy migration creates a cloud Storage bucket.  The local
    # PostgreSQL deployment keeps the archive metadata, but stores files on
    # the local server instead, so use the compatible replacement.
    Write-Host 'Applying local replacement: import archives metadata'
    & $psql -h localhost -p 5432 -U $AppUser -d $Database -v ON_ERROR_STOP=1 -f (Join-Path $projectRoot 'local-postgres\02-local-import-archives.sql')
    if ($LASTEXITCODE -ne 0) { throw 'Local import archives migration failed.' }
  } else {
    Write-Host ("Applying migration: " + $_.Name)
    & $psql -h localhost -p 5432 -U $AppUser -d $Database -v ON_ERROR_STOP=1 -f $_.FullName
    if ($LASTEXITCODE -ne 0) { throw ("Migration failed: " + $_.Name) }
  }
}

Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
Write-Host 'Local business schema created.'
