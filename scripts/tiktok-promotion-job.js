/*
 * TikTok Shop 推广日报自动同步。
 * 从“广告营销 → 店铺广告”读取单日 GMV Max 汇总，生成本机日报，校验后
 * 写入系统并归档。Seller Center 未提供此页的导出按钮，因此归档的是从页面
 * 读取并经校验后的标准 CSV，内容与系统推广费导入格式一致。
 */
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { resolveSystemSession } = require('./system-auth-session');
const { outputPath } = require('./download-file-names');
const { dismissSellerPopups, settleSellerPopups } = require('./tiktok-popup-dismiss');

const scriptDirectory = __dirname;
const projectDirectory = path.resolve(scriptDirectory, '..');
const configPath = path.join(scriptDirectory, 'tiktok-automation.config.json');
const playwrightPath = path.join(projectDirectory, '.local-automation', 'node_modules', 'playwright-core');

function arg(name) { const index = process.argv.indexOf(name); return index < 0 ? null : process.argv[index + 1]; }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function readConfig() { return JSON.parse(fs.readFileSync(configPath, 'utf8')); }
function writeJson(filePath, value) { fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8'); }
function systemUrl(config) { return String(process.env.LOCAL_SYSTEM_URL || config.systemUrl || 'http://127.0.0.1:3000').replace(/\/$/, ''); }
function utcYesterday() { const day = new Date(); day.setUTCDate(day.getUTCDate() - 1); return day.toISOString().slice(0, 10); }
function utcDates(startDate, endDate) { const values = []; for (let value = new Date(`${startDate}T00:00:00Z`), end = new Date(`${endDate}T00:00:00Z`); value <= end; value.setUTCDate(value.getUTCDate() + 1)) values.push(value.toISOString().slice(0, 10)); return values; }
function readRunLog(rootDir) { const filePath = path.join(rootDir, '待处理', '推广自动任务记录.json'); try { return { filePath, data: JSON.parse(fs.readFileSync(filePath, 'utf8')) }; } catch (_) { return { filePath, data: { runs: [] } }; } }
async function resolveShop(config, mapping) {
  const session = await resolveSystemSession(config);
  const response = await fetch(`${systemUrl(config)}/api/admin/order-import-configuration`, { headers: { Authorization: `Bearer ${session.accessToken}` } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || '无法读取系统店铺配置');
  const matches = mapping.systemShopId ? (data.shops || []).filter(shop => shop.id === mapping.systemShopId) : (data.shops || []).filter(shop => (mapping.systemShopCode && (shop.shop_code || shop.code) === mapping.systemShopCode) || (mapping.systemShopName && (shop.shop_name || shop.name) === mapping.systemShopName));
  if (matches.length !== 1) throw new Error('系统店铺映射无法唯一识别，未执行推广费导入');
  return { session, shop: matches[0] };
}
function findChrome() {
  const candidates = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'];
  const chrome = candidates.find(candidate => fs.existsSync(candidate));
  if (!chrome) throw new Error('未找到 Google Chrome');
  return chrome;
}
// Keep this identical to Orders/Bills/Login.  A different port used to make
// promotion start a second browser for the same store profile.
function portFor(key) { return 19228 + [...String(key || 'default')].reduce((sum, value) => sum + value.charCodeAt(0), 0) % 1000; }
async function openBrowser(chromium, profilePath, profileKey) {
  const port = portFor(profileKey);
  try {
    if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) {
      return { browser: await chromium.connectOverCDP(`http://127.0.0.1:${port}`), chromeProcess: null, reused: true };
    }
  } catch (_) { /* No reusable session is listening yet. */ }
  const chromeProcess = spawn(findChrome(), [`--user-data-dir=${profilePath}`, `--remote-debugging-port=${port}`, '--remote-allow-origins=*', '--no-first-run', '--disable-popup-blocking', 'about:blank'], { windowsHide: false });
  for (let retry = 0; retry < 30; retry += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return { browser: await chromium.connectOverCDP(`http://127.0.0.1:${port}`), chromeProcess, reused: false }; } catch (_) { /* starting */ }
    await sleep(1000);
  }
  try { chromeProcess.kill(); } catch (_) { /* no-op */ }
  throw new Error('Chrome 专用浏览器启动超时');
}
function promotionUrl(config, mapping) {
  return `${String(config.sellerCenterUrl).replace(/\/$/, '')}/compass/promotion-analytics?shop_region=${encodeURIComponent(mapping.countryCode)}`;
}
function adsUrl(config, mapping) {
  return `${String(config.sellerCenterUrl).replace(/\/$/, '')}/ads-creation?origin=SC_ads_tab_button_PC&shop_region=${encodeURIComponent(mapping.countryCode)}`;
}
function verifySellerLogin(mapping, text) {
  const visible = String(text || '').replace(/\s+/g, ' ').toLowerCase();
  if (/\b(log\s*in|sign\s*in)\b|登录|扫码登录/.test(visible)) throw new Error('TikTok Shop 专用浏览器登录已失效，请重新登录。');
  if (!visible.includes(String(mapping.sellerCenterName || '').replace(/\s+/g, ' ').toLowerCase())) throw new Error(`当前 TikTok Shop 登录店铺与映射不一致（期望：${mapping.sellerCenterName}）。`);
}
async function verifySellerSession(page, config, mapping) {
  // 广告页偶尔不会渲染店铺名称，即使当前隔离浏览器已经登录到正确店铺。
  // 先校验广告页；若仅缺少名称，则回到商家中心首页核对身份后再返回广告页。
  const verifyCurrentPage = async () => verifySellerLogin(mapping, await page.locator('body').innerText());
  try {
    await verifyCurrentPage();
    return;
  } catch (error) {
    if (!String(error.message || '').includes('登录店铺与映射不一致')) throw error;
  }
  const home = `${String(config.sellerCenterUrl).replace(/\/$/, '')}/homepage?shop_region=${encodeURIComponent(mapping.countryCode)}`;
  await page.goto(home, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);
  await settleSellerPopups(page, 2500);
  await verifyCurrentPage();
  await page.goto(adsUrl(config, mapping), { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(7000);
  await settleSellerPopups(page, 2500);
}
async function inspectPage(page) {
  const text = await page.locator('body').innerText();
  const inputs = await page.locator('input:visible').evaluateAll(items => items.map(item => ({ value: item.value, type: item.type, readOnly: item.readOnly, disabled: item.disabled, outerHTML: item.outerHTML })));
  const controls = await page.locator('button, [role="button"], input, select, a').evaluateAll(items => items.map(item => ({ tag: item.tagName.toLowerCase(), text: (item.innerText || item.value || '').trim(), ariaLabel: item.getAttribute('aria-label') || '', title: item.getAttribute('title') || '', href: item.href || '' })).filter(item => item.text || item.ariaLabel || item.title).slice(0, 300));
  console.log(JSON.stringify({ url: page.url(), text: text.slice(0, 16000), inputs, controls }, null, 2));
}
async function openPromotionMenu(page, config) {
  await page.goto(config.sellerCenterUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  await settleSellerPopups(page, 2500);
  const menu = page.getByText('广告营销', { exact: true });
  for (let index = 0; index < await menu.count(); index += 1) {
    const item = menu.nth(index);
    if (!await item.isVisible().catch(() => false)) continue;
    await item.hover({ force: true }).catch(() => {});
    await item.click({ force: true });
    await page.waitForTimeout(1500);
    return;
  }
  throw new Error('未找到“广告营销”菜单');
}
async function setDateRange(page, startDate, endDate = startDate) {
  // The dashboard persists this exact UTC range in its URL.  Its visual
  // dual-month picker applies the account timezone and can click an adjacent
  // month for dates near a boundary; navigate by the supported timestamps
  // instead, then verify the rendered start/end inputs below.
  const url = new URL(page.url());
  url.searchParams.set('list_start_date', String(Date.parse(`${startDate}T00:00:00.000Z`)));
  url.searchParams.set('list_end_date', String(Date.parse(`${endDate}T00:00:00.000Z`)));
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);
}
async function selectPromotionCalendarDate(page, input, date) {
  await input.click({ force: true });
  await page.waitForTimeout(250);
  const [year, month, day] = date.split('-').map(Number);
  const labels = [`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`, `${year}/${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}`, `${year}年${month}月${day}日`];
  const cells = page.locator('.theme-arco-picker-date-value:visible');
  for (let index = 0; index < await cells.count(); index += 1) {
    const cell = cells.nth(index);
    if ((await cell.innerText().catch(() => '')).trim() !== String(day)) continue;
    const matchesTarget = await cell.evaluate((node, wanted) => {
      for (let current = node; current && current !== document.body; current = current.parentElement) {
        const attributes = [current.getAttribute('aria-label'), current.getAttribute('title'), current.getAttribute('data-date'), current.getAttribute('data-value'), current.getAttribute('datetime')].filter(Boolean);
        if (attributes.some(value => wanted.includes(String(value)))) return true;
      }
      return false;
    }, labels).catch(() => false);
    if (matchesTarget) { await cell.click({ force: true }); return; }
  }
  // Fallback for Seller Center variants without date attributes: discard the
  // leading/trailing dates rendered from adjacent months, then use the panel
  // whose title matches the requested month.
  const expectedMonth = `${year}-${String(month).padStart(2, '0')}`;
  for (let index = 0; index < await cells.count(); index += 1) {
    const cell = cells.nth(index);
    if ((await cell.innerText().catch(() => '')).trim() !== String(day)) continue;
    const valid = await cell.evaluate((node, expected) => {
      for (let parent = node.parentElement, depth = 0; parent && depth < 10; parent = parent.parentElement, depth += 1) {
        const marker = `${parent.className || ''} ${parent.getAttribute?.('aria-disabled') || ''}`.toLowerCase();
        if (/(outside|disabled|adjacent|prev|next|not-in-view)/.test(marker)) return false;
        const titles = [...parent.querySelectorAll('*')].map(item => (item.textContent || '').trim());
        if (titles.includes(expected)) return true;
      }
      return false;
    }, expectedMonth).catch(() => false);
    if (valid) { await cell.click({ force: true }); return; }
  }
  throw new Error(`推广页面日期选择器未找到 ${date}`);
}
async function selectedPromotionDates(page) {
  const start = page.locator('input[placeholder="开始日期"]:visible').first();
  const end = page.locator('input[placeholder="结束日期"]:visible').first();
  return [await start.inputValue().catch(() => ''), await end.inputValue().catch(() => '')];
}
async function selectYesterday(page) {
  const dateInput = page.locator('input:visible').first();
  await dateInput.click();
  const button = page.getByRole('button', { name: '昨天', exact: true }).last();
  await button.click();
  await page.waitForTimeout(5000);
}
async function selectExactDate(page, date) {
  const dateInput = page.locator('input:visible').first();
  await dateInput.click();
  const day = String(Number(date.slice(-2)));
  const clickDay = async () => page.locator('.theme-arco-picker-date-value').evaluateAll((cells, value) => {
    const cell = cells.find(item => item.textContent.trim() === value && item.offsetParent !== null);
    if (!cell) return false;
    cell.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return true;
  }, day);
  if (!await clickDay()) throw new Error(`推广页面日期选择器未找到 ${date}，未执行写入`);
  // Seller Center's range calendar selects start and end with two clicks. The
  // first click re-renders the panel, so resolve the visible day again.
  if (!await clickDay()) throw new Error(`推广页面日期选择器未能完成 ${date} 的结束日期选择，未执行写入`);
  await page.waitForTimeout(5000);
}
function numberValue(value, label) { const number = Number(String(value || '').replace(/,/g, '')); if (!Number.isFinite(number) || number < 0) throw new Error(`推广页面的${label}不是有效数字`); return number; }
function pageMetrics(pageText) {
  const text = String(pageText || '');
  const dashboard = text.slice(Math.max(0, text.indexOf('概览')), text.indexOf('广告计划列表') > 0 ? text.indexOf('广告计划列表') : undefined);
  // 当前日期会展示“较昨日”，历史单日则不展示对比文案；两种格式均只取概览区首项。
  const cost = dashboard.match(/成本\s*\n\s*([\d,.]+)\s*([A-Z]{3})(?:\s*\n\s*较[^\n]+)?/);
  const orders = dashboard.match(/SKU 订单数\s*\n\s*([\d,]+)(?:\s*\n\s*较[^\n]+)?/);
  const average = dashboard.match(/平均下单成本\s*\n\s*([\d,.]+)\s*([A-Z]{3})(?:\s*\n\s*较[^\n]+)?/);
  const revenue = dashboard.match(/总收入\s*\n\s*([\d,.]+)\s*([A-Z]{3})(?:\s*\n\s*较[^\n]+)?/);
  const roi = dashboard.match(/ROI\s*\n\s*([\d,.]+)(?:\s*\n\s*较[^\n]+)?/);
  if (!cost || !orders || !average || !revenue || !roi) throw new Error('推广页面缺少成本、SKU 订单数、平均下单成本、总收入或 ROI，未执行写入');
  if (cost[2] !== revenue[2] || cost[2] !== average[2]) throw new Error('推广页面的成本、收入与平均下单成本币种不一致，未执行写入');
  return { costAmount: numberValue(cost[1], '成本'), orderCount: numberValue(orders[1], 'SKU 订单数'), averageCost: numberValue(average[1], '平均下单成本'), revenueAmount: numberValue(revenue[1], '总收入'), roi: numberValue(roi[1], 'ROI'), currencyCode: cost[2] };
}
function promotionRow(date, metrics) { return { '按天': date, '成本': metrics.costAmount.toFixed(2), 'SKU 订单数（当前店铺）': String(Math.round(metrics.orderCount)), '平均下单成本（当前店铺）': metrics.averageCost.toFixed(2), '总收入（当前店铺）': metrics.revenueAmount.toFixed(2), '投资回报率 (ROI)（当前店铺）': metrics.roi.toFixed(2), '币种': metrics.currencyCode }; }
function csvCell(value) { const text = String(value ?? ''); return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text; }
function promotionCsvPath(mapping, contentDate) { return outputPath('推广日报', mapping, '.csv', contentDate); }
function writePromotionCsv(filePath, rows) { const headers = Object.keys(rows[0] || {}); if (!headers.length) throw new Error('推广范围内没有可写入的数据'); fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.writeFileSync(filePath, `\uFEFF${headers.map(csvCell).join(',')}\r\n${rows.map(row => headers.map(header => csvCell(row[header])).join(',')).join('\r\n')}\r\n`, 'utf8'); }
async function submitPromotion(config, session, shop, filePath, rows, mode) {
  const response = await fetch(`${systemUrl(config)}/api/admin/promotions/import`, { method: 'POST', headers: { Authorization: `Bearer ${session.accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ mode, shopId: shop.id, fileName: path.basename(filePath), rows }) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || '推广费导入接口请求失败');
  if (!data.valid) throw new Error(data.message || '推广费数据校验未通过');
  return data;
}
async function main() {
  const config = readConfig();
  const key = arg('--store') || 'default';
  const rangeStart = arg('--start-date');
  const rangeEnd = arg('--end-date');
  const targetDate = rangeStart || arg('--date') || utcYesterday();
  const endDate = rangeEnd || targetDate;
  const dryRun = process.argv.includes('--dry-run');
  const force = process.argv.includes('--force');
  const mapping = (config.shopMappings || []).find(item => (item.profileKey || 'default') === key);
  if (!mapping) throw new Error('未找到指定店铺的本机自动化配置');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate) || endDate < targetDate) throw new Error('日期范围格式必须为 YYYY-MM-DD，且开始日期不能晚于结束日期');
  const { filePath: logPath, data: runLog } = readRunLog(config.rootDir);
  const runKey = `${targetDate}~${endDate}|${key}`;
  if (!dryRun && !force && runLog.runs?.some(run => run.key === runKey && run.status === 'imported')) { console.log(`已完成过 ${targetDate} 至 ${endDate} 的推广费导入，跳过重复任务。`); return; }
  const record = { key: runKey, date: targetDate, endDate, store: mapping.sellerCenterName, status: 'running', startedAt: new Date().toISOString() };
  const profilePath = key === 'default' ? path.join(config.rootDir, '浏览器配置', 'TikTokShop下载助手') : path.join(config.rootDir, '浏览器配置', `TikTokShop下载助手-${key}`);
  const { chromium } = require(playwrightPath);
  const native = await openBrowser(chromium, profilePath, key);
  try {
    const context = native.browser.contexts()[0];
    const page = context.pages()[0] || await context.newPage();
    await page.bringToFront().catch(() => {});
    page.setDefaultTimeout(30000); page.setDefaultNavigationTimeout(60000);
    if (process.argv.includes('--inspect-menu')) await openPromotionMenu(page, config);
    else if (process.argv.includes('--inspect-ads') || process.argv.includes('--inspect-date') || process.argv.includes('--inspect-date-picker') || process.argv.includes('--inspect-yesterday') || process.argv.includes('--inspect-exact-date')) {
      await page.goto(adsUrl(config, mapping), { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(7000);
      await settleSellerPopups(page, 2500);
      if (process.argv.includes('--inspect-date')) await setDateRange(page, arg('--date') || new Date(Date.now() - 86400000).toISOString().slice(0, 10));
      if (process.argv.includes('--inspect-date-picker')) {
        const input = page.locator('input:visible').first();
        await input.click(); await page.waitForTimeout(500);
      }
      if (process.argv.includes('--inspect-yesterday')) await selectYesterday(page);
      if (process.argv.includes('--inspect-exact-date')) await selectExactDate(page, arg('--date'));
    }
    else {
      await page.goto(adsUrl(config, mapping), { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(7000);
      await settleSellerPopups(page, 2500);
    }
    await verifySellerSession(page, config, mapping);
    if (process.argv.includes('--inspect-page') || process.argv.includes('--inspect-menu') || process.argv.includes('--inspect-ads') || process.argv.includes('--inspect-date') || process.argv.includes('--inspect-date-picker') || process.argv.includes('--inspect-yesterday') || process.argv.includes('--inspect-exact-date')) await inspectPage(page);
    else {
      const { session, shop } = await resolveShop(config, mapping);
      const rows = [];
      for (const date of utcDates(targetDate, endDate)) {
        // The dashboard only exposes an aggregate for the currently selected
        // period.  Read each UTC day, but write one range CSV and one import
        // batch so daily profit reporting remains mathematically correct.
        await setDateRange(page, date, date);
        const selectedDates = await selectedPromotionDates(page);
        if (selectedDates.length !== 2 || selectedDates[0] !== date || selectedDates[1] !== date) throw new Error(`推广页面日期筛选与 UTC 任务日期不一致（页面：${selectedDates.join(' 至 ')}；任务：${date}），未执行写入`);
        rows.push(promotionRow(date, pageMetrics(await page.locator('body').innerText())));
      }
      const contentDate = targetDate === endDate ? targetDate : `${targetDate}至${endDate}`;
      const filePath = promotionCsvPath(mapping, contentDate);
      record.fileName = path.basename(filePath); record.metrics = { days: rows.length };
      const preview = await submitPromotion(config, session, shop, filePath, rows, 'preview');
      record.preview = { insertCount: preview.insertCount, updateCount: preview.updateCount };
      if (dryRun) { record.status = 'previewed'; return; }
      writePromotionCsv(filePath, rows);
      const committed = await submitPromotion(config, session, shop, filePath, rows, 'commit');
      record.status = 'imported'; record.batchCode = committed.batchCode;
      record.archivePath = filePath;
    }
  } catch (error) {
    record.status = 'failed'; record.error = error.message || String(error); console.error(record.error); process.exitCode = 1;
  } finally {
    record.completedAt = new Date().toISOString(); runLog.runs = [record, ...(runLog.runs || [])].slice(0, 90); writeJson(logPath, runLog);
    // Detach only; this Chrome session belongs to the store-level runner.
    try { native.browser._connection?.close(); } catch (_) { /* no-op */ }
    if (!native.reused) try { native.chromeProcess.kill(); } catch (_) { /* no-op */ }
  }
}
main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
