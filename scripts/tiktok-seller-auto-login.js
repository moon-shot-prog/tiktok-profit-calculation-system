/*
 * Ensure the selected Seller Center profile is signed in before a sync run.
 * Credentials are decrypted only by TikTokSyncAssistant.exe under the current
 * Windows user, then held in memory only for this Playwright invocation.
 */
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { dismissSellerPopups, settleSellerPopups } = require('./tiktok-popup-dismiss');

const scriptDirectory = __dirname;
const projectDirectory = path.resolve(scriptDirectory, '..');
const configPath = path.join(scriptDirectory, 'tiktok-automation.config.json');
const playwrightPath = path.join(projectDirectory, '.local-automation', 'node_modules', 'playwright-core');

function arg(name) { const index = process.argv.indexOf(name); return index < 0 ? null : process.argv[index + 1]; }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function readConfig() { return JSON.parse(fs.readFileSync(configPath, 'utf8')); }
function markLoginVerified(config, profileKey) {
  const mapping = (config.shopMappings || []).find(item => (item.profileKey || 'default') === profileKey);
  if (!mapping) return;
  mapping.verifiedAt = new Date().toISOString();
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}
function setManualVerificationState(config, profileKey, waiting) {
  const statePath = path.join(config.rootDir || '', '待处理', '同步助手状态.json');
  if (!config.rootDir || !fs.existsSync(statePath)) return;
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (state.status !== 'running') return;
    const store = (state.stores || []).find(item => (item.profileKey || 'default') === profileKey);
    if (!store) return;
    if (waiting) {
      store.login = { status: 'waiting_manual_verification', error: null };
      store.manualVerification = true;
      state.manualVerification = { profileKey, store: store.store, startedAt: new Date().toISOString() };
      state.message = `等待人工完成 TikTok 二次验证：${store.store}。验证通过后将自动继续同步。`;
    } else {
      delete store.manualVerification;
      if (state.manualVerification?.profileKey === profileKey) delete state.manualVerification;
      if (/等待人工完成 TikTok 二次验证/.test(String(state.message || ''))) state.message = `已完成二次验证，正在继续同步：${store.store}`;
    }
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
  } catch (_) { /* Status display must never interrupt the login session. */ }
}
function chromePath() {
  const candidates = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'];
  const result = candidates.find(file => fs.existsSync(file));
  if (!result) throw new Error('未找到 Google Chrome');
  return result;
}
function portFor(key) { return 19228 + [...String(key || 'default')].reduce((sum, value) => sum + value.charCodeAt(0), 0) % 1000; }
async function openBrowser(chromium, profilePath, profileKey) {
  const port = portFor(profileKey);
  // A sync run keeps this profile's native Chrome instance alive until all
  // modules have finished.  Reattach instead of trying to start a second
  // Chrome against the same profile (which is both slow and can lose state).
  try {
    if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) {
      return { browser: await chromium.connectOverCDP(`http://127.0.0.1:${port}`), chrome: null, reused: true };
    }
  } catch (_) { /* No reusable session is listening yet. */ }
  const chrome = spawn(chromePath(), [`--user-data-dir=${profilePath}`, `--remote-debugging-port=${port}`, '--remote-allow-origins=*', '--no-first-run', '--disable-popup-blocking', 'about:blank'], { windowsHide: false });
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return { browser: await chromium.connectOverCDP(`http://127.0.0.1:${port}`), chrome, reused: false }; } catch (_) { /* Chrome is starting. */ }
    await sleep(1000);
  }
  try { chrome.kill(); } catch (_) { /* no-op */ }
  throw new Error('Chrome 专用浏览器启动超时');
}
function loginScreen(text) { return /\b(log\s*in|sign\s*in)\b|登录|扫码登录/.test(String(text || '').toLowerCase()); }
async function verificationScreen(page, text) {
  if (/点击选中两个相同形状的物体|验证码|安全验证|二次验证|两步验证|身份验证|security verification|captcha|challenge|report a problem/i.test(String(text || ''))) return true;
  if (/captcha|verification|challenge|verify/i.test(String(page.url() || ''))) return true;
  // Some TikTok challenges are mounted entirely in a cross-origin iframe,
  // leaving no useful text in document.body.
  return (await page.locator('iframe[src*="captcha" i], iframe[src*="verify" i], iframe[title*="captcha" i], iframe[title*="verify" i]').count().catch(() => 0)) > 0;
}
function storeVisible(mapping, text) { return String(text || '').replace(/\s+/g, ' ').toLowerCase().includes(String(mapping.sellerCenterName || '').replace(/\s+/g, ' ').toLowerCase()); }
function credentials(profileKey) {
  const helper = path.join(scriptDirectory, 'TikTokCredentialBridge.exe');
  if (!fs.existsSync(helper)) throw new Error('未找到同步助手凭据组件，请重新安装同步助手。');
  const result = spawnSync(helper, ['--credentials', profileKey], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error('无法读取本机加密账号，请在“账号管理”中重新保存。');
  try { return JSON.parse(result.stdout || '{}'); } catch (_) { throw new Error('本机账号数据无法识别，请在“账号管理”中重新保存。'); }
}
async function firstVisible(locator) {
  for (let index = 0; index < await locator.count(); index += 1) if (await locator.nth(index).isVisible().catch(() => false)) return locator.nth(index);
  return null;
}
async function clickLoginEntry(page) {
  const buttons = page.getByRole('button', { name: /log\s*in|sign\s*in|登录/i });
  const button = await firstVisible(buttons);
  if (button) { await button.click({ force: true }); return; }
  const links = page.getByRole('link', { name: /log\s*in|sign\s*in|登录/i });
  const link = await firstVisible(links);
  if (link) await link.click({ force: true });
}
async function switchToEmailLogin(page) {
  // Seller Center defaults to mobile-number login on some regional sites.
  // All assistant accounts are email accounts, so switch first and never put
  // an email into the phone field.
  const exactEmail = page.getByText('使用邮箱登录', { exact: true });
  const emailOption = await firstVisible(exactEmail);
  if (emailOption) { await emailOption.click({ force: true }); await page.waitForTimeout(500); return; }
  const englishOption = await firstVisible(page.getByText(/use email|email login|sign in with email/i));
  if (englishOption) { await englishOption.click({ force: true }); await page.waitForTimeout(500); }
}
async function fillAndSubmit(page, value) {
  await clickLoginEntry(page).catch(() => {});
  await page.waitForTimeout(800);
  await switchToEmailLogin(page);
  const user = await firstVisible(page.locator('input[type="email"], input[name*="email" i], input[autocomplete="email"], input[autocomplete="username"], input[type="text"]'));
  const password = await firstVisible(page.locator('input[type="password"]'));
  if (!user || !password) throw new Error('未找到 TikTok Shop 的账号或密码输入框，请手动完成本次登录。');
  await user.fill(value.username);
  await password.fill(value.password);
  const submit = await firstVisible(page.getByRole('button', { name: /log\s*in|sign\s*in|登录|continue|继续/i }));
  if (submit) await submit.click({ force: true }); else await password.press('Enter');
}
async function openContinueTarget(page, continueUrl) {
  if (!continueUrl) return;
  const expected = new URL(continueUrl);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await page.goto(continueUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1200 * attempt);
    await settleSellerPopups(page, 1500);
    const current = new URL(page.url());
    // Ads redirects /ads-creation to /ads-creation/dashboard, while the
    // other modules preserve their path.  In both cases the target root must
    // be retained; homepage is never an acceptable completion state.
    if (current.origin === expected.origin && current.pathname.startsWith(expected.pathname)) return;
  }
  throw new Error(`登录成功后未能跳转到下载模块：${continueUrl}`);
}
function atContinueTarget(page, continueUrl) {
  if (!continueUrl) return false;
  try {
    const current = new URL(page.url()), expected = new URL(continueUrl);
    return current.origin === expected.origin && current.pathname.startsWith(expected.pathname);
  } catch (_) { return false; }
}
async function completeLogin(native, result) {
  // Do not await browser.close() here.  In a CDP-attached browser it can wait
  // indefinitely for a remote "disconnected" notification.  Promise.race
  // only stops waiting; it does not cancel the underlying socket, leaving the
  // one-shot login process alive and the runner stuck at “检查登录”.
  // Closing the Playwright connection itself is immediate and deliberately
  // leaves Chrome running for the next Order -> Bills -> Promotion step.
  try { native.browser._connection.close(); } catch (_) { /* no-op */ }
  // The orchestrators pass --keep-session.  Closing the CDP connection above
  // releases this child process while Chrome stays open for the immediately
  // following order, settled-bill, unsettled-bill and promotion steps.
  if (process.argv.includes('--keep-session')) {
    // A referenced child process would keep this one-shot login helper alive.
    // Chrome remains running, but the helper can now return control to the
    // runner so the first order export starts immediately.
    try { native.chrome?.unref(); } catch (_) { /* no-op */ }
  } else {
    try { if (native.chrome && !native.chrome.killed) native.chrome.kill(); } catch (_) { /* no-op */ }
  }
  console.log(JSON.stringify({ ...result, sessionOwner: Boolean(native.chrome && !native.reused) }));
}
async function main() {
  const config = readConfig();
  const profileKey = arg('--store') || 'default';
  const continueUrl = arg('--continue-url');
  const mapping = (config.shopMappings || []).find(item => (item.profileKey || 'default') === profileKey);
  if (!mapping) throw new Error('未找到指定店铺的本机自动化配置');
  const profilePath = profileKey === 'default' ? path.join(config.rootDir, '浏览器配置', 'TikTokShop下载助手') : path.join(config.rootDir, '浏览器配置', `TikTokShop下载助手-${profileKey}`);
  const { chromium } = require(playwrightPath);
  const native = await openBrowser(chromium, profilePath, profileKey);
  const page = native.browser.contexts()[0].pages()[0] || await native.browser.contexts()[0].newPage();
  await page.bringToFront().catch(() => {});
  // A sync run supplies its target module URL.  Go there directly so the
  // first visible page is Orders/Bills/Ads rather than the Seller Center home.
  await page.goto(continueUrl || config.sellerCenterUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2500);
  await settleSellerPopups(page, 5000);
  let text = await page.locator('body').innerText().catch(() => '');
  // The first navigation can show the Seller Center homepage before its
  // account card is hydrated.  Wait briefly for it instead of declaring the
  // run ready while the browser is still rendering the home shell.
  for (let attempt = 0; attempt < 12 && !storeVisible(mapping, text); attempt += 1) {
    await page.waitForTimeout(1000);
    await dismissSellerPopups(page);
    text = await page.locator('body').innerText().catch(() => '');
  }
  // Some Seller Center modules render the logged-in page before the account
  // name in the navbar.  A verified destination URL plus the absence of a
  // login form is sufficient evidence of a valid session; waiting only for
  // the delayed store label used to block the first run unnecessarily.
  if (!loginScreen(text) && (storeVisible(mapping, text) || atContinueTarget(page, continueUrl))) {
    await openContinueTarget(page, continueUrl);
    markLoginVerified(config, profileKey);
    await completeLogin(native, { status: 'reused_session', target: continueUrl || null });
    return;
  }
  const saved = credentials(profileKey);
  if (!saved.configured) throw new Error(`店铺“${mapping.sellerCenterName}”未在账号管理中保存账号密码，无法自动登录。`);
  await fillAndSubmit(page, saved);
  // Captcha / 2FA cannot be bypassed. Keep this visible Chrome profile open so
  // the operator can finish the challenge, but never log credentials.
  let verificationSeen = false;
  let waitingReported = false;
  for (let attempt = 0; ; attempt += 1) {
    await page.waitForTimeout(2000);
    await dismissSellerPopups(page);
    text = await page.locator('body').innerText().catch(() => '');
    const manualVerification = await verificationScreen(page, text);
    if (manualVerification) {
      verificationSeen = true;
      if (!waitingReported) {
        waitingReported = true;
        setManualVerificationState(config, profileKey, true);
        console.error('检测到 TikTok 二次验证，浏览器将保持打开。请人工完成验证，任务会自动继续。');
      }
      continue;
    }
    if (!loginScreen(text)) {
      try {
        await openContinueTarget(page, continueUrl);
        const targetText = await page.locator('body').innerText().catch(() => '');
        if (atContinueTarget(page, continueUrl) || storeVisible(mapping, targetText)) {
          setManualVerificationState(config, profileKey, false);
          markLoginVerified(config, profileKey);
          await completeLogin(native, { status: verificationSeen ? 'manual_verification_completed' : 'logged_in', target: continueUrl || null });
          return;
        }
      } catch (_) { /* TikTok can finish its redirect a few seconds later. */ }
    }
    // Normal failed submissions should still surface promptly.  A visible
    // verification challenge waits until the operator completes it; it never
    // times out and never closes the profile by itself.
    if (attempt >= 44) break;
  }
  throw new Error('已自动填写账号密码，但 TikTok Shop 未确认登录；请检查账号密码或完成二次验证后重新执行同步。');
}

main().catch(error => { console.error(error.message || error); process.exitCode = 1; });
