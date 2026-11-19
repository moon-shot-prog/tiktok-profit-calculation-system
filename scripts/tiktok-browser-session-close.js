/* Close an assistant-owned Seller Center browser after one store's complete
 * sync pipeline has finished.  Individual jobs only disconnect from CDP so
 * Orders -> Bills -> Promotions can reuse one authenticated page. */
const fs = require('fs');
const path = require('path');

const scriptDirectory = __dirname;
const projectDirectory = path.resolve(scriptDirectory, '..');
const playwrightPath = path.join(projectDirectory, '.local-automation', 'node_modules', 'playwright-core');

function arg(name) { const index = process.argv.indexOf(name); return index < 0 ? null : process.argv[index + 1]; }
function portFor(key) { return 19228 + [...String(key || 'default')].reduce((sum, value) => sum + value.charCodeAt(0), 0) % 1000; }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function main() {
  const key = arg('--store') || 'default';
  const port = portFor(key);
  const version = await fetch(`http://127.0.0.1:${port}/json/version`).catch(() => null);
  if (!version?.ok) return;
  const { chromium } = require(playwrightPath);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  // browser.close() only disconnects a CDP client; the channel close command
  // is intentionally used here because this is the final owner cleanup.
  await browser._channel.close({ reason: '同步任务已完成' });
  await Promise.race([browser._closedPromise, sleep(5000)]);
}

main().catch(error => { console.error(error.message || error); process.exitCode = 1; });
