/* Close an assistant-owned Seller Center browser after one store's complete
 * sync pipeline has finished.  Individual jobs only disconnect from CDP so
 * Orders -> Bills -> Promotions can reuse one authenticated page. */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const scriptDirectory = __dirname;
const projectDirectory = path.resolve(scriptDirectory, '..');
const playwrightPath = path.join(projectDirectory, '.local-automation', 'node_modules', 'playwright-core');

function arg(name) { const index = process.argv.indexOf(name); return index < 0 ? null : process.argv[index + 1]; }
function portFor(key) { return 19228 + [...String(key || 'default')].reduce((sum, value) => sum + value.charCodeAt(0), 0) % 1000; }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function profilePathFor(config, key) {
  return key === 'default'
    ? path.join(config.rootDir, '浏览器配置', 'TikTokShop下载助手')
    : path.join(config.rootDir, '浏览器配置', `TikTokShop下载助手-${key}`);
}
function closeProfileChrome(profilePath) {
  // CDP close only disconnects a client in some Chromium versions.  Find the
  // top-level Chrome that was launched with this assistant-only profile and
  // terminate its process tree.  Ordinary Chrome uses a different profile
  // directory, so it is never selected.
  const cleanup = [
    '$profile = [Environment]::GetEnvironmentVariable("TIKTOK_SYNC_PROFILE")',
    '$pattern = "--user-data-dir=" + [regex]::Escape($profile) + "(?=\\s|$)"',
    '$targets = Get-CimInstance Win32_Process -Filter "Name = \'chrome.exe\'" | Where-Object { $line = ($_.CommandLine -replace [char]34, ""); $line -and $line -match $pattern -and $line -notmatch "--type=" }',
    'foreach ($target in $targets) { & taskkill.exe /PID ([string]$target.ProcessId) /T /F | Out-Null }'
  ].join('; ');
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cleanup], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, TIKTOK_SYNC_PROFILE: path.resolve(profilePath) }
  });
}

async function main() {
  const key = arg('--store') || 'default';
  const config = JSON.parse(fs.readFileSync(path.join(scriptDirectory, 'tiktok-automation.config.json'), 'utf8'));
  const profilePath = profilePathFor(config, key);
  const port = portFor(key);
  const version = await fetch(`http://127.0.0.1:${port}/json/version`).catch(() => null);
  if (version?.ok) {
    const { chromium } = require(playwrightPath);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    await browser.close().catch(() => {});
  }
  // This is the authoritative cleanup.  It also handles a stale Chrome whose
  // DevTools endpoint has already stopped responding.
  closeProfileChrome(profilePath);
}

main().catch(error => { console.error(error.message || error); process.exitCode = 1; });
