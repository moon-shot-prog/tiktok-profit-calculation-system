/*
 * TikTok 账单自动下载、校验、写入与归档（支持已结算和未结算，仅本机运行）。
 * 使用 TikTok Shop 专用浏览器已保存的登录状态，以及同步助手保存的系统管理员授权。
 */
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const ExcelJS = require('exceljs');
const { resolveSystemSession } = require('./system-auth-session');
const { stagingDirectory, finalizeDownloadedFile } = require('./download-file-names');
const { dismissSellerPopups, settleSellerPopups } = require('./tiktok-popup-dismiss');

const scriptDirectory = __dirname;
const projectDirectory = path.resolve(scriptDirectory, '..');
const configPath = path.join(scriptDirectory, 'tiktok-automation.config.json');
const playwrightPath = path.join(projectDirectory, '.local-automation', 'node_modules', 'playwright-core');
const SETTLED_REPORT_WAIT_SECONDS = 180;
const UNSETTLED_REPORT_WAIT_SECONDS = 300;
const SETTLED_REPORT_TRIGGER_ATTEMPTS = 2;
const REPORT_DOWNLOAD_ATTEMPTS = 3;
const REPORT_DOWNLOAD_WAIT_MS = 90000;

function readConfig() {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!config.rootDir || !Array.isArray(config.shopMappings)) throw new Error('自动化配置不完整');
  return config;
}
function arg(name) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : null; }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function systemUrl(config) { return String(process.env.LOCAL_SYSTEM_URL || config.systemUrl || 'http://127.0.0.1:3000').replace(/\/$/, ''); }
function findChrome() {
  const candidates = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'];
  const chrome = candidates.find(candidate => fs.existsSync(candidate));
  if (!chrome) throw new Error('未找到 Google Chrome');
  return chrome;
}
function portFor(key) { return 19228 + [...String(key || 'default')].reduce((sum, value) => sum + value.charCodeAt(0), 0) % 1000; }
function shopYesterday() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const date = new Date(Date.UTC(Number(fields.year), Number(fields.month) - 1, Number(fields.day)));
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}
function displayDate(date) { const [year, month, day] = date.split('-'); return `${day}/${month}/${year}`; }
function billLabel(sourceType) { return sourceType === 'settled' ? '已结算账单' : '未结算账单'; }
function readLog(rootDir, sourceType = 'unsettled') {
  const filePath = path.join(rootDir, '待处理', sourceType === 'settled' ? '已结算账单自动任务记录.json' : '未结算账单自动任务记录.json');
  try { return { filePath, data: JSON.parse(fs.readFileSync(filePath, 'utf8')) }; } catch (_) { return { filePath, data: { runs: [] } }; }
}
function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}
async function validSession(config) {
  return resolveSystemSession(config);
}
async function resolveShop(config, mapping) {
  const session = await validSession(config);
  const response = await fetch(`${systemUrl(config)}/api/admin/order-import-configuration`, { headers: { Authorization: `Bearer ${session.accessToken}` } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || '无法读取系统店铺配置');
  const shops = data.shops || [];
  const matches = mapping.systemShopId
    ? shops.filter(shop => shop.id === mapping.systemShopId)
    : shops.filter(shop => (mapping.systemShopCode && (shop.shop_code || shop.code) === mapping.systemShopCode) || (mapping.systemShopName && (shop.shop_name || shop.name) === mapping.systemShopName));
  if (matches.length !== 1) throw new Error('系统店铺映射无法唯一识别，未执行导入');
  return { session, shop: matches[0] };
}
async function openBrowser(chromium, profilePath, profileKey) {
  const port = portFor(profileKey);
  try {
    if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) {
      return { browser: await chromium.connectOverCDP(`http://127.0.0.1:${port}`), process: null, reused: true };
    }
  } catch (_) { /* No reusable session is listening yet. */ }
  const process = spawn(findChrome(), [`--user-data-dir=${profilePath}`, `--remote-debugging-port=${port}`, '--remote-allow-origins=*', '--no-first-run', '--disable-popup-blocking', 'about:blank'], { windowsHide: false });
  for (let retry = 0; retry < 30; retry += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return { browser: await chromium.connectOverCDP(`http://127.0.0.1:${port}`), process, reused: false }; } catch (_) { /* starting */ }
    await sleep(1000);
  }
  try { process.kill(); } catch (_) { /* no-op */ }
  throw new Error('Chrome 专用浏览器启动超时');
}
async function clickText(page, text, required = true) {
  const locator = page.getByText(text, { exact: true });
  for (let index = 0; index < await locator.count(); index += 1) {
    const item = locator.nth(index);
    if (await item.isVisible().catch(() => false)) { await item.click({ force: true }); return true; }
  }
  if (required) throw new Error(`未找到“${text}”入口`);
  return false;
}
async function waitText(page, text, seconds = 30) {
  for (let retry = 0; retry < seconds; retry += 1) {
    if ((await page.locator('body').innerText()).includes(text)) return;
    await sleep(1000);
  }
  throw new Error(`页面未在 ${seconds} 秒内加载“${text}”`);
}
async function visibleMenuHref(page, text) {
  const locator = page.getByText(text, { exact: true });
  for (let index = 0; index < await locator.count(); index += 1) {
    const item = locator.nth(index);
    if (!await item.isVisible().catch(() => false)) continue;
    const href = await item.evaluate(node => node.closest('a')?.href || node.parentElement?.closest('a')?.href || '').catch(() => '');
    if (href) return href;
  }
  return '';
}
async function gotoFinance(page, config, mapping, billTab = '未结算') {
  await page.bringToFront().catch(() => {});
  await page.goto(config.sellerCenterUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(800);
  await settleSellerPopups(page, 2500);
  // On a fresh browser profile Seller Center renders the homepage shell first
  // and its left navigation a few seconds later.  Do not treat that shell as
  // a ready finance page, otherwise the run appears to be stuck on 首页.
  await waitText(page, mapping.sellerCenterName, 45);
  let overviewHref = await visibleMenuHref(page, '财务概览');
  let selected = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (overviewHref) { selected = true; break; }
    const finance = page.getByText('财务', { exact: true });
    let opened = false;
    for (let index = 0; index < await finance.count(); index += 1) {
      const item = finance.nth(index);
      if (!await item.isVisible().catch(() => false)) continue;
      await item.hover({ force: true }).catch(() => {});
      await item.click({ force: true }); opened = true; break;
    }
    if (!opened) throw new Error('未识别“财务”菜单，请确认 TikTok Shop 仍处于商家中心首页。');
    await sleep(1400);
    overviewHref = overviewHref || await visibleMenuHref(page, '财务概览');
    const previousUrl = page.url();
    if (await clickText(page, '财务概览', false)) {
      await sleep(900);
      const bodyText = await page.locator('body').innerText().catch(() => '');
      // Do not accept a matching text node in the homepage body as a menu
      // navigation.  Continue only when the route changed or the bill tab is
      // really present, otherwise retry the expanded sidebar.
      if (page.url() !== previousUrl || bodyText.includes(billTab)) { selected = true; break; }
    }
    if (attempt === 2) throw new Error('财务菜单展开后未找到“财务概览”，请确认 TikTok Shop 页面未处于维护或登录提示状态。');
    await sleep(1000);
  }
  if (!selected) throw new Error('未找到“财务概览”入口');
  // A menu click only changes the SPA state on some Seller Center versions.
  // When the sidebar exposes a real target URL, navigate to it explicitly so
  // the first run cannot remain visually parked on the homepage.
  overviewHref = overviewHref || await visibleMenuHref(page, '财务概览');
  if (overviewHref && page.url() !== overviewHref) {
    await page.goto(overviewHref, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(800);
    await settleSellerPopups(page, 1500);
  }
  try {
    await waitText(page, billTab, 20);
  } catch (error) {
    if (!overviewHref) throw error;
    await page.goto(overviewHref, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(800);
    await dismissSellerPopups(page);
    await waitText(page, billTab);
  }
  await clickText(page, billTab);
  await waitText(page, '导出历史记录', 30);
}
async function gotoFinanceWithRetry(page, config, mapping, billTab) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await gotoFinance(page, config, mapping, billTab);
      return;
    } catch (error) {
      lastError = error;
      if (attempt === 3) break;
      // 财务左侧菜单偶发未渲染完整；回到商家中心重新加载后再尝试，
      // 不复用半展开的菜单状态。
      await page.goto(config.sellerCenterUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await dismissSellerPopups(page);
      await sleep(1500 * attempt);
    }
  }
  throw new Error(`${billLabel(billTab === '结算单' ? 'settled' : 'unsettled')}页面打开失败：${lastError?.message || '未知错误'}`);
}
async function fillDateRange(scope, startDate, endDate) {
  const inputs = scope.locator('input:visible');
  const count = await inputs.count();
  if (count < 2) return false;
  const start = inputs.nth(count - 2), end = inputs.nth(count - 1);
  await start.fill(displayDate(startDate)); await start.press('Tab').catch(() => {});
  await end.fill(displayDate(endDate)); await end.press('Enter').catch(() => {});
  return true;
}
async function pickVisibleCalendarDay(page, date, preferRightPanel) {
  // TikTok renders early-month cells as either `2` or `02` depending on the
  // rollout/locale.  Accept both forms so 01–09 never fail date selection.
  const days = new Set([String(Number(date.slice(-2))), date.slice(-2)]), cells = page.locator('.p-picker-date-value');
  const expectedMonth = `${Number(date.slice(0, 4))}年-${Number(date.slice(5, 7))}月`;
  const candidates = [];
  for (let index = 0; index < await cells.count(); index += 1) {
    const cell = cells.nth(index);
    if (!await cell.isVisible().catch(() => false) || !days.has((await cell.innerText().catch(() => '')).trim())) continue;
    // A two-month picker renders leading/trailing dates from neighbouring
    // months too.  "1" can therefore mean Oct 1 or Nov 1.  Bind the cell to
    // its calendar title before clicking; x-coordinate alone is ambiguous.
    const calendarMonth = await cell.evaluate(node => {
      for (let parent = node.parentElement, depth = 0; parent && depth < 10; parent = parent.parentElement, depth += 1) {
        const titles = [...parent.querySelectorAll('*')]
          .map(item => (item.textContent || '').trim())
          .filter(text => /^\d{4}年-\d{1,2}月$/.test(text));
        if (titles.length) return titles[0];
      }
      return '';
    }).catch(() => '');
    if (calendarMonth !== expectedMonth) continue;
    const isAdjacentMonthCell = await cell.evaluate(node => {
      for (let parent = node; parent && parent !== document.body; parent = parent.parentElement) {
        const marker = `${parent.className || ''} ${parent.getAttribute?.('aria-disabled') || ''}`.toLowerCase();
        if (/(outside|disabled|adjacent|prev|next|not-in-view)/.test(marker)) return true;
        if (parent.matches?.('[role="gridcell"]')) break;
      }
      return false;
    }).catch(() => false);
    if (isAdjacentMonthCell) continue;
    const box = await cell.boundingBox(); if (box) candidates.push({ cell, x: box.x });
  }
  if (!candidates.length) throw new Error(`账单日期选择器中未找到 ${date}（当前日历月应为 ${expectedMonth}）`);
  candidates.sort((left, right) => left.x - right.x);
  await (preferRightPanel ? candidates[candidates.length - 1] : candidates[0]).cell.click();
}
function monthIndex(year, month) { return Number(year) * 12 + Number(month) - 1; }
function dateMonthIndex(date) { return monthIndex(date.slice(0, 4), date.slice(5, 7)); }
async function visibleSettlementCalendarMonths(page) {
  const titles = page.getByText(/^\d{4}年-\d{1,2}月$/, { exact: true });
  const months = [];
  for (let index = 0; index < await titles.count(); index += 1) {
    const title = titles.nth(index);
    if (!await title.isVisible().catch(() => false)) continue;
    const match = (await title.innerText()).trim().match(/^(\d{4})年-(\d{1,2})月$/);
    if (match) months.push(monthIndex(match[1], match[2]));
  }
  return months.sort((left, right) => left - right);
}
async function showSettlementCalendarMonth(page, date) {
  const target = dateMonthIndex(date);
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const months = await visibleSettlementCalendarMonths(page);
    if (months.length >= 2 && target >= months[0] && target <= months[months.length - 1]) return;
    // The two panels mount asynchronously on the first use of this dialog.
    // Wait for them instead of failing while the calendar is still rendering.
    if (!months.length) { await sleep(250); continue; }
    const previous = target < months[0];
    const arrow = page.locator(previous ? 'svg.arco-icon-left' : 'svg.arco-icon-right');
    if (!await clickFirstVisible(arrow)) throw new Error(`已结算账单日期选择器无法翻到 ${date.slice(0, 7)}`);
    await sleep(180);
  }
  throw new Error(`已结算账单日期选择器未能翻到 ${date.slice(0, 7)}`);
}
async function clickFirstVisible(locator) {
  const count = await locator.count().catch(() => 0);
  for (let index = count - 1; index >= 0; index -= 1) {
    const item = locator.nth(index);
    if (!await item.isVisible().catch(() => false)) continue;
    await item.click({ force: true });
    return true;
  }
  return false;
}
async function openSettledRangePicker(page, exportPanel) {
  // TikTok has shipped both an editable input and a button-like field labelled
  // “开始时间 - 结束时间”.  Do not require two inputs: a single range picker is
  // the normal shape of the settlement-export dialog.
  const direct = exportPanel.locator('input:visible');
  if (await direct.count()) {
    await direct.first().click({ force: true });
    await sleep(250);
    return;
  }
  // Some regional Seller Center variants render the field as an aria button
  // (or a plain div) and do not include the literal full placeholder.  Check
  // these accessible variants before falling back to text-node clicks.
  const accessibleTriggers = exportPanel.locator('[role="button"], button, [aria-haspopup="dialog"], [aria-haspopup="true"]');
  for (let index = 0; index < await accessibleTriggers.count(); index += 1) {
    const trigger = accessibleTriggers.nth(index);
    if (!await trigger.isVisible().catch(() => false)) continue;
    const hint = `${await trigger.getAttribute('aria-label').catch(() => '') || ''} ${await trigger.getAttribute('placeholder').catch(() => '') || ''} ${await trigger.innerText().catch(() => '') || ''}`;
    if (!/(开始时间|结束时间|日期范围|选择日期|date range)/i.test(hint)) continue;
    await trigger.click({ force: true });
    await sleep(350);
    return;
  }
  // Prefer the real range-field container over its child label.  On a fresh
  // dialog render, clicking only the text may not open the calendar.
  const knownTrigger = exportPanel.locator('div.sc-idvBfp.jjBdyS').filter({ hasText: '开始时间' }).first();
  if (await knownTrigger.isVisible().catch(() => false)) {
    await knownTrigger.click({ force: true });
    await sleep(350);
    return;
  }
  const rangeText = exportPanel.getByText(/开始时间\s*-\s*结束时间/, { exact: false });
  if (await clickFirstVisible(rangeText)) { await sleep(250); return; }
  const genericRange = page.getByText(/开始时间\s*-\s*结束时间/, { exact: false });
  if (await clickFirstVisible(genericRange)) { await sleep(250); return; }
  // Last fallback: TikTok sometimes translates the placeholder or splits it
  // over nested spans.  Find a visible label containing either endpoint and
  // click its nearest clickable/container ancestor.
  const endpointText = exportPanel.getByText(/开始时间|结束时间|选择日期|date range/i, { exact: false });
  for (let index = 0; index < await endpointText.count(); index += 1) {
    const label = endpointText.nth(index);
    if (!await label.isVisible().catch(() => false)) continue;
    const trigger = label.locator('xpath=ancestor-or-self::*[self::button or @role="button" or @tabindex or .//input][1]');
    if (await trigger.count() && await trigger.first().isVisible().catch(() => false)) {
      await trigger.first().click({ force: true });
    } else {
      await label.click({ force: true });
    }
    await sleep(350);
    if (await page.getByText(/^\d{4}年-\d{1,2}月$/, { exact: true }).count().catch(() => 0)) return;
  }
  throw new Error('已结算账单导出窗口未找到可操作的日期范围控件（已尝试输入框、按钮、日期标签三种页面结构）');
}
async function settledExportPanel(page) {
  const specific = page.locator('.p-popover-inner-content, [role="dialog"], .arco-modal-content, .arco-popover-content')
    .filter({ hasText: /请选择导出的时间范围|开始时间\s*-\s*结束时间|开始时间|选择日期|date range/i });
  for (let index = (await specific.count()) - 1; index >= 0; index -= 1) {
    const panel = specific.nth(index);
    if (await panel.isVisible().catch(() => false)) return panel;
  }
  // Never use the whole document unless the modal is genuinely unclassed;
  // this retains compatibility with regional A/B layouts without touching the
  // finance page's background filters.
  const overlays = page.locator('[role="dialog"], .arco-modal, .arco-popover, .p-popover');
  for (let index = (await overlays.count()) - 1; index >= 0; index -= 1) {
    const panel = overlays.nth(index);
    if (!await panel.isVisible().catch(() => false)) continue;
    const text = await panel.innerText().catch(() => '');
    if (/导出|export/i.test(text)) return panel;
  }
  throw new Error('已结算账单导出窗口未显示；请确认页面未被登录验证或提示弹窗遮挡');
}
async function selectDateAndExport(page, startDate, endDate = startDate, sourceType = 'unsettled') {
  await clickText(page, '导出');
  await sleep(600);
  // 已结算与未结算的新版弹窗都是同一个日期范围控件。不要填写弹窗中
  // 任意两个 input：其中可能混有搜索框或主页面筛选控件，会让 TikTok
  // 生成默认当天的报表。统一通过日历选择开始、结束日期。
  const exportPanel = await settledExportPanel(page);
  await openSettledRangePicker(page, exportPanel);
  await showSettlementCalendarMonth(page, startDate);
  await pickVisibleCalendarDay(page, startDate, false);
  await sleep(250);
  await showSettlementCalendarMonth(page, endDate);
  await pickVisibleCalendarDay(page, endDate, startDate.slice(0, 7) !== endDate.slice(0, 7));
  await sleep(250);
  const confirm = page.getByRole('button', { name: '确认', exact: true }).last();
  if (await confirm.isVisible().catch(() => false)) { await confirm.click(); await sleep(400); }
  const buttons = page.getByRole('button', { name: '导出', exact: true });
  for (let index = (await buttons.count()) - 1; index >= 0; index -= 1) {
    const item = buttons.nth(index);
    if (await item.isVisible().catch(() => false) && !await item.isDisabled().catch(() => false)) { await item.click({ force: true }); return; }
  }
  throw new Error(`${billLabel(sourceType)}导出按钮仍未启用，日期范围可能未被 TikTok 接受`);
}
async function settledDownloadCandidates(page) {
  const titles = page.getByText(/income_\d+.*\.xlsx/i, { exact: false });
  const candidates = [], seen = new Set();
  for (let index = 0; index < await titles.count(); index += 1) {
    const title = titles.nth(index);
    if (!await title.isVisible().catch(() => false)) continue;
    const reportName = (await title.innerText()).trim();
    // TikTok 会频繁调整导出历史的样式类。向上寻找只包含一个“下载”按钮的
    // 最近容器，可把报告名和按钮可靠绑定，而不依赖 className。
    const buttonHandle = await title.evaluateHandle(node => {
      for (let parent = node.parentElement, depth = 0; parent && depth < 12; parent = parent.parentElement, depth += 1) {
        const buttons = [...parent.querySelectorAll('button')].filter(button => button.textContent.trim() === '下载');
        if (buttons.length === 1) return buttons[0];
      }
      return null;
    });
    const button = buttonHandle.asElement();
    if (!button || !await button.isVisible().catch(() => false)) continue;
    const key = reportName;
    if (seen.has(key)) continue;
    seen.add(key); candidates.push({ key, button, reportName });
  }
  return candidates;
}
async function readyReport(page, startDate, endDate = startDate, sourceType = 'unsettled', knownSettledReports = new Set()) {
  const expected = `Onhold-unsettled-orders-${startDate.replace(/-/g, '/')}-${endDate.replace(/-/g, '/')}`;
  const waitSeconds = sourceType === 'settled' ? SETTLED_REPORT_WAIT_SECONDS : UNSETTLED_REPORT_WAIT_SECONDS;
  // The history dialog remains open while a report is being generated.  Do not
  // click its trigger on every poll: Seller Center toggles/re-renders it and
  // that made the assistant appear to repeatedly click “导出历史记录”.
  const ensureHistoryOpen = async () => {
    const history = page.getByText('已导出报告', { exact: true });
    if (await history.count() && await history.first().isVisible().catch(() => false)) return;
    await clickText(page, '导出历史记录', false);
    await waitText(page, '已导出报告', 15);
  };

  const unsettledDownloadButton = async () => {
    const buttons = page.getByRole('button', { name: '下载', exact: true });
    const expectedText = expected.toLowerCase();
    for (let index = 0; index < await buttons.count(); index += 1) {
      const button = buttons.nth(index);
      if (!await button.isVisible().catch(() => false)) continue;
      const belongsToReport = await button.evaluate((node, wanted) => {
        // The DOM has changed several times: some versions have a row wrapper,
        // others place all report rows in one popover.  Match the closest
        // ancestor carrying the filename rather than relying on CSS classes.
        for (let parent = node.parentElement, depth = 0; parent && depth < 10; parent = parent.parentElement, depth += 1) {
          if ((parent.innerText || '').toLowerCase().includes(wanted)) return true;
        }
        return false;
      }, expectedText).catch(() => false);
      if (belongsToReport) return { button, reportName: expected };
    }
    return null;
  };

  await ensureHistoryOpen();
  for (let retry = 0; retry < waitSeconds; retry += 1) {
    if (sourceType === 'settled') {
      const fresh = (await settledDownloadCandidates(page)).find(candidate => !knownSettledReports.has(candidate.key));
      if (fresh) return fresh;
    } else {
      const report = await unsettledDownloadButton();
      if (report) return report;
    }
    // The site may close the panel after a SPA refresh; reopen it only then.
    if (retry > 0 && retry % 10 === 0) await ensureHistoryOpen();
    await sleep(1000);
  }
  throw new Error(`${billLabel(sourceType)} ${startDate} 至 ${endDate} 未在 ${waitSeconds} 秒内生成新的可下载报表`);
}
async function readySettledReportWithRetry(page, startDate, endDate, knownSettledReports) {
  let lastError = null;
  for (let attempt = 1; attempt <= SETTLED_REPORT_TRIGGER_ATTEMPTS; attempt += 1) {
    try {
      return await readyReport(page, startDate, endDate, 'settled', knownSettledReports);
    } catch (error) {
      lastError = error;
      if (attempt === SETTLED_REPORT_TRIGGER_ATTEMPTS) break;
      // Seller Center can queue an accepted export for several minutes. Close
      // the history panel and submit one fresh request before giving up.
      await page.keyboard.press('Escape').catch(() => {});
      await sleep(1500 * attempt);
      await selectDateAndExport(page, startDate, endDate, 'settled');
    }
  }
  throw new Error(`${lastError?.message || '已结算报表生成失败'}（已自动重新触发 ${SETTLED_REPORT_TRIGGER_ATTEMPTS} 次）`);
}
async function filterSettledWorkbook(filePath, startDate, endDate, downloadsPath) {
  const book = new ExcelJS.Workbook(); await book.xlsx.readFile(filePath); const sheet = book.worksheets[0];
  const header = sheet.getRow(1).values.slice(1).map(value => String(value || '').trim()); const dateIndex = header.indexOf('结算日期');
  if (dateIndex < 0) throw new Error('已结算报表缺少“结算日期”列');
  const output = new ExcelJS.Workbook(); const target = output.addWorksheet('已结算账单'); target.addRow(header); let count = 0;
  for (let row = 2; row <= sheet.rowCount; row += 1) { const source = sheet.getRow(row), date = source.getCell(dateIndex + 1).text.trim().replace(/\//g, '-'); if (!date || date < startDate || date > endDate) continue; const values = header.map((_, cell) => source.getCell(cell + 1).text); values[dateIndex] = date; target.addRow(values); count += 1; }
  if (!count) throw new Error(`已结算报表中没有 ${startDate} 至 ${endDate} 的明细`);
  const outputPath = path.join(downloadsPath, `已结算-${startDate}至${endDate}-${path.basename(filePath)}`); await output.xlsx.writeFile(outputPath); fs.unlinkSync(filePath); return { outputPath, count };
}
function downloadSnapshot(directory) {
  const snapshot = new Set();
  try {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const file = path.join(directory, entry.name);
      const stat = fs.statSync(file);
      snapshot.add(`${entry.name}|${stat.size}|${stat.mtimeMs}`);
    }
  } catch (_) { /* directory is created by the caller */ }
  return snapshot;
}
function browserDownloadDirectories(primaryDirectory) {
  const directories = [primaryDirectory];
  // If a running Chrome instance rejects CDP download behavior, Chromium uses
  // its profile default, normally the Windows Downloads folder.  Watch it as
  // a secondary source and move only the new, stable file into our staging
  // area before import.
  if (process.env.USERPROFILE) directories.push(path.join(process.env.USERPROFILE, 'Downloads'));
  return [...new Set(directories.map(item => path.resolve(item)))].filter(directory => fs.existsSync(directory));
}
function downloadSnapshots(directories) {
  const snapshot = new Set();
  for (const directory of directories) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const file = path.join(directory, entry.name); const stat = fs.statSync(file);
      snapshot.add(`${file}|${stat.size}|${stat.mtimeMs}`);
    }
  }
  return snapshot;
}
async function waitForBrowserDownload(directories, before, timeoutMs) {
  const until = Date.now() + timeoutMs;
  const observed = new Map();
  while (Date.now() < until) {
    for (const directory of directories) {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isFile() || /\.(crdownload|tmp)$/i.test(entry.name)) continue;
        const file = path.join(directory, entry.name);
        const stat = fs.statSync(file);
        if (stat.size <= 0 || before.has(`${file}|${stat.size}|${stat.mtimeMs}`)) continue;
        // A response acknowledgement can precede Chromium flushing the file.
        // Accept it only after the size has remained unchanged for two polls.
        const prior = observed.get(file);
        if (prior && prior.size === stat.size && prior.mtimeMs === stat.mtimeMs && Date.now() - prior.firstSeenAt >= 900) return file;
        observed.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, firstSeenAt: prior?.firstSeenAt || Date.now() });
      }
    }
    await sleep(500);
  }
  return null;
}
async function clickReportDownload(page, report) {
  // The export-history panel re-renders after a report becomes ready. Always
  // use Locator objects based on the filename; never reuse the old
  // ElementHandle captured while polling for the report.
  const findCurrentButton = async () => {
    const titles = page.getByText(String(report.reportName || ''), { exact: false });
    for (let index = 0; index < await titles.count(); index += 1) {
      const title = titles.nth(index);
      if (!await title.isVisible().catch(() => false)) continue;
      const row = title.locator('xpath=ancestor::div[count(.//button[normalize-space()="下载"])=1][1]');
      const button = row.getByRole('button', { name: '下载', exact: true });
      if (await button.count() && await button.first().isVisible().catch(() => false)) return button.first();
    }
    return null;
  };
  let button = await findCurrentButton();
  if (!button) {
    await clickText(page, '导出历史记录', false);
    await sleep(500);
    button = await findCurrentButton();
  }
  if (!button) throw new Error(`导出历史中未找到“${report.reportName || '目标报表'}”对应的下载按钮`);
  await button.click({ force: true, timeout: 10000 });
}
async function downloadFile(page, downloadsPath, report) {
  fs.mkdirSync(downloadsPath, { recursive: true });
  const expectedName = String(report.reportName || '账单.xlsx').replace(/[\\/:*?"<>|]/g, '_');
  const targetPath = path.join(downloadsPath, expectedName);
  let lastError = null;
  for (let attempt = 1; attempt <= REPORT_DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      // Attached Chrome profiles do not always emit Playwright's `download`
      // event. Force Chromium to write to the assistant staging folder and
      // use that physical file as an additional, authoritative signal.
      const downloadDirectories = browserDownloadDirectories(downloadsPath);
      const before = downloadSnapshots(downloadDirectories);
      const cdp = await page.context().newCDPSession(page).catch(() => null);
      if (cdp) {
        await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadsPath }).catch(() => {});
        await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadsPath, eventsEnabled: true }).catch(() => {});
      }
      // Seller Center alternates between a native browser download, a JSON
      // response containing a signed URL, and a direct XLSX response.  Listen
      // for all three forms instead of only one historical API pathname.
      const responsePromise = page.waitForResponse(response => {
        const url = response.url();
        const headers = response.headers();
        const disposition = String(headers['content-disposition'] || '');
        return /attachment|filename=/i.test(disposition)
          || /(?:settlement|bill|income).*(?:download|file)|(?:download|file).*(?:settlement|bill|income)/i.test(url);
      }, { timeout: REPORT_DOWNLOAD_WAIT_MS })
        .then(response => ({ type: 'response', response })).catch(() => null);
      const localFilePromise = waitForBrowserDownload(downloadDirectories, before, REPORT_DOWNLOAD_WAIT_MS)
        .then(filePath => filePath ? ({ type: 'local_file', filePath }) : null);
      const playwrightDownloadPromise = page.waitForEvent('download', { timeout: REPORT_DOWNLOAD_WAIT_MS })
        .then(download => ({ type: 'playwright_download', download })).catch(() => null);
      await clickReportDownload(page, report);
      const result = await Promise.race([responsePromise, localFilePromise, playwrightDownloadPromise, new Promise(resolve => setTimeout(() => resolve(null), REPORT_DOWNLOAD_WAIT_MS))]);
      if (result?.type === 'local_file') {
        if (path.resolve(result.filePath) !== path.resolve(targetPath)) fs.renameSync(result.filePath, targetPath);
      } else if (result?.type === 'playwright_download') {
        await result.download.saveAs(targetPath);
      } else if (result?.type === 'response') {
        const endpointResponse = result.response;
        const disposition = String(endpointResponse.headers()['content-disposition'] || '');
        if (/attachment|filename=/i.test(disposition)) {
          fs.writeFileSync(targetPath, await endpointResponse.body());
        } else {
          const payload = await endpointResponse.json().catch(() => ({}));
          const filePath = String(payload?.data?.url || payload?.data?.downloadUrl || payload?.url || '');
          if (filePath) {
            const fileUrl = new URL(filePath, endpointResponse.url()).href;
            const fileResponse = await page.context().request.get(fileUrl, { timeout: 90000 });
            if (!fileResponse.ok()) throw new Error(`下载账单文件失败（HTTP ${fileResponse.status()}）`);
            fs.writeFileSync(targetPath, await fileResponse.body());
          } else {
            // TikTok's current endpoint responds with `{ message: "success" }`
            // and lets Chrome write the XLSX afterwards.  That response is an
            // acknowledgement, not a download failure; keep waiting for the
            // staging-folder watcher configured above.
            const local = await localFilePromise;
            if (!local?.filePath) throw new Error(payload?.message ? `TikTok 已确认下载，但未在等待时间内生成文件：${payload.message}` : 'TikTok 未返回账单文件地址');
            if (path.resolve(local.filePath) !== path.resolve(targetPath)) fs.renameSync(local.filePath, targetPath);
          }
        }
      } else {
        throw new Error(`第 ${attempt} 次下载未收到 TikTok 的文件响应`);
      }
      if (!fs.existsSync(targetPath) || fs.statSync(targetPath).size <= 0) throw new Error('账单下载文件为空');
      return targetPath;
    } catch (error) {
      lastError = error;
      if (attempt < REPORT_DOWNLOAD_ATTEMPTS) {
        // Acknowledged downloads occasionally appear only after the history
        // popover is reopened.  Re-resolve the button on the next pass rather
        // than repeatedly clicking a stale DOM handle.
        await page.keyboard.press('Escape').catch(() => {});
        await sleep(1200 * attempt);
        await clickText(page, '导出历史记录', false).catch(() => {});
        await sleep(800);
      }
    }
  }
  throw new Error(`账单下载连续 ${REPORT_DOWNLOAD_ATTEMPTS} 次失败：${lastError?.message || '未知错误'}`);
}
async function submitBill(config, session, shop, filePath, mode, sourceType = 'unsettled') {
  const payload = { mode, sourceType, shopId: shop.id, fileName: path.basename(filePath), fileBase64: fs.readFileSync(filePath).toString('base64') };
  const response = await fetch(`${systemUrl(config)}/api/admin/bill-imports`, { method: 'POST', headers: { Authorization: `Bearer ${session.accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || `${billLabel(sourceType)}导入接口请求失败`);
  if (!data.valid) throw new Error(data.message || `${billLabel(sourceType)}校验未通过`);
  return data;
}

async function main() {
  const config = readConfig();
  const requested = arg('--store') || 'default';
  const rangeStart = arg('--start-date');
  const rangeEnd = arg('--end-date');
  const targetDate = rangeStart || arg('--date') || shopYesterday();
  const endDate = rangeEnd || targetDate;
  const dryRun = process.argv.includes('--dry-run');
  const force = process.argv.includes('--force');
  const inspectHistory = process.argv.includes('--inspect-history');
  const inspectDownload = process.argv.includes('--inspect-download');
  const inspectPage = process.argv.includes('--inspect-page');
  const inspectExportDialog = process.argv.includes('--inspect-export-dialog');
  const sourceType = arg('--source') === 'settled' ? 'settled' : 'unsettled';
  const billTab = sourceType === 'settled' ? '结算单' : '未结算';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate) || endDate < targetDate) throw new Error('日期范围格式必须为 YYYY-MM-DD，且开始日期不能晚于结束日期');
  const mapping = config.shopMappings.find(item => (item.profileKey || 'default') === requested);
  if (!mapping) throw new Error('未找到指定店铺的本机自动化配置');
  const key = mapping.profileKey || 'default';
  const profilePath = key === 'default' ? path.join(config.rootDir, '浏览器配置', 'TikTokShop下载助手') : path.join(config.rootDir, '浏览器配置', `TikTokShop下载助手-${key}`);
  const { filePath: logPath, data: runLog } = readLog(config.rootDir, sourceType);
  const runKey = `${targetDate}~${endDate}|${key}`;
  if (!dryRun && !force && runLog.runs?.some(run => run.key === runKey && run.status === 'imported')) { console.log(`已完成过 ${targetDate} 至 ${endDate} 的${billLabel(sourceType)}导入，跳过重复任务。`); return; }
  const record = { key: runKey, date: targetDate, endDate, store: mapping.sellerCenterName, status: 'running', startedAt: new Date().toISOString() };
  const { chromium } = require(playwrightPath);
  const native = await openBrowser(chromium, profilePath, key);
  try {
    const page = native.browser.contexts()[0].pages()[0] || await native.browser.contexts()[0].newPage();
    page.setDefaultTimeout(30000); page.setDefaultNavigationTimeout(60000);
    const sessionAndShop = await resolveShop(config, mapping);
    await gotoFinanceWithRetry(page, config, mapping, billTab);
    if (inspectPage) { console.log((await page.locator('body').innerText()).slice(0, 9000)); record.status = 'inspected'; return; }
    if (inspectExportDialog) {
      await clickText(page, '导出'); await sleep(800);
      if (sourceType === 'unsettled') {
        if (process.argv.includes('--inspect-apply-range')) {
          const panel = page.locator('.p-popover-inner-content, [role="dialog"]').filter({ hasText: /请选择导出的时间范围|开始时间\s*-\s*结束时间/ }).last();
          await openSettledRangePicker(page, panel);
          await showSettlementCalendarMonth(page, targetDate);
          await pickVisibleCalendarDay(page, targetDate, false);
          await sleep(150);
          await showSettlementCalendarMonth(page, endDate);
          await pickVisibleCalendarDay(page, endDate, targetDate.slice(0, 7) !== endDate.slice(0, 7));
          const confirm = page.getByRole('button', { name: '确认', exact: true }).last();
          await confirm.click(); await sleep(400);
        }
        const controls = await page.locator('button, [role="button"], input, textarea, select').evaluateAll(nodes => nodes.filter(node => node.offsetParent !== null).map((node, index) => ({ index, tag: node.tagName, text: (node.innerText || node.value || '').trim(), placeholder: node.getAttribute('placeholder'), ariaLabel: node.getAttribute('aria-label'), outerHtml: node.outerHTML.slice(0, 1200) })).slice(-100));
        console.log(JSON.stringify({ text: (await page.locator('body').innerText()).slice(-7000), controls }, null, 2));
        record.status = 'inspected'; return;
      }
      const inputs = await page.locator('input:visible').evaluateAll(nodes => nodes.map((node, index) => ({
        index, type: node.type, placeholder: node.getAttribute('placeholder'), value: node.value,
        ariaLabel: node.getAttribute('aria-label'), outerHtml: node.outerHTML.slice(0, 1000)
      })));
      const startField = await page.getByText('开始时间', { exact: true }).first().evaluate(node => {
        const ancestors = []; let current = node;
        for (let depth = 0; current && depth < 6; depth += 1, current = current.parentElement) ancestors.push(current.outerHTML.slice(0, 3000));
        return ancestors;
      }).catch(() => []);
      const exportPanel = page.locator('.p-popover-inner-content, [role="dialog"]').filter({ hasText: /请选择导出的时间范围|开始时间\s*-\s*结束时间/ }).last();
      await openSettledRangePicker(page, exportPanel);
      const inspectTargetDate = arg('--target-date');
      if (inspectTargetDate) await showSettlementCalendarMonth(page, inspectTargetDate);
      if (process.argv.includes('--inspect-pick-date') && inspectTargetDate) await pickVisibleCalendarDay(page, inspectTargetDate, false);
      await page.screenshot({ path: path.join(scriptDirectory, 'settled-export-date-picker.png'), fullPage: false }).catch(() => {});
      const pickerInputs = await page.locator('input:visible').evaluateAll(nodes => nodes.map((node, index) => ({ index, type: node.type, placeholder: node.getAttribute('placeholder'), value: node.value, outerHtml: node.outerHTML.slice(0, 600) })));
      const dayNodes = await page.getByText('15', { exact: true }).evaluateAll(nodes => nodes.map((node, index) => ({ index, tag: node.tagName, className: node.className, outerHtml: node.parentElement?.outerHTML.slice(0, 1800) })));
      const dayTwoNodes = await page.getByText('2', { exact: true }).evaluateAll(nodes => nodes.filter(node => node.closest('.p-picker-date')).map((node, index) => ({ index, outerHtml: node.parentElement?.outerHTML.slice(0, 1000), parentClass: node.parentElement?.className })));
      const pickerControls = await page.locator('button, [role="button"], svg').evaluateAll(nodes => nodes.filter(node => node.closest('[class*="picker"]')).map((node, index) => ({ index, tag: node.tagName, className: node.className?.toString() || '', ariaLabel: node.getAttribute('aria-label'), title: node.getAttribute('title'), text: node.textContent?.trim(), outerHtml: node.outerHTML.slice(0, 1000) })).slice(0, 80));
      console.log(JSON.stringify({ text: (await page.locator('body').innerText()).slice(-7000), inputs, pickerInputs, dayNodes, dayTwoNodes, pickerControls, startField, visibleMonths: await visibleSettlementCalendarMonths(page) }, null, 2));
      record.status = 'inspected'; return;
    }
    if (inspectHistory) {
      await clickText(page, '导出历史记录'); await waitText(page, '已导出报告');
      if (sourceType === 'settled') {
        const reports = await settledDownloadCandidates(page);
        console.log(JSON.stringify({ targetDate, sourceType, reports: reports.map(report => ({ key: report.key, reportName: report.reportName })), historyText: (await page.locator('body').innerText()).slice(-5000) }, null, 2));
        record.status = 'inspected'; return;
      }
      const target = page.getByText(new RegExp(`Onhold-unsettled-orders-${targetDate.replace(/-/g, '[\\\\/_]')}-${targetDate.replace(/-/g, '[\\\\/_]')}`), { exact: false }).first();
      const structure = await target.evaluate(node => {
        const values = []; let current = node;
        for (let depth = 0; current && depth < 7; depth += 1, current = current.parentElement) values.push({ tag: current.tagName, className: current.className, text: current.innerText?.slice(0, 800), html: current.outerHTML?.slice(0, 2200) });
        return values;
      }).catch(() => []);
      console.log(JSON.stringify({ targetDate, structure }, null, 2)); record.status = 'inspected'; return;
    }
    if (inspectDownload) {
      await clickText(page, '导出历史记录'); await waitText(page, '已导出报告');
      const report = sourceType === 'settled'
        ? (await settledDownloadCandidates(page))[0]
        : await readyReport(page, targetDate, endDate, sourceType);
      if (!report) throw new Error('导出历史中没有可下载的账单');
      const events = [];
      page.on('request', request => events.push({ type: 'request', url: request.url(), method: request.method() }));
      page.on('response', response => events.push({ type: 'response', url: response.url(), status: response.status(), contentType: response.headers()['content-type'] || '' }));
      const downloadedFile = await downloadFile(page, stagingDirectory(), report);
      console.log(JSON.stringify({ reportName: report.reportName, downloadedFile, events: events.filter(item => /download|export|report|file|settle/i.test(item.url)).slice(-12), pages: native.browser.contexts()[0].pages().map(item => item.url()) }, null, 2)); record.status = 'inspected'; return;
    }
    if (dryRun) { record.status = 'previewed'; record.message = `已确认店铺登录、系统授权、${billLabel(sourceType)}页面与导出入口。`; return; }
    const knownSettledReports = sourceType === 'settled' ? new Set((await (async () => { await clickText(page, '导出历史记录'); await waitText(page, '已导出报告'); return settledDownloadCandidates(page); })()).map(report => report.key)) : new Set();
    await selectDateAndExport(page, targetDate, endDate, sourceType);
    const report = sourceType === 'settled'
      ? await readySettledReportWithRetry(page, targetDate, endDate, knownSettledReports)
      : await readyReport(page, targetDate, endDate, sourceType, knownSettledReports);
    const downloadsPath = stagingDirectory();
    let filePath = await downloadFile(page, downloadsPath, report);
    record.reportName = report.reportName;
    if (sourceType === 'settled') { const filtered = await filterSettledWorkbook(filePath, targetDate, endDate, downloadsPath); filePath = filtered.outputPath; record.filteredRows = filtered.count; }
    filePath = finalizeDownloadedFile(filePath, sourceType === 'settled' ? '已结算账单' : '未结算账单', mapping, targetDate === endDate ? targetDate : `${targetDate}至${endDate}`);
    record.fileName = path.basename(filePath);
    const preview = await submitBill(config, sessionAndShop.session, sessionAndShop.shop, filePath, 'preview', sourceType);
    record.preview = { totalRows: preview.totalRows, insertCount: preview.insertCount, updateCount: preview.updateCount, skipCount: preview.skipCount, reviewCount: preview.reviewCount };
    const committed = await submitBill(config, sessionAndShop.session, sessionAndShop.shop, filePath, 'commit', sourceType);
    record.status = 'imported'; record.batchCode = committed.batchCode; record.message = committed.message;
    record.archivePath = filePath;
  } catch (error) {
    record.status = 'failed'; record.error = error.message || String(error); console.error(record.error); process.exitCode = 1;
  } finally {
    record.completedAt = new Date().toISOString();
    runLog.runs = [record, ...(runLog.runs || [])].slice(0, 90); writeJson(logPath, runLog);
    // This CDP browser belongs to the range runner. Detach without terminating
    // the shared Chrome process so the next data type can reuse the login.
    try { native.browser._connection?.close(); } catch (_) { /* no-op */ }
    if (!native.reused) try { native.process.kill(); } catch (_) { /* no-op */ }
  }
}
main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
