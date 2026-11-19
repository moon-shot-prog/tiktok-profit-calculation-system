/*
 * 打开测算系统登录页，捕获已登录的可刷新会话后交给 Windows DPAPI 加密保存。
 * When the operator elects to remember the password, the account and password
 * are retained only in the same DPAPI vault for 30 days so scheduled imports
 * can restore a lapsed session without manual input.
 */
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const scriptDirectory = __dirname;
const projectDirectory = path.resolve(scriptDirectory, '..');
const configPath = path.join(scriptDirectory, 'tiktok-automation.config.json');
const vaultExecutable = path.join(scriptDirectory, 'SystemAuthVault.exe');
const playwrightPath = path.join(projectDirectory, '.local-automation', 'node_modules', 'playwright-core');
// 默认直连本机服务；可由环境变量或本机自动化配置改为固定内网 IP / 内部域名。
const configuredSystemUrl = (() => {
  try { return JSON.parse(fs.readFileSync(configPath, 'utf8')).systemUrl; } catch (_) { return null; }
})();
const systemUrl = String(process.env.LOCAL_SYSTEM_URL || configuredSystemUrl || 'http://127.0.0.1:3000').replace(/\/$/, '');
const port = 19229;
const REMEMBER_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
const autoLogin = process.argv.includes('--auto-login');
const forceLogin = process.argv.includes('--force-login');

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function findChrome() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
  ];
  const chrome = candidates.find(candidate => fs.existsSync(candidate));
  if (!chrome) throw new Error('未找到 Google Chrome。');
  return chrome;
}

function writeStatus(rootDir, status, message) {
  const filePath = path.join(rootDir, '待处理', '系统管理员授权状态.json');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ status, message, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
}

function saveSession(rootDir, session) {
  const encoded = Buffer.from(JSON.stringify(session), 'utf8').toString('base64');
  const result = spawnSync(vaultExecutable, [
    'save', rootDir
  ], { encoding: 'utf8', windowsHide: true, input: encoded });
  if (result.status !== 0) throw new Error('无法安全保存系统授权，请重试。');
}

function readSession(rootDir) {
  const result = spawnSync(vaultExecutable, ['read', rootDir], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0 || !String(result.stdout || '').trim()) return null;
  try { return JSON.parse(Buffer.from(String(result.stdout).trim(), 'base64').toString('utf8')); } catch (_) { return null; }
}

function validRememberedCredentials(session) {
  const saved = session?.assistantCredentials;
  if (!saved?.identity || !saved?.password || Number(saved.expiresAt || 0) <= Date.now()) return null;
  return saved;
}

async function loginWithRememberedCredentials(page, credentials) {
  await page.waitForSelector('#account, #password', { timeout: 30000 });
  await page.locator('#account').fill(credentials.identity);
  await page.locator('#password').fill(credentials.password);
  const rememberMe = page.locator('#rememberMe');
  const rememberPassword = page.locator('#rememberPassword');
  if (await rememberMe.count()) await rememberMe.check({ force: true });
  if (await rememberPassword.count()) await rememberPassword.check({ force: true });
  await page.locator('#loginButton').click();
}

async function installCredentialCapture(context, accept, allowCredentialRemember) {
  // Receive values at the form event boundary so a fast navigation after
  // pressing Login cannot make the password field disappear before polling.
  await context.exposeBinding('__syncAssistantRememberedLogin', (_source, form) => accept(form));
  await context.addInitScript(allowRemember => {
    const readForm = () => ({
      identity: document.querySelector('#account')?.value || '',
      password: document.querySelector('#password')?.value || '',
      rememberPassword: Boolean(document.querySelector('#rememberPassword')?.checked),
      rememberMe: Boolean(document.querySelector('#rememberMe')?.checked)
    });
    const send = () => {
      const form = readForm();
      // --force-login is started only after the operator explicitly requests
      // 30-day credential retention from Sync Assistant. The web checkbox can
      // be reset by the page bootstrap, so do not let that UI race discard the
      // explicit assistant-level consent.
      if ((allowRemember || (form.rememberPassword && form.rememberMe)) && form.identity && form.password) {
        window.__syncAssistantRememberedLogin?.(form).catch(() => {});
      }
    };
    // The application's login request is the authoritative source. Capture it
    // before navigation, which also covers Chrome password auto-fill where no
    // input event is dispatched.
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      try {
        const url = typeof input === 'string' ? input : input?.url || '';
        if (/\/api\/auth\/login(?:$|[?#])/.test(url) && init?.body) {
          const body = JSON.parse(init.body);
          if ((allowRemember || (readForm().rememberPassword && readForm().rememberMe)) && body.identity && body.password) {
            window.__syncAssistantRememberedLogin?.({ identity: body.identity, password: body.password, rememberPassword: true, rememberMe: true }).catch(() => {});
          }
        }
      } catch (_) { /* Let the site's own login request continue normally. */ }
      return nativeFetch(input, init);
    };
    document.addEventListener('input', send, true);
    document.addEventListener('change', send, true);
    document.addEventListener('submit', send, true);
    document.addEventListener('click', event => { if (event.target?.closest?.('#loginButton')) send(); }, true);
  }, allowCredentialRemember);
}

async function connect(chromium, profilePath) {
  const chromeProcess = spawn(findChrome(), [
    `--user-data-dir=${profilePath}`,
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*', '--no-first-run', systemUrl
  ], { windowsHide: false });
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return { browser: await chromium.connectOverCDP(`http://127.0.0.1:${port}`), chromeProcess };
    } catch (_) { /* Chrome is starting. */ }
    await sleep(1000);
  }
  try { chromeProcess.kill(); } catch (_) { /* no-op */ }
  throw new Error('无法打开授权浏览器。请先关闭该店铺的专用 Chrome 窗口后再试。');
}

async function main() {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  // Keep this profile separate from shop download profiles. The shop profile is
  // often already open, which prevents Chrome from exposing a debugging port
  // for safe session capture.
  const profilePath = path.join(config.rootDir, '浏览器配置', 'TikTokShop系统授权');
  const priorSession = readSession(config.rootDir);
  const savedCredentials = validRememberedCredentials(priorSession);
  if (autoLogin && !savedCredentials) throw new Error('已保存的系统账号密码不存在或已超过 30 天，请在同步助手中点击“系统授权登录”重新授权。');
  writeStatus(config.rootDir, autoLogin ? 'restoring_login' : 'waiting_login', autoLogin ? '正在使用已安全保存的账号自动恢复系统登录。' : '请在已打开的测算系统页面完成管理员登录，并勾选“记住登录状态、记住密码”。');
  const { chromium } = require(playwrightPath);
  const native = await connect(chromium, profilePath);
  writeStatus(config.rootDir, 'checking_session', '浏览器已连接，正在读取系统登录状态。');
  const context = native.browser.contexts()[0];
  let capturedCredentials = null;
  await installCredentialCapture(context, form => {
    if ((forceLogin || (form?.rememberPassword && form?.rememberMe)) && form?.identity && form?.password) {
      capturedCredentials = { identity: form.identity, password: form.password, expiresAt: Date.now() + REMEMBER_DURATION_MS };
    }
  }, forceLogin);
  let page = context.pages().find(item => item.url().startsWith(systemUrl));
  if (!page) page = await context.newPage();
  if (!page.url().startsWith(systemUrl)) await page.goto(systemUrl, { waitUntil: 'domcontentloaded' });
  if (forceLogin) {
    // Re-authorisation must not silently reuse a stale local browser token.
    await page.evaluate(() => {
      localStorage.removeItem('tiktokShopAuthSession');
      sessionStorage.removeItem('tiktokShopAuthSession');
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    // This flow is launched only from the Sync Assistant's explicit
    // "re-authorise for 30 days" action. Preselect both opt-ins so the
    // operator's requested 30-day automation cannot be missed accidentally.
    await page.waitForSelector('#rememberMe, #rememberPassword', { timeout: 30000 });
    await page.evaluate(() => {
      for (const selector of ['#rememberMe', '#rememberPassword']) {
        const option = document.querySelector(selector);
        if (option && !option.checked) { option.checked = true; option.dispatchEvent(new Event('change', { bubbles: true })); }
      }
    });
  }
  if (autoLogin) await loginWithRememberedCredentials(page, savedCredentials);
  // The currently open page existed before addInitScript. Install the same
  // listener there as well; future navigations use the context init script.
  await page.evaluate(allowRemember => {
    const send = () => {
      const form = {
        identity: document.querySelector('#account')?.value || '', password: document.querySelector('#password')?.value || '',
        rememberPassword: Boolean(document.querySelector('#rememberPassword')?.checked), rememberMe: Boolean(document.querySelector('#rememberMe')?.checked)
      };
      if ((allowRemember || (form.rememberPassword && form.rememberMe)) && form.identity && form.password) window.__syncAssistantRememberedLogin?.(form).catch(() => {});
    };
    document.addEventListener('input', send, true); document.addEventListener('change', send, true);
    document.addEventListener('submit', send, true); document.addEventListener('click', event => { if (event.target?.closest?.('#loginButton')) send(); }, true);
  }, forceLogin).catch(() => {});
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      const form = await page.evaluate(() => ({
        identity: document.querySelector('#account')?.value || '',
        password: document.querySelector('#password')?.value || '',
        rememberPassword: Boolean(document.querySelector('#rememberPassword')?.checked),
        rememberMe: Boolean(document.querySelector('#rememberMe')?.checked)
      }));
      if ((forceLogin || (form.rememberPassword && form.rememberMe)) && form.identity && form.password) {
        capturedCredentials = { identity: form.identity, password: form.password, expiresAt: Date.now() + REMEMBER_DURATION_MS };
      }
      const text = await page.evaluate(() => localStorage.getItem('tiktokShopAuthSession') || sessionStorage.getItem('tiktokShopAuthSession') || '');
      const session = JSON.parse(text || '{}');
      if (session.accessToken && session.refreshToken) {
        // The login page can navigate immediately after submit. Give the
        // bound submit handler a moment to deliver the in-memory credentials.
        if (!capturedCredentials) await sleep(500);
        writeStatus(config.rootDir, 'saving', '登录已识别，正在安全保存系统授权。');
        const credentials = capturedCredentials || savedCredentials;
        saveSession(config.rootDir, credentials ? { ...session, assistantCredentials: credentials } : session);
        writeStatus(config.rootDir, 'ready', credentials ? '系统登录已安全保存，账号密码可自动登录至 30 天后。' : '系统管理员授权已安全保存。若需 30 天自动登录，请重新授权并勾选“记住登录状态、记住密码”。');
        return;
      }
    } catch (_) { /* Page can be navigating while the user signs in. */ }
    await sleep(1000);
  }
  throw new Error('5 分钟内未检测到系统登录，请重新点击“系统授权登录”。');
}

main().catch(error => {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    writeStatus(config.rootDir, 'failed', error.message || '系统授权失败。');
  } catch (_) { /* no-op */ }
  process.exitCode = 1;
});
