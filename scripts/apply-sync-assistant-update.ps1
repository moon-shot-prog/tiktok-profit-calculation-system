$ErrorActionPreference = 'Stop'
$source = 'G:\codex\tiktok shop\scripts\TikTokSyncAssistant.updated.exe'
$destination = 'G:\codex\tiktok shop\scripts\TikTokSyncAssistant.exe'
$deadline = (Get-Date).AddMinutes(15)

while ((Get-Date) -lt $deadline) {
    try {
        Copy-Item -LiteralPath $source -Destination $destination -Force -ErrorAction Stop
        exit 0
    }
    catch {
        Start-Sleep -Seconds 2
    }
}

exit 1
