/*
 * 每日订单自动下载与导入（仅本机运行）。
 * 依赖专用 Chrome 配置中已登录的 TikTok Shop 与系统管理员会话。
 * 安全规则：只导入纯新增订单；有更新、重复、登录失效或校验异常时停止。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
const ExcelJS = require('exceljs');
const { resolveSystemSession } = require('./system-auth-session');
const { stagingDirectory, finalizeDownloadedFile } = require('./download-file-names');
const { dismissSellerPopups, settleSellerPopups } = require('./tiktok-popup-dismiss');

const scriptDirectory = __dirname;
const projectDirectory = path.resolve(scriptDirectory, '..');
const configPath = path.join(scriptDirectory, 'tiktok-automation.config.json');
const playwrightPath = path.join(projectDirectory, '.local-automation', 'node_modules', 'playwright-core');
// 默认直连本机服务；可由环境变量或本机自动化配置改为固定内网 IP / 内部域名。
const configuredSystemUrl = (() => {
  try { return JSON.parse(fs.readFileSync(configPath, 'utf8')).systemUrl; } catch (_) { return null; }
})();
const systemUrl = String(process.env.LOCAL_SYSTEM_URL || configuredSystemUrl || 'http://127.0.0.1:3000').replace(/\/$/, '');
// Historical exports are queued by TikTok. A 31-day report can legitimately
// take longer than five minutes, so retain the task until the report is ready.
const ORDER_EXPORT_WAIT_SECONDS = 900;

function readConfig() {
  if (!fs.existsSync(configPath)) throw new Error('未找到本机自动化配置，请先完成店铺映射');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!config.rootDir || !Array.isArray(config.shopMappings) || !config.shopMappings.length) throw new Error('自动化配置不完整');
  return config;
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function findChrome() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
  ];
  const chrome = candidates.find(candidate => fs.existsSync(candidate));
  if (!chrome) throw new Error('未找到 Google Chrome，无法运行本机自动任务');
  return chrome;
}

function yesterdayInUtc() {
  const calendarDay = new Date();
  calendarDay.setUTCHours(0, 0, 0, 0);
  calendarDay.setUTCDate(calendarDay.getUTCDate() - 1);
  return calendarDay.toISOString().slice(0, 10);
}

function utcDaysAgo(daysAgo) {
  const calendarDay = new Date();
  calendarDay.setUTCHours(0, 0, 0, 0);
  calendarDay.setUTCDate(calendarDay.getUTCDate() - daysAgo);
  return calendarDay.toISOString().slice(0, 10);
}

function utcRange(startDate, endDate = startDate) {
  // Range tasks are defined by UTC calendar dates.  Do not use Thailand's
  // timezone here: doing so leaks the following local day for MY/PH stores.
  const start = new Date(`${startDate}T00:00:00.000Z`).getTime();
  const end = new Date(`${endDate}T23:59:59.999Z`).getTime();
  return { start, end };
}

function parseCsvRows(text) {
  const records = []; let row = [], cell = '', quoted = false;
  const pushCell = () => { row.push(cell); cell = ''; };
  const pushRow = () => { if (row.some(value => String(value).trim())) records.push(row.map(value => String(value).replace(/^\uFEFF/, '').trim())); row = []; };
  for (let index = 0; index < String(text).length; index += 1) {
    const char = text[index], next = text[index + 1];
    if (char === '"' && quoted && next === '"') { cell += '"'; index += 1; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (char === ',' && !quoted) { pushCell(); continue; }
    if ((char === '\n' || char === '\r') && !quoted) { if (char === '\r' && next === '\n') index += 1; pushCell(); pushRow(); continue; }
    cell += char;
  }
  pushCell(); pushRow();
  if (records.length < 2) throw new Error('下载文件没有可导入的数据行');
  const headers = records[0];
  return records.slice(1).map(values => Object.fromEntries(headers.map((header, index) => [header, values[index] || ''])));
}

function storefrontUtcOffset(countryCode) {
  return ['MY', 'PH'].includes(String(countryCode || '').toUpperCase()) ? '+08:00' : '+07:00';
}

function normalizedOrderDate(value, countryCode) {
  const text = String(value || '').trim();
  const time = (text.match(/(?:\s|T)(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/i) || []);
  let hour = Number(time[1] || 0);
  const minute = Number(time[2] || 0);
  const second = Number(time[3] || 0);
  if (time[4]) {
    const period = time[4].toUpperCase();
    if (period === 'PM' && hour < 12) hour += 12;
    if (period === 'AM' && hour === 12) hour = 0;
  }
  let year; let month; let day;
  let match = text.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (match) {
    [, year, month, day] = match;
  } else {
    match = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
    if (!match) return null;
    const [, first, secondValue, parsedYear] = match;
    year = parsedYear;
    // Only PH uses MM/DD/YYYY. MY, TH and VN exports use DD/MM/YYYY.
    if (String(countryCode || '').toUpperCase() === 'PH') {
      month = first; day = secondValue;
    } else {
      day = first; month = secondValue;
    }
  }
  const timestamp = new Date(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}${storefrontUtcOffset(countryCode)}`);
  if (Number.isNaN(timestamp.getTime())) return null;
  return timestamp.toISOString().slice(0, 10);
}

function verifyExportDate(rows, startDate, endDate = startDate, countryCode) {
  const dates = [...new Set(rows
    .map(row => normalizedOrderDate(row['Created Time'] || row['Order Created Time'] || row['下单时间'], countryCode))
    .filter(Boolean))];
  if (!dates.length) throw new Error('下载文件缺少可识别的下单日期，未执行导入');
  if (dates.some(date => date < startDate || date > endDate)) {
    throw new Error(`下载文件下单日期超出任务范围（文件：${dates.join('、')}；任务：${startDate} 至 ${endDate}），未执行导入`);
  }
}

function uniqueExportOrderCount(rows) {
  const identifiers = new Set(rows.map(row => String(
    row['Order ID'] || row['Order ID/Adjustment ID'] || row['订单 ID'] || row['订单ID'] || row.order_id || row.order_number || ''
  ).trim()).filter(Boolean));
  if (!identifiers.size) throw new Error('下载文件缺少可识别的订单 ID，未执行导入');
  return identifiers.size;
}

function verifyExportOrderCount(rows, expectedOrderCount) {
  const exportedOrderCount = uniqueExportOrderCount(rows);
  if (exportedOrderCount !== Number(expectedOrderCount)) {
    throw new Error(`下载文件订单数与筛选结果不一致（页面：${expectedOrderCount} 单；文件：${exportedOrderCount} 个唯一订单 ID；CSV：${rows.length} 行），未执行导入，请重新导出。`);
  }
  return exportedOrderCount;
}
async function chooseFilteredOrderExportScope(page, expectedOrderCount) {
  // TikTok localizes this line and sometimes formats the count as 20,349 or
  // renders the number in its own span.  The old exact Chinese sentence made
  // a valid export fail before downloading.  Match the visible option by its
  // semantic text and normalized count, then click its selectable ancestor.
  const candidates = page.getByText(/筛选.*订单|filtered.*orders/i, { exact: false });
  for (let index = 0; index < await candidates.count(); index += 1) {
    const candidate = candidates.nth(index);
    if (!await candidate.isVisible().catch(() => false)) continue;
    const text = (await candidate.innerText().catch(() => '')).trim();
    if (!text || text.length > 180) continue;
    const counts = (text.match(/\d[\d,\s]*/g) || []).map(value => Number(value.replace(/[,\s]/g, ''))).filter(Number.isFinite);
    if (!counts.includes(Number(expectedOrderCount))) continue;
    const target = candidate.locator('xpath=ancestor-or-self::*[self::label or @role="radio" or @role="button" or self::button][1]');
    if (await target.count() && await target.first().isVisible().catch(() => false)) await target.first().click({ force: true });
    else await candidate.click({ force: true });
    return;
  }
  throw new Error(`导出窗口未找到与页面筛选结果一致的订单范围（页面：${expectedOrderCount} 单）。已停止下载，避免导入不完整文件。`);
}
async function chooseCsvExportFormat(page) {
  // The export dialog re-renders once the scope option is selected. Trigger
  // the currently mounted option in the document instead of retaining a
  // Playwright locator which may point at the just-destroyed option node.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const clicked = await page.evaluate(() => {
      const visible = node => !!(node && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden');
      const option = [...document.querySelectorAll('div, span, label, button')]
        .find(node => visible(node) && (node.textContent || '').trim() === 'CSV');
      if (!option) return false;
      const target = option.closest('[role="radio"], label, button, .p-oft') || option;
      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      target.click();
      return true;
    }).catch(() => false);
    if (clicked) return;
    await sleep(350 * (attempt + 1));
  }
  throw new Error('导出窗口中的 CSV 格式选项持续重载，未创建下载任务。');
}
async function confirmOrderExport(page) {
  // Re-query on every attempt.  TikTok destroys and recreates this button as
  // the range/format choice changes, so retaining any old Locator can wait on
  // a detached node for the default 30 seconds.
  const selectors = [
    'button[data-log_click_for="export"]:visible:not([disabled])',
    'button.p-btn-primary:visible:not([disabled])'
  ];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const domClicked = await page.evaluate(() => {
      const visible = node => !!(node && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden' && !node.disabled);
      const button = [...document.querySelectorAll('button[data-log_click_for="export"], button.p-btn-primary')]
        .filter(node => visible(node) && (node.textContent || '').trim() === '导出')
        .pop();
      if (!button) return false;
      button.click();
      return true;
    }).catch(() => false);
    if (domClicked) return;
    for (const selector of selectors) {
      const buttons = page.locator(selector).filter({ hasText: /^导出$/ });
      const count = await buttons.count().catch(() => 0);
      for (let index = count - 1; index >= 0; index -= 1) {
        try {
          await buttons.nth(index).click({ force: true, timeout: 5000 });
          return;
        } catch (_) { /* the dialog can redraw; obtain a new locator */ }
      }
    }
    await sleep(350 * (attempt + 1));
  }
  throw new Error('未找到稳定的订单导出确认按钮，未创建下载任务。');
}

function readRunLog(rootDir) {
  const filePath = path.join(rootDir, '待处理', '自动任务记录.json');
  try { return { filePath, data: JSON.parse(fs.readFileSync(filePath, 'utf8')) }; } catch (_) { return { filePath, data: { runs: [] } }; }
}

function writeRunLog(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}


function debugPortFor(profileKey) {
  return 19228 + [...String(profileKey || 'default')].reduce((total, char) => total + char.charCodeAt(0), 0) % 1000;
}

async function connectNativeChrome(chromium, profilePath, profileKey) {
  const port = debugPortFor(profileKey);
  // The runner opens one browser per store.  All following modules attach to
  // this endpoint so the Seller Center does not have to start and log in again.
  try {
    if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) {
      return { browser: await chromium.connectOverCDP(`http://127.0.0.1:${port}`), chromeProcess: null, reused: true };
    }
  } catch (_) { /* No reusable session is listening yet. */ }
  const chromeProcess = spawn(findChrome(), [
    `--user-data-dir=${profilePath}`,
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--disable-popup-blocking',
    'about:blank'
  ], { windowsHide: true, detached: true, stdio: 'ignore' });
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return { browser: await chromium.connectOverCDP(`http://127.0.0.1:${port}`), chromeProcess, reused: false };
    } catch (_) { /* Chrome is still starting. */ }
    await sleep(1000);
  }
  try { chromeProcess.kill(); } catch (_) { /* no-op */ }
  throw new Error('Chrome 原生下载浏览器启动超时');
}

async function gotoWithRetry(page, url, label) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await page.bringToFront().catch(() => {});
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(800);
      await settleSellerPopups(page, 2500);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(4000 * attempt);
    }
  }
  throw new Error(`${label}页面打开失败（已重试 3 次）：${lastError?.message || '网络或平台响应超时'}`);
}

function normalizedText(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function verifySellerLogin(mapping, pageText) {
  const visible = normalizedText(pageText);
  const expected = normalizedText(mapping.sellerCenterName);
  if (/\b(log\s*in|sign\s*in)\b|登录|扫码登录/.test(visible)) {
    throw new Error('TikTok Shop 专用浏览器登录已失效，请在同步助手中选择该店铺后点击“打开登录”重新登录。');
  }
  if (!expected || !visible.includes(expected)) {
    throw new Error(`当前 TikTok Shop 登录店铺与自动化映射不一致（期望：${mapping.sellerCenterName}）。请使用该店铺的专用浏览器配置重新登录。`);
  }
}

function parseOrderCount(pageText) {
  const text = String(pageText || '');
  const patterns = [
    /找到\s*([\d,]+)\s*个订单/,
    /([\d,]+)\s*笔订单/,
    /([\d,]+)\s*orders?\s*(?:found|total)?/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return Number(String(match[1]).replace(/,/g, ''));
  }
  return null;
}

async function waitForOrderCount(page) {
  // Seller Center finishes rendering the list asynchronously.  A transient
  // count from the preceding page must never be used as the export scope.
  let lastCount = null;
  let consecutiveCount = 0;
  for (let attempt = 1; attempt <= 40; attempt += 1) {
    const count = parseOrderCount(await page.locator('body').innerText());
    if (Number.isFinite(count)) {
      consecutiveCount = count === lastCount ? consecutiveCount + 1 : 1;
      lastCount = count;
      // Require the same rendered value for 8 seconds. This covers delayed
      // order-list refreshes after the date URL has changed.
      if (consecutiveCount >= 8) return count;
    }
    await sleep(1000);
  }
  throw new Error('订单列表未在 40 秒内稳定显示订单数量，已停止下载。请检查页面筛选条件或网络后重试。');
}

function exportTimeMarker() {
  // Seller Center's export-history filename uses the computer/reporting
  // timezone (UTC+8 here), while order filtering itself uses the shop timezone.
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
  const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const dateParts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const date = Object.fromEntries(dateParts.map(part => [part.type, part.value]));
  return `${date.year}-${date.month}-${date.day}-${fields.hour}:${fields.minute}`;
}

async function waitForThisExportDownload(page, marker = exportTimeMarker()) {
  const reportName = page.getByText(new RegExp(`订单\\s*-${marker.replace(':', '[:：]')}`, 'i'));
  for (let attempt = 1; attempt <= ORDER_EXPORT_WAIT_SECONDS; attempt += 1) {
    if (await reportName.count()) {
      // The nearest history row contains exactly one action: while generating it
      // shows a spinner; when ready it exposes the Download button.
      const row = reportName.first().locator('xpath=ancestor::*[.//button][1]');
      const download = row.getByRole('button', { name: '下载', exact: true });
      if (await download.count()) return { download: download.first(), marker };
    }
    await sleep(1000);
  }
  throw new Error(`本次导出任务（${marker}）未在 ${ORDER_EXPORT_WAIT_SECONDS} 秒内生成可下载文件，未使用任何历史文件。TikTok 可能仍在生成报表，请稍后重新发起范围同步。`);
}

async function clickThisExportDownload(page, marker) {
  const pattern = new RegExp(`订单\\s*-${String(marker).replace(':', '[:：]')}`, 'i');
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const reports = page.getByText(pattern);
    const count = await reports.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const report = reports.nth(index);
      if (!await report.isVisible().catch(() => false)) continue;
      const row = report.locator('xpath=ancestor::*[.//button][1]');
      const button = row.getByRole('button', { name: '下载', exact: true }).first();
      if (!await button.isVisible().catch(() => false)) continue;
      try {
        await button.scrollIntoViewIfNeeded();
        await button.click({ force: true, timeout: 8000 });
        return;
      } catch (_) {
        // The export-history panel may rerender while being scrolled.  Refind
        // the report row instead of retaining this button locator.
      }
    }
    await sleep(500 * (attempt + 1));
  }
  throw new Error(`本次导出任务（${marker}）的下载按钮无法进入可点击区域`);
}

async function resolveSystemShop(mapping, config) {
  const systemSession = await resolveSystemSession(config);
  const accessToken = systemSession.accessToken;
  const shopResponse = await fetch(`${systemUrl}/api/admin/order-import-configuration`, { headers: { Authorization: `Bearer ${accessToken}` } });
  const shopData = await shopResponse.json().catch(() => ({}));
  if (!shopResponse.ok) throw new Error(shopData.message || '无法读取系统店铺配置');
  const shops = shopData.shops || [];
  // ID is the only immutable mapping.  Newly added stores may not have an ID
  // yet, so retain code/name fallback using the actual API field names.
  const matches = mapping.systemShopId
    ? shops.filter(shop => shop.id === mapping.systemShopId)
    : shops.filter(shop =>
      (mapping.systemShopCode && (shop.shop_code || shop.code) === mapping.systemShopCode)
      || (mapping.systemShopName && (shop.shop_name || shop.name) === mapping.systemShopName)
    );
  if (matches.length !== 1) throw new Error('系统店铺映射无法唯一识别，未执行导入');
  return { systemSession, systemShop: matches[0] };
}

async function main() {
  const config = readConfig();
  const explicitDate = argumentValue('--date');
  const rangeStartArg = argumentValue('--start-date'), rangeEndArg = argumentValue('--end-date');
  const requestedStore = argumentValue('--store');
  const lookbackDays = Math.max(1, Math.min(31, Number(config.exportLookbackDays) || 1));
  if (!explicitDate && !rangeStartArg && !rangeEndArg && lookbackDays > 1) {
    for (let offset = lookbackDays; offset >= 1; offset -= 1) {
      const result = spawnSync(process.execPath, [__filename, '--store', requestedStore || '', '--date', utcDaysAgo(offset)], { stdio: 'inherit' });
      if (result.status) process.exitCode = result.status;
    }
    return;
  }
  const targetDate = rangeStartArg || explicitDate || yesterdayInUtc();
  const endDate = rangeEndArg || targetDate;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate) || targetDate > endDate) throw new Error('日期范围格式必须为 YYYY-MM-DD，且开始日期不能晚于结束日期');
  const dryRun = process.argv.includes('--dry-run');
  const inspectExport = process.argv.includes('--inspect-export');
  const force = process.argv.includes('--force');
  const mapping = requestedStore
    ? config.shopMappings.find(item => item.profileKey === requestedStore)
    : config.shopMappings[0];
  if (!mapping) throw new Error('未找到指定店铺的本机自动化配置');
  const profileKey = mapping.profileKey || 'default';
  const profilePath = profileKey === 'default'
    ? path.join(config.rootDir, '浏览器配置', 'TikTokShop下载助手')
    : path.join(config.rootDir, '浏览器配置', `TikTokShop下载助手-${profileKey}`);
  const downloadsPath = stagingDirectory();
  const { filePath: logPath, data: runLog } = readRunLog(config.rootDir);
  const runKey = `${targetDate}~${endDate}|${profileKey}`;
  if (!force && runLog.runs?.some(run => run.key === runKey && run.status === 'imported')) {
    console.log(`已完成过 ${targetDate} 至 ${endDate} 的自动导入，跳过重复任务。`);
    return;
  }

  const { chromium } = require(playwrightPath);
  const native = await connectNativeChrome(chromium, profilePath, profileKey);
  const browser = native.browser;
  const context = browser.contexts()[0];
  const page = context.pages()[0] || await context.newPage();
  const downloadSession = await context.newCDPSession(page);
  try {
    await downloadSession.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadsPath, eventsEnabled: false });
  } catch (_) {
    await downloadSession.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadsPath });
  }
  const startedAt = new Date().toISOString();
  const record = { key: runKey, date: targetDate, endDate, startedAt, status: 'running' };
  try {
    const { start, end } = utcRange(targetDate, endDate);
    await gotoWithRetry(page, `${config.sellerCenterUrl.replace(/\/$/, '')}/order?shop_region=${encodeURIComponent(mapping.countryCode)}&tab=all&time_order_created[]=${start}&time_order_created[]=${end}`, '订单');
    await page.waitForTimeout(6000);
    const sellerText = await page.locator('body').innerText();
    verifySellerLogin(mapping, sellerText);
    // Preflight must confirm the system administrator authorization and the
    // unique target store even if the selected day has no orders.
    const { systemSession, systemShop } = await resolveSystemShop(mapping, config);
    const orderCount = await waitForOrderCount(page);
    record.orderCount = orderCount;
    if (!orderCount) { record.status = 'no_orders'; return; }
    if (inspectExport) {
      await page.getByRole('button', { name: '导出', exact: true }).click();
      await page.waitForTimeout(1200);
      const text = await page.locator('body').innerText();
      const index = text.indexOf('导出订单范围');
      record.status = 'inspected';
      record.exportPanel = text.slice(index >= 0 ? index : 0, index >= 0 ? index + 5000 : 5000);
      console.log(record.exportPanel);
      return;
    }
    if (dryRun) {
      record.status = 'previewed'; record.systemSession = 'available'; return;
    }

    const exportButton = page.getByRole('button', { name: '导出', exact: true });
    await exportButton.click();
    await page.waitForTimeout(800);
    await chooseFilteredOrderExportScope(page, orderCount);
    await chooseCsvExportFormat(page);
    const exportMarker = exportTimeMarker();
    await confirmOrderExport(page);
    // The marker is captured before the request: a later history entry cannot
    // cause the downloader to fall back to an earlier exported report.
    await waitForThisExportDownload(page, exportMarker);
    record.exportMarker = exportMarker;
    // TikTok can reuse a report filename. Chrome then replaces the existing
    // file instead of creating a new name, so track its metadata as well.
    const filesBeforeDownload = new Map(fs.readdirSync(downloadsPath).map(file => {
      const filePath = path.join(downloadsPath, file);
      try { const stats = fs.statSync(filePath); return [file, { mtimeMs: stats.mtimeMs, size: stats.size }]; }
      catch (_) { return [file, null]; }
    }));
    const downloadStartedAt = Date.now();
    await clickThisExportDownload(page, exportMarker);
    let outputPath = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const completedFiles = fs.readdirSync(downloadsPath)
        .filter(file => /\.(csv|xlsx)$/i.test(file))
        .map(file => path.join(downloadsPath, file))
        .filter(file => {
          const stats = fs.statSync(file);
          if (!stats.isFile()) return false;
          const previous = filesBeforeDownload.get(path.basename(file));
          return !previous || previous.mtimeMs < stats.mtimeMs || previous.size !== stats.size || stats.mtimeMs >= downloadStartedAt;
        })
        .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
      if (completedFiles.length) { outputPath = completedFiles[0]; break; }
      await sleep(1000);
    }
    if (!outputPath) throw new Error('下载未在 60 秒内完成，未执行导入');
    // Keep the browser download in staging until its actual Created Time
    // values have been verified.  An old TikTok report must never receive a
    // new range filename merely because it was the first file seen locally.
    const rows = parseCsvRows(fs.readFileSync(outputPath, 'utf8'));
    verifyExportDate(rows, targetDate, endDate, mapping.countryCode);
    record.exportOrderCount = verifyExportOrderCount(rows, orderCount);
    outputPath = finalizeDownloadedFile(outputPath, '订单', mapping, targetDate === endDate ? targetDate : `${targetDate}至${endDate}`);
    record.fileName = path.basename(outputPath); record.rowCount = rows.length;

    const accessToken = systemSession.accessToken;
    const callImport = async mode => {
      const response = await fetch(`${systemUrl}/api/admin/order-imports/orders`, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ mode, shopId: systemShop.id, fileName: path.basename(outputPath), rows }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || '系统导入接口请求失败');
      return data;
    };
    const preview = await callImport('preview');
    if (!preview.valid) throw new Error(preview.message || '系统校验未通过');
    record.preview = { insertCount: preview.insertCount, updateCount: preview.updateCount, skipCount: preview.skipCount };
    // The import API is idempotent: unchanged rows are skipped and changed
    // rows are safely versioned in the import batch.  A historical-range
    // rerun must therefore not abandon the whole store merely because some
    // orders were already imported.
    record.preview = { insertCount: preview.insertCount, updateCount: preview.updateCount, skipCount: preview.skipCount };
    const committed = await callImport('commit');
    record.status = 'imported'; record.batchCode = committed.batchCode; record.completedAt = new Date().toISOString();
    record.archivePath = outputPath;
  } catch (error) {
    record.status = 'failed'; record.error = error.message || String(error); record.completedAt = new Date().toISOString();
    console.error(record.error);
    process.exitCode = 1;
  } finally {
    if (!record.completedAt) record.completedAt = new Date().toISOString();
    runLog.runs = [record, ...(runLog.runs || [])].slice(0, 90);
    writeRunLog(logPath, runLog);
    // The browser is attached through CDP and is owned by the store-level
    // runner. Detach only; closing it would kill the session needed by bills.
    try { browser._connection?.close(); } catch (_) { /* no-op */ }
    if (!native.reused) try { native.chromeProcess.kill(); } catch (_) { /* The native Chrome process may already be closed. */ }
  }
}

main().then(() => process.exit(process.exitCode || 0)).catch(error => { console.error(error.stack || error.message); process.exit(1); });
