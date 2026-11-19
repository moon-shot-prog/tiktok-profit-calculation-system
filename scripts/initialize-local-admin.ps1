$ErrorActionPreference = 'Stop'
$login = Read-Host 'New local login email'
$securePassword = Read-Host -AsSecureString 'New local password (at least 10 characters)'
$plainPassword = [System.Net.NetworkCredential]::new('', $securePassword).Password
$env:LOCAL_ADMIN_LOGIN = $login
$env:LOCAL_ADMIN_PASSWORD = $plainPassword
try {
  & node (Join-Path $PSScriptRoot 'initialize-local-admin.js')
  if ($LASTEXITCODE -ne 0) { throw 'Local administrator initialization failed.' }
} finally {
  Remove-Item Env:LOCAL_ADMIN_LOGIN,Env:LOCAL_ADMIN_PASSWORD -ErrorAction SilentlyContinue
}
