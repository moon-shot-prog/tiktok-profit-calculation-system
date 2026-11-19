/* Read-only selector test for the TikTok Shop unsettled-bill export page. */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const scriptDirectory = __dirname;
const projectDirectory = path.resolve(scriptDirectory, '..');
const config = JSON.parse(fs.readFileSync(path.join(scriptDirectory, 'tiktok-automation.config.json'), 'utf8'));
const playwrightPath = path.join(projectDirectory, '.local-automation', 'node_modules', 'playwright-core');

function findChrome() {
  const paths = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'];
  const chrome = paths.find(file => fs.existsSync(file));
  if (!chrome) throw new Error('未找到 Google Chrome');
  return chrome;
}
function portFor(key) { return 19228 + [...String(key || 'default')].reduce((total, char) => total + char.charCodeAt(0), 0) % 1000; }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function openProfile(chromium, profile, key) {
  const port = portFor(key);
  const process = spawn(findChrome(), [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--remote-allow-origins=*', '--no-first-run', 'about:blank'], { windowsHide: false });
  for (let retry = 0; retry < 30; retry += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return { browser: await chromium.connectOverCDP(`http://127.0.0.1:${port}`), process }; }
    catch (_) { /* Chrome is starting. */ }
    await sleep(1000);
  }
  try { process.kill(); } catch (_) { /* no-op */ }
  throw new Error('专用浏览器启动超时');
}
async function clickExact(page, text) {
  const locator = page.getByText(text, { exact: true });
  for (let index = 0; index < await locator.count(); index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false)) { await candidate.click({ force: true }); return; }
  }
  throw new Error(`未找到“${text}”入口`);
}
async function clickIfVisible(page, text) {
  const locator = page.getByText(text, { exact: true });
  for (let index = 0; index < await locator.count(); index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false)) { await candidate.click({ force: true }); return true; }
  }
  return false;
}
async function waitForText(page, text) {
  for (let retry = 0; retry < 25; retry += 1) {
    if ((await page.locator('body').innerText()).includes(text)) return;
    await sleep(1000);
  }
  throw new Error(`页面未加载“${text}”`);
}

(async () => {
  const profileKey = process.argv.includes('--store') ? process.argv[process.argv.indexOf('--store') + 1] : 'default';
  const shop = config.shopMappings.find(item => (item.profileKey || 'default') === profileKey);
  if (!shop) throw new Error('未找到指定店铺配置');
  const profile = profileKey === 'default' ? path.join(config.rootDir, '浏览器配置', 'TikTokShop下载助手') : path.join(config.rootDir, '浏览器配置', `TikTokShop下载助手-${profileKey}`);
  const { chromium } = require(playwrightPath);
  const native = await openProfile(chromium, profile, profileKey);
  const page = native.browser.contexts()[0].pages()[0] || await native.browser.contexts()[0].newPage();
  try {
    await page.goto(config.sellerCenterUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitForText(page, shop.sellerCenterName);
    // The seller centre sidebar can render Finance either expanded or collapsed.
    if (!await clickIfVisible(page, '财务概览')) {
      if (!await clickIfVisible(page, '财务')) {
        const visibleText = (await page.locator('body').innerText()).slice(0, 5000);
        throw new Error(`未识别财务菜单。当前页面文本：${visibleText}`);
      }
      await sleep(800);
      await clickExact(page, '财务概览');
    }
    await waitForText(page, '未结算');
    await clickExact(page, '未结算');
    await waitForText(page, '导出历史记录');
    await clickExact(page, '导出历史记录');
    await waitForText(page, '已导出报告');
    const text = await page.locator('body').innerText();
    const historyAt = text.indexOf('已导出报告');
    const history = text.slice(historyAt, historyAt + 1800);
    const target = page.getByText(/Onhold-unsettled-orders-2026[\\/_]10[\\/_]14-2026[\\/_]10[\\/_]14/, { exact: false }).first();
    const structure = await target.evaluate(node => {
      const nodes = []; let current = node;
      for (let depth = 0; current && depth < 6; depth += 1, current = current.parentElement) nodes.push({ tag: current.tagName, className: current.className, text: current.innerText?.slice(0, 500), html: current.outerHTML?.slice(0, 1600) });
      return nodes;
    }).catch(() => []);
    console.log(JSON.stringify({ ok: true, store: shop.sellerCenterName, page: '未结算账单', exportHistory: history, targetStructure: structure }, null, 2));
  } finally {
    try { await native.browser.close(); } catch (_) { /* no-op */ }
    try { native.process.kill(); } catch (_) { /* no-op */ }
  }
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
