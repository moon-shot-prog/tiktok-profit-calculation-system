/*
 * TikTok Shop 本机下载运行器（准备阶段）
 *
 * 此脚本仅启动独立 Chrome 配置并打开 Seller Center：
 * - 登录状态只保留在本机目录；
 * - 下载目录固定为本机接收箱；
 * - 不提交表单、不修改店铺设置、不导入系统数据。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

const scriptDirectory = __dirname;
const projectDirectory = path.resolve(scriptDirectory, '..');
const configPath = path.join(scriptDirectory, 'tiktok-automation.config.json');
const exampleConfigPath = path.join(scriptDirectory, 'tiktok-automation.config.example.json');
const playwrightPath = path.join(projectDirectory, '.local-automation', 'node_modules', 'playwright-core');

function loadConfig() {
  if (!fs.existsSync(configPath)) fs.copyFileSync(exampleConfigPath, configPath);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!config.rootDir || !path.isAbsolute(config.rootDir)) throw new Error('rootDir 必须是本机绝对路径');
  if (!config.sellerCenterUrl || !/^https:\/\//i.test(config.sellerCenterUrl)) throw new Error('sellerCenterUrl 必须是 HTTPS 地址');
  return config;
}

function findChrome() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
  ];
  const chrome = candidates.find(candidate => fs.existsSync(candidate));
  if (!chrome) throw new Error('未找到 Google Chrome，请先安装 Chrome');
  return chrome;
}

async function main() {
  const setupMode = process.argv.includes('--setup');
  const checkMode = process.argv.includes('--check');
  const serveMode = process.argv.includes('--serve');
  if (!setupMode && !checkMode && !serveMode) throw new Error('请使用 --setup、--check 或 --serve');
  const config = loadConfig();
  const downloadsPath = path.join(config.rootDir, '接收箱');
  const profilePath = path.join(config.rootDir, '浏览器配置', 'TikTokShop下载助手');
  fs.mkdirSync(downloadsPath, { recursive: true });
  fs.mkdirSync(profilePath, { recursive: true });
  const { chromium } = require(playwrightPath);
  const context = await chromium.launchPersistentContext(profilePath, {
    executablePath: findChrome(),
    headless: false,
    acceptDownloads: true,
    downloadsPath,
    viewport: null
  });
  const page = context.pages()[0] || await context.newPage();
  async function verifiedActiveShop() {
    const pageText = await page.locator('body').innerText();
    const matches = (config.shopMappings || []).filter(mapping =>
      mapping.sellerCenterName && mapping.systemShopId && mapping.systemShopName && mapping.countryCode
      && pageText.includes(mapping.sellerCenterName)
    );
    if (matches.length !== 1) {
      throw new Error('无法唯一识别当前登录店铺；请先在本机自动化配置中补充该店铺映射');
    }
    const mapping = matches[0];
    return {
      id: mapping.systemShopId,
      name: mapping.systemShopName,
      countryCode: mapping.countryCode.toUpperCase()
    };
  }

  async function saveAutomationAssignment(outputPath) {
    const shop = await verifiedActiveShop();
    fs.writeFileSync(`${outputPath}.automation.json`, JSON.stringify({
      downloadedAt: new Date().toISOString(),
      shop
    }, null, 2), 'utf8');
    return shop;
  }
  await page.goto(config.sellerCenterUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  if (checkMode) {
    console.log(`当前地址：${page.url()}`);
    console.log(`页面标题：${await page.title()}`);
    await context.close();
    return;
  }
  if (serveMode) {
    const server = http.createServer(async (request, response) => {
      try {
      if (request.url === '/status') {
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({
          running: true,
          currentUrl: page.url(),
          pageTitle: await page.title(),
          profilePath,
          downloadsPath
        }, null, 2));
        return;
      }
      if (request.url === '/identity') {
        const pageText = await page.locator('body').innerText({ timeout: 15000 });
        const visibleLines = pageText
          .split(/\r?\n/)
          .map(line => line.trim())
          .filter(Boolean)
          .slice(0, 160);
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({
          currentUrl: page.url(),
          visibleLines
        }, null, 2));
        return;
      }
      if (request.url === '/links') {
        const links = await page.locator('a').evaluateAll(anchors => anchors
          .map(anchor => ({
            text: (anchor.innerText || '').trim(),
            href: anchor.href || ''
          }))
          .filter(link => link.text || link.href)
          .slice(0, 200));
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ currentUrl: page.url(), links }, null, 2));
        return;
      }
      if (request.url === '/controls') {
        const controls = await page.locator('button, [role="button"], a, input, select').evaluateAll(elements => elements
          .map(element => ({
            tag: element.tagName.toLowerCase(),
            text: (element.innerText || element.getAttribute('aria-label') || element.getAttribute('placeholder') || '').trim(),
            ariaLabel: element.getAttribute('aria-label') || '',
            title: element.getAttribute('title') || ''
          }))
          .filter(control => control.text || control.ariaLabel || control.title)
          .slice(0, 300));
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ currentUrl: page.url(), controls }, null, 2));
        return;
      }
      if (request.url === '/screenshot') {
        const screenshotPath = path.join(projectDirectory, '.local-automation', 'seller-center-current.png');
        await page.screenshot({ path: screenshotPath, fullPage: false });
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ screenshotPath }));
        return;
      }
      if (request.url && request.url.startsWith('/element-at')) {
        const url = new URL(request.url, 'http://127.0.0.1');
        const x = Number(url.searchParams.get('x'));
        const y = Number(url.searchParams.get('y'));
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ error: 'invalid_coordinates' }));
          return;
        }
        const elements = await page.evaluate(({ x, y }) => document.elementsFromPoint(x, y).slice(0, 8).map(element => ({
          tag: element.tagName.toLowerCase(),
          text: (element.innerText || '').trim().slice(0, 120),
          ariaLabel: element.getAttribute('aria-label') || '',
          title: element.getAttribute('title') || '',
          className: typeof element.className === 'string' ? element.className.slice(0, 200) : ''
        })), { x, y });
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ x, y, elements }, null, 2));
        return;
      }
      if (request.url === '/explore/orders' && request.method === 'POST') {
        const orderMenu = page.locator('.p-menu-item-header', { hasText: '订单' }).filter({ hasText: /^订单$/ });
        if (await orderMenu.count() !== 1) {
          response.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ error: 'order_menu_not_unique', count: await orderMenu.count() }));
          return;
        }
        await orderMenu.click();
        await page.waitForTimeout(500);
        const visibleText = await page.locator('body').innerText();
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({
          currentUrl: page.url(),
          orderMenuOpened: true,
          visibleLines: visibleText.split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(0, 120)
        }, null, 2));
        return;
      }
      if (request.url === '/explore/order-management' && request.method === 'POST') {
        await page.mouse.click(32, 230);
        await page.waitForTimeout(500);
        const managementItems = page.getByText('管理订单', { exact: true });
        let managementItem = null;
        for (let index = 0; index < await managementItems.count(); index += 1) {
          const candidate = managementItems.nth(index);
          if (await candidate.isVisible()) {
            managementItem = candidate;
            break;
          }
        }
        if (!managementItem) {
          response.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ error: 'order_management_not_visible', count: await managementItems.count() }));
          return;
        }
        await managementItem.click();
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const visibleText = await page.locator('body').innerText();
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({
          currentUrl: page.url(),
          visibleLines: visibleText.split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(0, 180)
        }, null, 2));
        return;
      }
      if (request.url === '/explore/order-filters' && request.method === 'POST') {
        if (!new URL(page.url()).pathname.startsWith('/order')) {
          const countryCode = config.shopMappings?.[0]?.countryCode || 'TH';
          await page.goto(new URL(`/order?shop_region=${encodeURIComponent(countryCode)}`, new URL(page.url()).origin).toString(), { waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(800);
        }
        const filterButton = page.getByRole('button', { name: /^筛选/ });
        if (await filterButton.count() !== 1) {
          response.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ error: 'filter_button_not_unique', count: await filterButton.count() }));
          return;
        }
        await filterButton.click();
        await page.waitForTimeout(500);
        const fields = await page.locator('input, textarea, select').evaluateAll(elements => elements.map(element => ({
          tag: element.tagName.toLowerCase(),
          type: element.getAttribute('type') || '',
          placeholder: element.getAttribute('placeholder') || '',
          value: element.value || '',
          ariaLabel: element.getAttribute('aria-label') || ''
        })));
        const visibleText = await page.locator('body').innerText();
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({
          currentUrl: page.url(),
          fields,
          visibleLines: visibleText.split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(0, 180)
        }, null, 2));
        return;
      }
      if (request.url && request.url.startsWith('/preview/orders') && request.method === 'POST') {
        const url = new URL(request.url, 'http://127.0.0.1');
        const start = url.searchParams.get('start') || '';
        const end = url.searchParams.get('end') || '';
        if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end) {
          response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ error: 'invalid_date_range' }));
          return;
        }
        if (!new URL(page.url()).pathname.startsWith('/order')) {
          const countryCode = config.shopMappings?.[0]?.countryCode || 'TH';
          await page.goto(new URL(`/order?shop_region=${encodeURIComponent(countryCode)}`, new URL(page.url()).origin).toString(), { waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(800);
        }
        let startInput = page.locator('input[placeholder="自"]');
        let endInput = page.locator('input[placeholder="至"]');
        if (await startInput.count() !== 1 || await endInput.count() !== 1) {
          const filterButton = page.getByRole('button', { name: /^筛选/ });
          if (await filterButton.count() !== 1) throw new Error('未找到唯一的订单筛选按钮');
          await filterButton.click();
          await page.waitForTimeout(400);
          startInput = page.locator('input[placeholder="自"]');
          endInput = page.locator('input[placeholder="至"]');
        }
        if (await startInput.count() !== 1 || await endInput.count() !== 1) throw new Error('未找到唯一的日期范围字段');
        await startInput.fill(start.replaceAll('-', '/'));
        await endInput.fill(end.replaceAll('-', '/'));
        await page.waitForTimeout(300);
        const buttons = await page.locator('button').allTextContents();
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({
          mode: 'filter_draft_only',
          start: await startInput.inputValue(),
          end: await endInput.inputValue(),
          availableActions: buttons.map(button => button.trim()).filter(Boolean).filter(button => /确定|确认|应用|筛选|重置|取消|导出/i.test(button))
        }, null, 2));
        return;
      }
      if (request.url === '/date-fields') {
        const fields = await page.locator('input[placeholder="自"], input[placeholder="至"]').evaluateAll(elements => elements.map(element => {
          const rect = element.getBoundingClientRect();
          return {
            placeholder: element.getAttribute('placeholder') || '',
            readOnly: element.readOnly,
            disabled: element.disabled,
            value: element.value,
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            className: typeof element.className === 'string' ? element.className : ''
          };
        }));
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ fields }, null, 2));
        return;
      }
      if (request.url === '/explore/order-calendar' && request.method === 'POST') {
        const startInput = page.locator('input[placeholder="自"]');
        if (await startInput.count() !== 1 || !await startInput.isVisible()) throw new Error('开始日期字段不可见');
        await startInput.click();
        await page.waitForTimeout(300);
        const visibleText = await page.locator('body').innerText();
        const calendarButtons = await page.locator('button').allTextContents();
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({
          visibleLines: visibleText.split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(0, 150),
          calendarButtons: calendarButtons.map(button => button.trim()).filter(Boolean).slice(0, 160)
        }, null, 2));
        return;
      }
      if (request.url === '/calendar-days') {
        const days = await page.evaluate(() => Array.from(document.querySelectorAll('body *'))
          .map(element => {
            const rect = element.getBoundingClientRect();
            return {
              text: (element.innerText || '').trim(),
              className: typeof element.className === 'string' ? element.className : '',
              role: element.getAttribute('role') || '',
              dataValue: element.getAttribute('data-value') || '',
              ariaLabel: element.getAttribute('aria-label') || '',
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height
            };
          })
          .filter(item => /^(01|02|03)$/.test(item.text) && item.x > 880 && item.y > 260 && item.width > 10 && item.height > 10)
          .slice(0, 30));
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ days }, null, 2));
        return;
      }
      if (request.url === '/draft/order-date-range' && request.method === 'POST') {
        const selectCurrentMonthDay = async day => {
          const candidates = page.locator('.p-picker-cell.p-picker-cell-in-view');
          for (let index = 0; index < await candidates.count(); index += 1) {
            const candidate = candidates.nth(index);
            const text = (await candidate.innerText()).trim();
            const className = await candidate.getAttribute('class') || '';
            const box = await candidate.boundingBox();
            if (text === String(day).padStart(2, '0') && !className.includes('disabled') && box && box.x < 1150) {
              await candidate.click();
              return;
            }
          }
          throw new Error(`当前月份未找到可选日期：${day}`);
        };
        await selectCurrentMonthDay(1);
        await page.waitForTimeout(250);
        await selectCurrentMonthDay(3);
        await page.waitForTimeout(250);
        const startInput = page.locator('input[placeholder="自"]');
        const endInput = page.locator('input[placeholder="至"]');
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({
          mode: 'filter_draft_only',
          start: await startInput.inputValue(),
          end: await endInput.inputValue(),
          applied: false,
          exported: false
        }, null, 2));
        return;
      }
      if (request.url === '/preview/apply-order-filter' && request.method === 'POST') {
        const startInput = page.locator('input[placeholder="自"]');
        const endInput = page.locator('input[placeholder="至"]');
        if (await startInput.inputValue() !== '2026-10-01' || await endInput.inputValue() !== '2026-10-03') {
          throw new Error('日期草稿与本次请求不一致，已拒绝应用筛选');
        }
        const applyButton = page.getByRole('button', { name: '应用', exact: true });
        if (await applyButton.count() !== 1) throw new Error('未找到唯一的筛选应用按钮');
        await applyButton.click();
        await page.waitForTimeout(1200);
        const pageText = await page.locator('body').innerText();
        const countMatch = pageText.match(/找到\s*(\d+)\s*个订单/) || pageText.match(/(\d+)\s*个订单/);
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({
          mode: 'order_preview',
          start: '2026-10-01',
          end: '2026-10-03',
          matchedOrderCount: countMatch ? Number(countMatch[1]) : null,
          exported: false,
          imported: false
        }, null, 2));
        return;
      }
      if (request.url === '/explore/all-orders' && request.method === 'POST') {
        const countryCode = config.shopMappings?.[0]?.countryCode || 'TH';
        await page.goto(new URL(`/order?shop_region=${encodeURIComponent(countryCode)}&tab=all`, new URL(page.url()).origin).toString(), { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1000);
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ currentUrl: page.url(), selectedTab: '全部' }, null, 2));
        return;
      }
      if (request.url === '/all-order-tab-elements') {
        const elements = await page.evaluate(() => Array.from(document.querySelectorAll('body *'))
          .filter(element => (element.innerText || '').trim() === '全部')
          .map(element => {
            const rect = element.getBoundingClientRect();
            return {
              tag: element.tagName.toLowerCase(),
              className: typeof element.className === 'string' ? element.className : '',
              role: element.getAttribute('role') || '',
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
              visible: Boolean(rect.width && rect.height)
            };
          }));
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ elements }, null, 2));
        return;
      }
      if (request.url === '/export/orders/open' && request.method === 'POST') {
        const currentUrl = new URL(page.url());
        const pageText = await page.locator('body').innerText();
        const hasExpectedRange = currentUrl.searchParams.get('tab') === 'all'
          && currentUrl.searchParams.getAll('time_order_created[]').length === 2;
        if (!hasExpectedRange || !pageText.includes('找到 183 个订单')) {
          throw new Error('当前页面不是已确认的 183 单完整订单预览，已拒绝导出');
        }
        const exportButton = page.getByRole('button', { name: '导出', exact: true });
        if (await exportButton.count() !== 1) throw new Error('未找到唯一的订单导出按钮');
        await exportButton.click();
        await page.waitForTimeout(500);
        const fields = await page.locator('input, textarea, select').evaluateAll(elements => elements.map(element => ({
          type: element.getAttribute('type') || '',
          placeholder: element.getAttribute('placeholder') || '',
          value: element.value || ''
        })));
        const visibleText = await page.locator('body').innerText();
        const buttons = await page.locator('button').allTextContents();
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({
          mode: 'export_dialog_open',
          fields,
          visibleLines: visibleText.split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(-100),
          buttons: buttons.map(button => button.trim()).filter(Boolean).slice(-80)
        }, null, 2));
        return;
      }
      if (request.url === '/export/orders/confirm' && request.method === 'POST') {
        const dialogText = await page.locator('body').innerText();
        if (!dialogText.includes('筛选出的订单 (183 笔订单)') || !dialogText.includes('CSV')) {
          throw new Error('导出范围或格式与确认内容不一致，已拒绝导出');
        }
        const buttons = page.getByRole('button', { name: '导出', exact: true });
        let exportButton = null;
        for (let index = 0; index < await buttons.count(); index += 1) {
          const candidate = buttons.nth(index);
          if (await candidate.isVisible()) {
            const box = await candidate.boundingBox();
            if (box && box.x > 900) {
              exportButton = candidate;
              break;
            }
          }
        }
        if (!exportButton) throw new Error('未找到导出面板内的确认按钮');
        const buttonState = await exportButton.evaluate(button => ({
          disabled: Boolean(button.disabled),
          ariaDisabled: button.getAttribute('aria-disabled'),
          text: button.innerText.trim()
        }));
        if (buttonState.disabled || buttonState.ariaDisabled === 'true') {
          throw new Error('导出确认按钮当前不可用，未提交导出');
        }
        const downloadResult = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
        await exportButton.scrollIntoViewIfNeeded();
        await exportButton.click({ force: true, timeout: 5000 });
        await page.waitForTimeout(1500);
        const download = await downloadResult;
        if (download) {
          const outputPath = path.join(downloadsPath, download.suggestedFilename());
          await download.saveAs(outputPath);
          const shop = await saveAutomationAssignment(outputPath);
          response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ status: 'downloaded', fileName: path.basename(outputPath), outputPath, shop }, null, 2));
          return;
        }
        await page.waitForTimeout(1000);
        const visibleText = await page.locator('body').innerText();
        response.writeHead(202, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({
          status: 'export_requested',
          visibleLines: visibleText.split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(-60)
        }, null, 2));
        return;
      }
      if (request.url === '/export/orders/download-latest' && request.method === 'POST') {
        const dialogText = await page.locator('body').innerText();
        const reportNames = dialogText.split(/\r?\n/)
          .map(line => line.trim())
          .filter(line => /^.+笔订单-.+\.(csv|xlsx)$/i.test(line));
        if (!reportNames.length) throw new Error('未找到可下载的订单导出文件');
        const downloadButtons = page.getByRole('button', { name: '下载', exact: true });
        let latestDownloadButton = null;
        let latestBox = null;
        for (let index = 0; index < await downloadButtons.count(); index += 1) {
          const candidate = downloadButtons.nth(index);
          if (!await candidate.isVisible()) continue;
          const box = await candidate.boundingBox();
          if (box && box.x > 900 && (!latestBox || box.y < latestBox.y)) {
            latestDownloadButton = candidate;
            latestBox = box;
          }
        }
        if (!latestDownloadButton) throw new Error('未找到导出历史中最新文件的下载按钮');
        const downloadResult = page.waitForEvent('download', { timeout: 20000 });
        await latestDownloadButton.click({ force: true, timeout: 5000 });
        const download = await downloadResult;
        const outputPath = path.join(downloadsPath, download.suggestedFilename());
        await download.saveAs(outputPath);
        const shop = await saveAutomationAssignment(outputPath);
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({
          status: 'downloaded',
          reportName: reportNames[0],
          fileName: path.basename(outputPath),
          outputPath,
          shop
        }, null, 2));
        return;
      }
      if (request.url === '/shutdown' && request.method === 'POST') {
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ shuttingDown: true }));
        server.close();
        await context.close();
        return;
      }
      response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: 'not_found' }));
      } catch (error) {
        response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: error.message }));
      }
    });
    await new Promise(resolve => server.listen(3077, '127.0.0.1', resolve));
    console.log('本机下载运行器已常驻启动：仅本机状态地址 http://127.0.0.1:3077/status');
    console.log(`当前地址：${page.url()}`);
    await new Promise(resolve => server.on('close', resolve));
    return;
  }
  console.log('已打开独立 TikTok Shop Chrome 配置。请在弹出的窗口完成登录；登录后保持窗口打开，并在 Codex 回复“自动化登录完成”。');
  console.log(`登录会话仅保存于：${profilePath}`);
  console.log(`下载文件将保存至：${downloadsPath}`);
  await new Promise(resolve => {
    const close = async () => {
      process.off('SIGINT', close);
      process.off('SIGTERM', close);
      await context.close();
      resolve();
    };
    process.on('SIGINT', close);
    process.on('SIGTERM', close);
  });
}

main().catch(error => {
  console.error(`TikTok 下载运行器启动失败：${error.message}`);
  process.exitCode = 1;
});
