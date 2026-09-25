const loginPage = document.querySelector('#loginPage');
const adminWorkspace = document.querySelector('#adminWorkspace');
const salesWorkspace = document.querySelector('#salesWorkspace');
const account = document.querySelector('#account');
const password = document.querySelector('#password');
const formMessage = document.querySelector('#formMessage');
const accountFormat = document.querySelector('#accountFormat');
const rememberMe = document.querySelector('#rememberMe');
const initializeArea = document.querySelector('#initializeArea');
const dialog = document.querySelector('#authDialog');
const dialogForm = document.querySelector('#dialogForm');
const dialogTitle = document.querySelector('#dialogTitle');
const dialogDescription = document.querySelector('#dialogDescription');
const dialogAccount = document.querySelector('#dialogAccount');
const dialogPassword = document.querySelector('#dialogPassword');
const dialogSubmit = document.querySelector('#dialogSubmit');
const dialogMessage = document.querySelector('#dialogMessage');
const AUTH_SESSION_KEY = 'tiktokShopAuthSession';
let dialogMode = '';
let currentWorkspaceRole = '';

function isEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); }
function isPhone(value) { return /^(?:\+?86)?1[3-9]\d{9}$/.test(value.replace(/[\s-]/g, '')); }
function validAccount(value) { return isEmail(value) || isPhone(value); }
function updateInitialization() { initializeArea.classList.add('is-hidden'); }

function describeAccount() {
  const value = account.value.trim();
  accountFormat.textContent = !value ? '系统将自动识别邮箱或手机号' : isEmail(value) ? '已识别为邮箱账号' : isPhone(value) ? '已识别为手机号账号' : '请输入有效的邮箱或手机号';
}
function enterWorkspace(role, user) {
  currentWorkspaceRole = role;
  loginPage.classList.add('is-hidden');
  const isSales = role === 'business_user';
  salesWorkspace.classList.toggle('is-hidden', !isSales);
  adminWorkspace.classList.toggle('is-hidden', isSales);
  if (!isSales) document.querySelector('#adminSuccess').textContent = '管理员跳转成功';
  if (isSales && user) {
    const name = user.displayName || user.email || user.phone || '业务员';
    document.querySelector('.account-name').childNodes[0].nodeValue = name;
    document.querySelector('.user-avatar').textContent = name.slice(0, 1).toUpperCase();
  }
  document.dispatchEvent(new CustomEvent('app:authenticated', { detail: { role, user } }));
  document.querySelector('#superWorkspaceSwitch')?.classList.toggle('is-hidden', role !== 'super_admin');
  document.querySelector('#superViewBadge')?.classList.toggle('is-hidden', role !== 'super_admin' || !isSales);
}
async function requestJson(url, body) {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(data.message || '请求失败，请稍后再试'); error.status = response.status; throw error; }
  return data;
}
function authSessionStorage() {
  if (localStorage.getItem(AUTH_SESSION_KEY)) return localStorage;
  if (sessionStorage.getItem(AUTH_SESSION_KEY)) return sessionStorage;
  return null;
}
function readAuthSession() {
  const storage = authSessionStorage();
  if (!storage) return null;
  try { return JSON.parse(storage.getItem(AUTH_SESSION_KEY) || 'null'); } catch { return null; }
}
function clearAuthSession() {
  localStorage.removeItem(AUTH_SESSION_KEY);
  sessionStorage.removeItem(AUTH_SESSION_KEY);
}
function storeAuthSession(session) {
  const target = rememberMe.checked ? localStorage : sessionStorage;
  clearAuthSession();
  target.setItem(AUTH_SESSION_KEY, JSON.stringify(session));
}
let refreshSessionPromise = null;
async function refreshAuthSession() {
  if (refreshSessionPromise) return refreshSessionPromise;
  const storage = authSessionStorage(); const current = readAuthSession();
  if (!storage || !current?.refreshToken) { const error = new Error('登录状态已失效，请重新登录'); error.status = 401; throw error; }
  refreshSessionPromise = requestJson('/api/auth/refresh', { refreshToken: current.refreshToken })
    .then(result => {
      const refreshed = { ...current, ...result.session, primaryRole: result.primaryRole, user: result.user };
      storage.setItem(AUTH_SESSION_KEY, JSON.stringify(refreshed));
      return refreshed;
    })
    .finally(() => { refreshSessionPromise = null; });
  return refreshSessionPromise;
}
async function authenticatedFetch(url, options = {}) {
  const send = async session => {
    const headers = new Headers(options.headers || {});
    headers.set('Authorization', `Bearer ${session?.accessToken || ''}`);
    return fetch(url, { ...options, headers });
  };
  let response = await send(readAuthSession());
  if (response.status !== 401) return response;
  try { response = await send(await refreshAuthSession()); } catch { /* Preserve the original 401 for the caller to render. */ }
  return response;
}
window.tiktokAuth = { getSession: readAuthSession, refreshSession: refreshAuthSession, fetch: authenticatedFetch };
async function login() {
  if (location.protocol === 'file:') {
    formMessage.textContent = '请通过 http://localhost:3000 打开系统，不能直接双击 index.html 登录。';
    return;
  }
  const identity = account.value.trim();
  if (!validAccount(identity)) return formMessage.textContent = '请输入有效的邮箱或手机号';
  if (!password.value) return formMessage.textContent = '请输入密码';
  const button = document.querySelector('#loginButton');
  button.disabled = true;
  formMessage.textContent = '正在安全登录…';
  try {
    const result = await requestJson('/api/auth/login', { identity, password: password.value });
    storeAuthSession({ ...result.session, primaryRole: result.primaryRole, user: result.user });
    document.dispatchEvent(new CustomEvent('business:promotion-cache-reset'));
    enterWorkspace(result.primaryRole, result.user);
  } catch (error) {
    formMessage.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}
function openDialog(mode) {
  dialogMode = mode; dialogAccount.value = ''; dialogPassword.value = ''; dialogMessage.textContent = '';
  dialogAccount.disabled = false;
  const copy = ['忘记密码', '输入已验证的邮箱后，系统将发送密码重置链接。手机号重置将在短信服务配置后开放。', '发送重置链接'];
  [dialogTitle.textContent, dialogDescription.textContent, dialogSubmit.textContent] = copy;
  dialogPassword.classList.add('is-hidden');
  dialogPassword.previousElementSibling.classList.add('is-hidden');
  dialog.showModal();
}

account.addEventListener('input', describeAccount);
document.querySelector('#togglePassword').addEventListener('click', event => {
  const revealed = password.type === 'text'; password.type = revealed ? 'password' : 'text';
  event.currentTarget.textContent = revealed ? '显示' : '隐藏'; event.currentTarget.setAttribute('aria-label', revealed ? '显示密码' : '隐藏密码');
});
document.querySelector('#loginButton').addEventListener('click', login);
document.querySelector('#initializeButton').addEventListener('click', () => window.alert('管理员已初始化；该入口已关闭。'));
document.querySelector('#forgotPassword').addEventListener('click', () => openDialog('reset'));
dialogForm.addEventListener('submit', async event => {
  event.preventDefault(); const identity = dialogAccount.value.trim();
  if (!validAccount(identity)) return dialogMessage.textContent = '请输入有效的邮箱或手机号';
  dialogSubmit.disabled = true;
  try {
    const result = await requestJson('/api/auth/password-reset', { identity, redirectTo: `${location.origin}${location.pathname}` });
    dialogMessage.textContent = result.message;
  } catch (error) {
    dialogMessage.textContent = error.message;
  } finally { dialogSubmit.disabled = false; }
});
document.querySelector('#inviteMember')?.addEventListener('click', () => window.alert('成员邀请将在管理后台接入 Supabase 后开放。当前请勿使用原型邀请链接。'));
document.querySelectorAll('.logout').forEach(button => button.addEventListener('click', () => {
  clearAuthSession();
  document.dispatchEvent(new CustomEvent('business:promotion-cache-reset'));
  adminWorkspace.classList.add('is-hidden'); salesWorkspace.classList.add('is-hidden'); loginPage.classList.remove('is-hidden'); password.value = '';
}));
document.querySelector('#enterBusinessWorkspace')?.addEventListener('click', () => {
  if (currentWorkspaceRole !== 'super_admin') return;
  adminWorkspace.classList.add('is-hidden'); salesWorkspace.classList.remove('is-hidden');
  document.querySelector('#superViewBadge')?.classList.remove('is-hidden');
  showDashboardPage?.();
});
function returnToAdminWorkspace() {
  if (currentWorkspaceRole !== 'super_admin') return;
  salesWorkspace.classList.add('is-hidden'); adminWorkspace.classList.remove('is-hidden');
  document.querySelector('#superViewBadge')?.classList.add('is-hidden');
}
document.querySelector('#enterAdminWorkspace')?.addEventListener('click', returnToAdminWorkspace);
document.querySelector('#returnAdminWorkspace')?.addEventListener('click', returnToAdminWorkspace);
updateInitialization();
if (location.protocol === 'file:') formMessage.textContent = '当前为文件预览模式。请在浏览器打开 http://localhost:3000 后登录。';
const remembered = readAuthSession();
if (remembered) {
  requestJson('/api/auth/session', { accessToken: remembered.accessToken })
    .then(result => enterWorkspace(result.primaryRole, result.user))
    .catch(async error => {
      // A stale access token is normal.  Refresh it once instead of forcing
      // users of protected order and settlement pages to log in again.
      if (error.status === 401) {
        try { const refreshed = await refreshAuthSession(); const result = await requestJson('/api/auth/session', { accessToken: refreshed.accessToken }); enterWorkspace(result.primaryRole, result.user); }
        catch (refreshError) { if (refreshError.status === 401 || refreshError.status === 403) clearAuthSession(); }
      }
      // Do not erase a valid local session merely because the service or
      // network has a short outage; the next protected request will retry it.
    });
}

const notificationButton = document.querySelector('#notificationButton');
const notificationPanel = document.querySelector('#notificationPanel');
const accountButton = document.querySelector('#accountButton');
const accountPanel = document.querySelector('#accountPanel');
function closeMenus() { notificationPanel?.classList.add('is-hidden'); accountPanel?.classList.add('is-hidden'); }
notificationButton?.addEventListener('click', event => { event.stopPropagation(); notificationPanel.classList.toggle('is-hidden'); accountPanel.classList.add('is-hidden'); });
accountButton?.addEventListener('click', event => { event.stopPropagation(); accountPanel.classList.toggle('is-hidden'); notificationPanel.classList.add('is-hidden'); });
document.querySelector('#markRead')?.addEventListener('click', () => { document.querySelector('.notification-button i')?.remove(); });
document.addEventListener('click', closeMenus);

const dashboardPage = document.querySelector('#dashboard');
const currencyPage = document.querySelector('#currencyPage');
const productsPage = document.querySelector('#productsPage');
const summaryPage = document.querySelector('#summaryPage');
const storesPage = document.querySelector('#storesPage');
const profitMain = document.querySelector('.profit-main');

// 这两个静态页面最初位于业务工作区外；归入统一主容器后与其它模块共享布局与可见状态。
[summaryPage, storesPage].forEach(page => {
  if (page && profitMain && page.parentElement !== profitMain) profitMain.append(page);
});
const shippingPage = document.createElement('main');
shippingPage.className = 'shipping-page is-hidden'; shippingPage.id = 'shippingPage';
shippingPage.innerHTML = '<div class="page-heading"><div><p class="eyebrow">SHIPPING</p><h1>仓库代发成本</h1><p>业务员仅可查看仓库代发费用及历史版本。</p></div><button class="shipping-history-button" id="shippingHistoryButton">代发费用修改记录</button></div><section class="shipping-filter"><label>仓库<select id="shippingWarehouseFilter"><option value="">全部仓库</option></select></label><button type="button" id="shippingSearch">查询</button></section><section class="shipping-card"><table><thead><tr><th>仓库</th><th>代发费用（每包裹）</th><th>上次费用（每包裹）</th><th>涨幅</th><th>费用更新时间</th><th>物流承运商</th></tr></thead><tbody id="shippingCostsBody"></tbody></table></section><p class="shipping-note">完整的新增、修改及操作权限统一在后续管理后台提供；业务员侧仅展示费用与只读版本记录。</p>';
document.querySelector('.profit-main')?.append(shippingPage);
shippingPage.querySelector('th:nth-child(2)').textContent = '代发费用';
shippingPage.querySelector('th:nth-child(3)').textContent = '上次费用';
const shippingNav = document.querySelector('a[href="#shipping"]');
shippingNav?.setAttribute('id', 'shippingExpand');
shippingNav?.setAttribute('aria-expanded', 'false');
shippingNav?.insertAdjacentHTML('beforeend', '<b class="shipping-arrow">⌃</b>');
shippingNav?.insertAdjacentHTML('afterend', '<div class="shipping-subnav is-hidden"><button type="button" id="warehouseCostNav">仓库代发成本</button></div>');
const ordersPage = document.createElement('main');
ordersPage.className = 'orders-page is-hidden'; ordersPage.id = 'ordersPage';
ordersPage.innerHTML = '<div class="page-heading"><div><p class="eyebrow">ORDERS</p><h1>订单明细表</h1><p>按商品行展示多 SKU 订单的分摊实付金额。</p></div></div><section class="order-filters" id="orderFilters"></section><section class="order-table-card"><table><thead><tr><th>店铺</th><th>国家站点</th><th>订单 ID</th><th>商品编码</th><th>SKU ID</th><th>商品数量</th><th>分摊实付金额</th><th>订单状态</th><th>退款状态 / 金额</th><th>仓库名称</th><th>快递单号</th><th>配送选项</th><th>物流承运商</th><th>下单日期</th><th>发货日期</th><th>完结状态</th><th>订单更新时间</th><th>物流状态</th><th>利润数据</th><th>详情</th></tr></thead><tbody id="ordersBody"></tbody></table><div class="product-pagination"><span id="ordersTotal"></span><label>每页<select id="ordersPageSize"><option value="20">20 条/页</option><option value="50">50 条/页</option><option value="100">100 条/页</option></select></label><div><button id="previousOrderPage" type="button">上一页</button><span id="orderPages"></span><button id="nextOrderPage" type="button">下一页</button></div></div></section><section id="settlementPage" class="settlement-placeholder is-hidden">结算单管理将汇总已完结订单的结算状态、费用调整与结算版本；完整审核和调整流程后续由管理后台处理。</section>';
document.querySelector('.profit-main')?.append(ordersPage);
const businessPromotionsPage = document.createElement('main');
businessPromotionsPage.className = 'business-promotions-page is-hidden'; businessPromotionsPage.id = 'businessPromotionsPage';
document.querySelector('.profit-main')?.append(businessPromotionsPage);
const ordersNav = document.querySelector('a[href="#orders"]');
ordersNav?.setAttribute('id', 'ordersExpand'); ordersNav?.setAttribute('aria-expanded', 'false'); ordersNav?.insertAdjacentHTML('beforeend', '<b class="order-arrow">⌃</b>');
ordersNav?.insertAdjacentHTML('afterend', '<div class="order-subnav is-hidden" id="orderSubnav"><button class="active" id="orderDetailNav">订单明细表</button><button id="settlementNav">结算单管理</button></div>');
function hideSalesPages() {
  [dashboardPage, currencyPage, productsPage, shippingPage, ordersPage, businessPromotionsPage, summaryPage, storesPage].forEach(page => page?.classList.add('is-hidden'));
}
function showCurrencyPage() {
  hideSalesPages();
  currencyPage?.classList.remove('is-hidden');
  document.querySelector('#topbarTitle').textContent = '汇率中心';
  document.querySelector('#reportCurrency').classList.remove('is-hidden');
  document.querySelector('#topbarSubtitle').classList.remove('is-hidden');
  document.querySelector('#topbarSubtitle').textContent = '统一管理实时参考与报表结算汇率';
  document.querySelectorAll('.profit-nav a').forEach(link => link.classList.toggle('active', link.getAttribute('href') === '#currency'));
  document.querySelector('#exchangeExpand')?.classList.add('active');
  loadBusinessSettlementRates().catch(() => {});
}
function showDashboardPage() {
  hideSalesPages();
  dashboardPage?.classList.remove('is-hidden');
  document.querySelector('#topbarTitle').textContent = 'TikTok Profit';
  document.querySelector('#reportCurrency').classList.add('is-hidden');
  document.querySelector('#topbarSubtitle').classList.add('is-hidden');
  document.querySelectorAll('.profit-nav a').forEach(link => link.classList.toggle('active', link.getAttribute('href') === '#dashboard'));
  document.querySelector('#exchangeExpand')?.classList.remove('active');
}
function showProductsPage() {
  hideSalesPages();
  productsPage?.classList.remove('is-hidden');
  document.querySelector('#topbarTitle').textContent = '商品管理';
  document.querySelector('#reportCurrency').classList.add('is-hidden');
  document.querySelector('#topbarSubtitle').classList.add('is-hidden');
  document.querySelector('#topbarSubtitle').textContent = '商品信息由管理员维护；如有疑问请提交反馈';
  document.querySelector('#topbarSubtitle').classList.remove('is-hidden');
  document.querySelector('#exchangeExpand')?.classList.remove('active');
  document.querySelectorAll('.profit-nav a').forEach(link => link.classList.toggle('active', link.getAttribute('href') === '#products'));
  loadBusinessProducts().catch(error => {
    const body = document.querySelector('#productsBody');
    if (body) body.innerHTML = `<tr><td colspan="8">${String(error.message || '无法读取商品数据')}</td></tr>`;
  });
}
function showShippingPage() {
  hideSalesPages(); shippingPage.classList.remove('is-hidden');
  document.querySelector('#topbarTitle').textContent = '运费管理'; document.querySelector('#reportCurrency').classList.add('is-hidden'); document.querySelector('#topbarSubtitle').textContent = '仓库代发成本'; document.querySelector('#topbarSubtitle').classList.remove('is-hidden'); document.querySelector('#exchangeExpand')?.classList.remove('active');
  document.querySelectorAll('.profit-nav a').forEach(link => link.classList.toggle('active', link.getAttribute('href') === '#shipping'));
  loadShippingCosts().catch(error => { document.querySelector('#shippingCostsBody').innerHTML = `<tr><td colspan="6">${String(error.message || '无法读取仓库代发成本')}</td></tr>`; });
}
function showOrdersPage(view = 'details') {
  hideSalesPages(); ordersPage.classList.remove('is-hidden');
  document.querySelector('#topbarTitle').textContent = view === 'details' ? '订单明细表' : '结算单管理'; document.querySelector('#reportCurrency').classList.add('is-hidden'); document.querySelector('#topbarSubtitle').textContent = view === 'details' ? '按商品行展示多 SKU 订单的分摊实付金额' : '结算单管理'; document.querySelector('#topbarSubtitle').classList.remove('is-hidden');
  document.querySelector('#settlementPage').classList.toggle('is-hidden', view === 'details'); document.querySelector('.order-table-card').classList.toggle('is-hidden', view !== 'details'); document.querySelector('#orderFilters').classList.toggle('is-hidden', view !== 'details');
  document.querySelectorAll('.order-subnav button').forEach(button => button.classList.toggle('active', (view === 'details' && button.id === 'orderDetailNav') || (view === 'settlement' && button.id === 'settlementNav')));
  document.querySelectorAll('.profit-nav a').forEach(link => link.classList.toggle('active', link.getAttribute('href') === '#orders'));
  document.dispatchEvent(new CustomEvent('sales:navigate', { detail: { route: '#orders', view } }));
}
function showBusinessPromotionsPage() {
  hideSalesPages(); businessPromotionsPage.classList.remove('is-hidden');
  document.querySelector('#topbarTitle').textContent = '推广管理'; document.querySelector('#reportCurrency').classList.add('is-hidden'); document.querySelector('#topbarSubtitle').textContent = '查看已授权店铺的推广费用、订单与收入数据（只读）'; document.querySelector('#topbarSubtitle').classList.remove('is-hidden'); document.querySelector('#exchangeExpand')?.classList.remove('active');
  document.querySelectorAll('.profit-nav a').forEach(link => link.classList.toggle('active', link.getAttribute('href') === '#promotions'));
  document.dispatchEvent(new CustomEvent('sales:navigate', { detail: { route: '#promotions' } }));
}
function navigateSalesPage(route) {
  if (route === '#summary' || route === '#shops') {
    hideSalesPages();
    document.dispatchEvent(new CustomEvent('sales:navigate', { detail: { route } }));
    return;
  }
  if (route === '#dashboard') return showDashboardPage();
  if (route === '#currency') return showCurrencyPage();
  if (route === '#products') return showProductsPage();
  if (route === '#promotions') return showBusinessPromotionsPage();
  if (route === '#shipping') {
    showShippingPage();
    const subnav = document.querySelector('.shipping-subnav');
    const expanded = shippingNav?.getAttribute('aria-expanded') === 'true';
    shippingNav?.setAttribute('aria-expanded', String(!expanded));
    subnav?.classList.toggle('is-hidden', expanded);
    return;
  }
  if (route === '#orders') {
    showOrdersPage();
    const subnav = document.querySelector('#orderSubnav');
    const expanded = ordersNav?.getAttribute('aria-expanded') === 'true';
    ordersNav?.setAttribute('aria-expanded', String(!expanded));
    subnav?.classList.toggle('is-hidden', expanded);
  }
}

// 在捕获阶段统一处理模块跳转，避免任何页面依赖其它导航监听器的注册顺序。
document.addEventListener('click', event => {
  const link = event.target.closest('a[href]');
  const route = link?.getAttribute('href');
  if (!['#dashboard', '#summary', '#orders', '#promotions', '#products', '#shipping', '#currency', '#shops'].includes(route)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  navigateSalesPage(route);
}, true);
document.querySelector('#warehouseCostNav')?.addEventListener('click', showShippingPage);
document.querySelector('#orderDetailNav')?.addEventListener('click', () => showOrdersPage('details'));
document.querySelector('#settlementNav')?.addEventListener('click', () => showOrdersPage('settlement'));
ordersNav?.addEventListener('click', () => { const child = document.querySelector('#orderSubnav'); const expanded = ordersNav.getAttribute('aria-expanded') === 'true'; ordersNav.setAttribute('aria-expanded', String(!expanded)); child.classList.toggle('is-hidden', expanded); });
shippingNav?.addEventListener('click', () => {
  const subnav = document.querySelector('.shipping-subnav');
  const expanded = shippingNav.getAttribute('aria-expanded') === 'true';
  shippingNav.setAttribute('aria-expanded', String(!expanded));
  subnav.classList.toggle('is-hidden', expanded);
});
document.querySelectorAll('[data-exchange-tab]').forEach(button => button.addEventListener('click', () => {
  showCurrencyPage();
  const isLive = button.dataset.exchangeTab === 'live';
  document.querySelector('#liveRates').classList.toggle('is-hidden', !isLive);
  document.querySelector('#settlementRates').classList.toggle('is-hidden', isLive);
  document.querySelectorAll('[data-exchange-tab]').forEach(tab => tab.classList.toggle('active', tab === button));
}));
document.querySelector('#exchangeExpand')?.addEventListener('click', event => {
  showCurrencyPage();
  const children = document.querySelector('#exchangeChildren');
  const expanded = event.currentTarget.getAttribute('aria-expanded') === 'true';
  event.currentTarget.setAttribute('aria-expanded', String(!expanded));
  children.classList.toggle('is-hidden', expanded);
});
const versionsDialog = document.querySelector('#versionsDialog');
document.querySelector('#versionButton')?.addEventListener('click', async () => {
  await loadBusinessSettlementRates().catch(() => {});
  versionsDialog.showModal();
});
document.querySelector('#closeVersions')?.addEventListener('click', () => versionsDialog.close());

const referenceButton = document.querySelector('#referenceRefreshButton');
const referenceMeta = document.querySelector('#referenceMeta');
const refreshMessage = document.querySelector('#refreshMessage');
let refreshFailure = document.querySelector('#refreshFailure');
if (!refreshFailure) {
  refreshFailure = document.createElement('div');
  refreshFailure.id = 'refreshFailure';
  refreshFailure.className = 'refresh-failure is-hidden';
  refreshFailure.setAttribute('role', 'alert');
  refreshFailure.innerHTML = '<strong>刷新失败，请稍后重试</strong><span id="refreshFailureReason"></span>';
  document.querySelector('#liveRates')?.append(refreshFailure);
}
const refreshFailureReason = document.querySelector('#refreshFailureReason');
const quoteCurrency = document.querySelector('#quoteCurrency');
const API_BASE = window.location.protocol === 'file:' ? 'http://127.0.0.1:3000' : '';
const REFERENCE_REFRESH_MS = 3 * 60 * 60 * 1000;
const MANUAL_COOLDOWN_MS = 10 * 60 * 1000;
let referenceRefreshTimer;
let referenceRefreshing = false;

function formatReferenceTime(date = new Date()) {
  return date.toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');
}
function setReferenceStatus(state, failureTime = '') {
  document.querySelectorAll('[data-status]').forEach(status => {
    status.textContent = state;
    status.className = `data-status ${state === '实时' ? 'realtime' : state === '延迟' ? 'delayed' : 'failed'}`;
  });
  if (failureTime) refreshMessage.textContent = `刷新失败，请稍后重试（失败时间：${failureTime}）`;
}
function scheduleReferenceRefresh() {
  clearTimeout(referenceRefreshTimer);
  referenceRefreshTimer = setTimeout(() => requestReferenceRates(false), REFERENCE_REFRESH_MS);
}
function updateReferenceMeta(successTime, nextTime, source = 'Frankfurter v2 / ECB') {
  referenceMeta.textContent = `${source} · 最近更新时间：${formatReferenceTime(successTime)} · 下次自动刷新：${new Date(nextTime || successTime.getTime() + REFERENCE_REFRESH_MS).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}`;
}
function renderReferenceRates(rates) {
  const body = document.querySelector('#referenceRatesBody');
  if (!body) return;
  body.innerHTML = rates.map(item => {
    if (!item.available) return `<tr><td>${item.pair.replace('/', ' / ')}</td><td colspan="5" class="no-reference-rate">暂无可用参考汇率</td><td><span class="data-status failed">刷新失败</span></td></tr>`;
    const change = item.change === null ? '—' : `${item.change >= 0 ? '+' : ''}${item.change.toFixed(2)}%`;
    const changeClass = item.change === null ? '' : item.change >= 0 ? 'positive' : 'negative';
    return `<tr><td>${item.pair.replace('/', ' / ')}</td><td>${Number(item.rate).toFixed(4)}</td><td>${item.previousRate === null ? '—' : Number(item.previousRate).toFixed(4)}</td><td class="${changeClass}">${change}</td><td>Frankfurter v2 / ECB</td><td>${item.rateDate || '—'}</td><td><span class="data-status realtime">实时</span></td></tr>`;
  }).join('');
}
let businessSettlementRates = [];
let businessSettlementVersions = [];
const settlementRateToken = () => { try { return JSON.parse(localStorage.getItem(AUTH_SESSION_KEY) || sessionStorage.getItem(AUTH_SESSION_KEY) || '{}').accessToken; } catch { return null; } };
const settlementStatusLabel = status => ({ active: '生效中', pending: '未生效', expired: '已失效', deactivated: '已作废' })[status] || status || '尚未设置';
const settlementStatusClass = status => status === 'active' ? 'active-status' : status === 'pending' ? 'pending-status' : 'void-status';
const settlementShortDate = value => value ? new Date(value).toLocaleDateString('zh-CN').replaceAll('/', '-') : '—';
const settlementDateTime = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }).replaceAll('/', '-') : '—';
const escapeSettlementText = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
function renderSettlementRates(quote) {
  const bases = quote === 'CNY' ? ['THB', 'MYR', 'VND', 'PHP', 'IDR', 'USD'] : ['THB', 'MYR', 'VND', 'PHP', 'IDR', 'CNY'];
  const body = document.querySelector('#settlementRates tbody');
  const headers = document.querySelector('#settlementRates thead tr');
  if (!body || !headers) return;
  headers.innerHTML = '<th>基准货币 / 汇率货币</th><th>结算汇率</th><th>生效日期</th><th>备注</th><th>更新时间</th><th>状态</th>';
  body.innerHTML = bases.map(base => {
    const pair = businessSettlementRates.filter(rate => rate.base_currency === base && rate.quote_currency === quote);
    const rate = pair.find(item => item.status === 'active') || pair.filter(item => item.status === 'pending').sort((left, right) => left.effective_date.localeCompare(right.effective_date))[0];
    if (!rate) return `<tr><td>${base} / ${quote}</td><td>—</td><td>—</td><td>尚未设置</td><td>—</td><td><span class="status void-status">尚未设置</span></td></tr>`;
    return `<tr><td>${base} / ${quote}</td><td>${Number(rate.settlement_rate).toFixed(6)}</td><td>${settlementShortDate(rate.effective_date)}</td><td>${escapeSettlementText(rate.note || '—')}</td><td>${settlementDateTime(rate.updated_at)}</td><td><span class="status ${settlementStatusClass(rate.status)}">${settlementStatusLabel(rate.status)}</span></td></tr>`;
  }).join('');
  const versionBody = document.querySelector('#versionsDialog tbody');
  const versionHeaders = document.querySelector('#versionsDialog thead tr');
  if (versionHeaders) versionHeaders.innerHTML = '<th>货币对</th><th>操作</th><th>结算汇率</th><th>更新时间</th><th>备注</th>';
  if (versionBody) {
    const matchingIds = new Set(businessSettlementRates.filter(rate => rate.quote_currency === quote).map(rate => rate.id));
    const rows = businessSettlementVersions.filter(version => matchingIds.has(version.rate_id));
    versionBody.innerHTML = rows.map(version => { const current = version.current_data || {}; const before = version.previous_data || {}; const rate = current.settlement_rate ?? before.settlement_rate; const formattedRate = rate === null || rate === undefined ? '—' : Number(rate).toFixed(6); return `<tr><td>${escapeSettlementText(`${current.base_currency || before.base_currency || '—'} / ${current.quote_currency || before.quote_currency || '—'}`)}</td><td>${({ created: '新增', updated: '修改', deactivated: '作废' })[version.action] || version.action}</td><td>${formattedRate}</td><td>${settlementDateTime(version.created_at)}</td><td>${escapeSettlementText(current.note || before.note || '—')}</td></tr>`; }).join('') || '<tr><td colspan="5">暂无版本记录</td></tr>';
  }
}
async function loadBusinessSettlementRates() {
  const token = settlementRateToken();
  if (!token) return;
  const response = await fetch(`${API_BASE}/api/business/settlement-rates`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || '无法读取报表结算汇率');
  businessSettlementRates = data.rates || []; businessSettlementVersions = data.versions || [];
  renderSettlementRates(quoteCurrency?.value || 'CNY');
}
async function requestReferenceRates(isManual, forceRefresh = false) {
  if (referenceRefreshing) return;
  const lastManual = Number(localStorage.getItem('lastReferenceManualRefresh') || 0);
  const remaining = MANUAL_COOLDOWN_MS - (Date.now() - lastManual);
  if (isManual && remaining > 0) {
    refreshMessage.textContent = `为避免重复请求，请在 ${Math.ceil(remaining / 60000)} 分钟后再手动刷新。`;
    return;
  }
  referenceRefreshing = true;
  if (!isManual) setReferenceStatus('延迟');
  referenceButton.disabled = true;
  referenceButton.textContent = '正在刷新…';
  refreshMessage.textContent = '正在向公开汇率服务请求最新数据…';
  try {
    const currentQuote = quoteCurrency?.value || 'CNY';
    const response = await fetch(`${API_BASE}/api/reference-rates?currency=${currentQuote}`, { method: isManual || forceRefresh ? 'POST' : 'GET' });
    if (!response.ok) throw new Error('reference-service-error');
    const data = await response.json();
    if (!data.rates?.length) throw new Error('reference-data-incomplete');
    const refreshedAt = new Date(data.updatedAt || Date.now());
    renderReferenceRates(data.rates);
    if (isManual) localStorage.setItem('lastReferenceManualRefresh', String(Date.now()));
    setReferenceStatus(data.status || '实时');
    updateReferenceMeta(refreshedAt, data.nextRefreshAt, data.source);
    refreshMessage.textContent = '参考汇率已刷新；本次操作未改动结算汇率或历史订单利润。';
    refreshFailure.classList.add('is-hidden');
    scheduleReferenceRefresh();
  } catch (error) {
    const failedAt = formatReferenceTime();
    const reason = error instanceof TypeError ? '无法连接公开汇率服务，请检查网络后重试。' : error.message === 'reference-data-incomplete' ? '公开汇率服务返回的数据不完整，上一份有效汇率已保留。' : '公开汇率服务暂时不可用，上一份有效汇率已保留。';
    setReferenceStatus('刷新失败', failedAt);
    referenceMeta.textContent = `${referenceMeta.textContent.split(' · 下次自动刷新')[0]} · 最近失败时间：${failedAt}`;
    refreshFailureReason.textContent = `失败时间：${failedAt}；失败原因：${reason}`;
    refreshFailure.classList.remove('is-hidden');
    scheduleReferenceRefresh();
  } finally {
    referenceRefreshing = false;
    referenceButton.disabled = false;
    referenceButton.textContent = '↻ 刷新参考汇率';
  }
}
referenceButton?.addEventListener('click', () => requestReferenceRates(true));
quoteCurrency?.addEventListener('change', () => {
  loadBusinessSettlementRates().catch(() => {});
  requestReferenceRates(false, true);
});
if (referenceButton) { renderSettlementRates(quoteCurrency?.value || 'CNY'); requestReferenceRates(false); }
document.querySelector('.admin-action')?.remove();
const settlementHint = document.querySelector('.settlement-toolbar p');
if (settlementHint) settlementHint.textContent = '报表结算汇率用于利润计算；历史订单始终按下单日期锁定的结算汇率计算。';

const warehouseNames = ['跨境仓', '菲律宾本土', '印尼本土', '越南亚达', '越南904千易', '越南908千易', '泰国本土'];
let productCatalog = [];
let productWarehouses = [];
let productFilterWarehouses = [];
const productToken = () => { try { return JSON.parse(localStorage.getItem(AUTH_SESSION_KEY) || sessionStorage.getItem(AUTH_SESSION_KEY) || '{}').accessToken; } catch { return null; } };
const escapeProductText = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const productShortDate = value => value ? new Date(value).toLocaleDateString('zh-CN').replaceAll('/', '-') : '—';
function setProductWarehouseOptions() {
  const filter = document.querySelector('#warehouseFilter');
  if (!filter) return;
  const selected = filter.value;
  filter.innerHTML = '<option value="">所有仓库</option>' + productFilterWarehouses.map(warehouse => `<option value="${escapeProductText(warehouse.id)}">${escapeProductText(warehouse.name)}</option>`).join('');
  filter.value = productFilterWarehouses.some(warehouse => warehouse.id === selected) ? selected : '';
}
async function loadBusinessProducts() {
  const headers = { Authorization: `Bearer ${productToken()}` };
  const [response, costsResponse] = await Promise.all([
    fetch('/api/business/products', { headers }),
    fetch('/api/business/warehouse-costs', { headers })
  ]);
  const [data, costsData] = await Promise.all([response.json().catch(() => ({})), costsResponse.json().catch(() => ({}))]);
  if (!response.ok) throw new Error(data.message || '无法读取商品数据');
  productWarehouses = data.warehouses || [];
  productFilterWarehouses = costsResponse.ok ? (costsData.costs || []).map(item => item.warehouse) : productWarehouses;
  productCatalog = (data.products || []).map(item => ({ id: item.id, sku: item.product_code, name: item.product_name, price: Number(item.sale_price), currency: item.currency_code, warehouseId: item.warehouse_id, warehouse: productWarehouses.find(warehouse => warehouse.id === item.warehouse_id)?.name || '—', imageUrl: item.image_url, updatedAt: String(item.updated_at || '').slice(0, 10), status: '可用', costAvailable: true }));
  setProductWarehouseOptions(); renderProducts();
}
let productPage = 1;
function filteredProducts() {
  const warehouse = document.querySelector('#warehouseFilter')?.value || '';
  const sku = document.querySelector('#skuFilter')?.value.trim().toLowerCase() || '';
  const name = document.querySelector('#productNameFilter')?.value.trim().toLowerCase() || '';
  const start = document.querySelector('#updatedStart')?.value || '';
  const end = document.querySelector('#updatedEnd')?.value || '';
  const status = document.querySelector('#productStatusFilter')?.value || '';
  return productCatalog.filter(product => (!warehouse || product.warehouseId === warehouse) && (!sku || product.sku.toLowerCase().includes(sku)) && (!name || product.name.toLowerCase().includes(name)) && (!start || product.updatedAt >= start) && (!end || product.updatedAt <= end) && (!status || product.status === status));
}
const productFilters = document.querySelector('.product-filters');
if (productFilters && !document.querySelector('#updatedStart')) {
  const updatedFilter = document.createElement('label');
  updatedFilter.className = 'updated-range';
  updatedFilter.innerHTML = '更新时间<span><input id="updatedStart" type="date" aria-label="开始日期" /> - <input id="updatedEnd" type="date" aria-label="结束日期" /></span>';
  productFilters.insertBefore(updatedFilter, productFilters.querySelector('.filter-buttons'));
}
if (productFilters && !document.querySelector('#productStatusFilter')) {
  const statusFilter = document.createElement('label');
  statusFilter.innerHTML = '状态<select id="productStatusFilter"><option value="">全部</option><option value="可用">可用</option></select>';
  productFilters.insertBefore(statusFilter, productFilters.querySelector('.filter-buttons'));
  const operationBar = document.createElement('div');
  operationBar.className = 'product-operation-bar';
  operationBar.innerHTML = '<span>商品资料由管理员维护；业务员可查看、导出和提交反馈。</span><div><button type="button" id="productExport">导出</button></div>';
  productFilters.after(operationBar);
}
function renderProducts() {
  const body = document.querySelector('#productsBody');
  if (!body) return;
  document.querySelector('.product-table-card thead tr').innerHTML = '<th>商品图片</th><th>商品编码 <b class="required">*</b></th><th>商品名称 <b class="required">*</b></th><th>商品单价 <b class="required">*</b></th><th>仓库</th><th>更新时间</th><th>状态</th><th>反馈</th>';
  const products = filteredProducts();
  const pageSize = Number(document.querySelector('#productPageSize').value);
  const pageCount = Math.max(1, Math.ceil(products.length / pageSize));
  productPage = Math.min(productPage, pageCount);
  const visible = products.slice((productPage - 1) * pageSize, productPage * pageSize);
  body.innerHTML = visible.length ? visible.map(product => `<tr><td>${product.imageUrl ? `<img class="product-image" src="${escapeProductText(product.imageUrl)}" alt="${escapeProductText(product.name)}" />` : '<span class="product-image">▧</span>'}</td><td>${escapeProductText(product.sku)}</td><td>${escapeProductText(product.name)}</td><td><strong>${escapeProductText(product.currency || 'CNY')} ${Number(product.price).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong></td><td>${escapeProductText(product.warehouse)}</td><td>${productShortDate(product.updatedAt)}</td><td><span class="product-status ${product.status}">${product.status}</span></td><td><button class="feedback-product" data-sku="${escapeProductText(product.sku)}">反馈</button></td></tr>`).join('') : '<tr><td colspan="8">暂无可用商品。请联系管理员维护商品，或确认店铺已关联仓库。</td></tr>';
  document.querySelector('#productTotal').textContent = `共 ${products.length} 条`;
  document.querySelector('#previousProductPage').disabled = productPage === 1;
  document.querySelector('#nextProductPage').disabled = productPage === pageCount;
  document.querySelector('#productPages').innerHTML = Array.from({ length: pageCount }, (_, index) => `<button class="page-number ${index + 1 === productPage ? 'active' : ''}" data-product-page="${index + 1}">${index + 1}</button>`).join('');
}
document.querySelector('#productSearch')?.addEventListener('click', () => { productPage = 1; renderProducts(); });
document.querySelector('#productReset')?.addEventListener('click', () => { document.querySelector('#warehouseFilter').value = ''; document.querySelector('#skuFilter').value = ''; document.querySelector('#productNameFilter').value = ''; document.querySelector('#updatedStart').value = ''; document.querySelector('#updatedEnd').value = ''; document.querySelector('#productStatusFilter').value = ''; productPage = 1; renderProducts(); });
document.querySelector('#productPageSize')?.addEventListener('change', () => { productPage = 1; renderProducts(); });
document.querySelector('#previousProductPage')?.addEventListener('click', () => { productPage -= 1; renderProducts(); });
document.querySelector('#nextProductPage')?.addEventListener('click', () => { productPage += 1; renderProducts(); });
document.querySelector('#productPages')?.addEventListener('click', event => { const page = event.target.dataset.productPage; if (page) { productPage = Number(page); renderProducts(); } });
document.querySelector('#productsBody')?.addEventListener('click', event => { const sku = event.target.dataset.sku; if (sku) openProductFeedback(sku); });
renderProducts();
productsPage?.querySelector('.page-heading')?.remove();

const FEEDBACK_KEY = 'tiktokShopProductFeedbacks';
const feedbackDialog = document.createElement('dialog');
feedbackDialog.className = 'product-feedback-dialog';
feedbackDialog.innerHTML = '<form id="productFeedbackForm"><button class="dialog-close" type="button" data-close-feedback aria-label="关闭">×</button><h2>商品信息反馈</h2><div class="feedback-grid"><label>反馈编号<input id="feedbackId" readonly /></label><label>商品编码<input id="feedbackSku" readonly /></label><label class="wide">商品名称<input id="feedbackName" readonly /></label><label>问题项<select id="feedbackIssue"><option>价格问题</option><option>仓库问题</option><option>编码问题</option></select></label><label>状态<input value="待处理" readonly /></label><label class="wide">具体反馈内容<textarea id="feedbackContent" required placeholder="请说明需要管理员协助处理的问题"></textarea></label></div><p class="feedback-tip">提交后会记录商品编码、仓库、提交人、提交时间与反馈内容，并同步到管理后台的“商品反馈”列表。</p><div class="feedback-actions"><button type="button" data-close-feedback>取消</button><button class="submit-feedback" type="submit">提交</button></div></form>';
document.body.append(feedbackDialog);
const feedbackHistoryDialog = document.createElement('dialog');
feedbackHistoryDialog.className = 'feedback-history-dialog';
feedbackHistoryDialog.innerHTML = '<button class="dialog-close" type="button" data-close-history aria-label="关闭">×</button><h2>反馈历史</h2><p class="status-legend"><span>待处理</span><span>处理中</span><span>已解决</span><span>已关闭</span></p><div class="history-table"><table><thead><tr><th>反馈编号</th><th>商品编码</th><th>问题项</th><th>提交时间</th><th>状态</th><th>反馈内容</th></tr></thead><tbody id="feedbackHistoryBody"></tbody></table></div></dialog>';
document.body.append(feedbackHistoryDialog);
function getFeedbackHistory() { return JSON.parse(localStorage.getItem(FEEDBACK_KEY) || '[]'); }
function openProductFeedback(sku) {
  const product = productCatalog.find(item => item.sku === sku); if (!product) return;
  const dateCode = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  document.querySelector('#feedbackId').value = `FB-${dateCode}-${String(getFeedbackHistory().length + 1).padStart(3, '0')}`;
  document.querySelector('#feedbackSku').value = product.sku;
  document.querySelector('#feedbackName').value = product.name;
  document.querySelector('#feedbackContent').value = '';
  feedbackDialog.showModal();
}
function openFeedbackHistory() {
  const entries = getFeedbackHistory();
  const historyTable = document.querySelector('.history-table');
  const groups = entries.reduce((result, item) => { (result[item.issue] ||= []).push(item); return result; }, {});
  historyTable.innerHTML = entries.length ? `<div class="feedback-history-groups"><details open><summary>商品管理反馈 <span>${entries.length}</span></summary>${Object.entries(groups).map(([issue, items]) => `<details><summary>${issue} <span>${items.length}</span></summary><table><thead><tr><th>反馈编号</th><th>商品编码</th><th>提交时间</th><th>状态</th><th>反馈内容</th></tr></thead><tbody>${items.map(item => `<tr><td>${item.id}</td><td>${item.sku}</td><td>${item.submittedAt}</td><td><span class="feedback-status ${item.status}">${item.status}</span></td><td>${item.content}</td></tr>`).join('')}</tbody></table></details>`).join('')}</details></div>` : '<table><tbody><tr><td>暂无商品管理反馈记录</td></tr></tbody></table>';
  feedbackHistoryDialog.showModal();
}
document.querySelector('#productFeedbackForm').addEventListener('submit', event => {
  event.preventDefault();
  const sku = document.querySelector('#feedbackSku').value;
  const product = productCatalog.find(item => item.sku === sku);
  const entries = getFeedbackHistory();
  entries.unshift({ id: document.querySelector('#feedbackId').value, sku, name: product.name, warehouse: product.warehouse, submitter: '张晓敏', submittedAt: new Date().toLocaleString('zh-CN', { hour12: false }), issue: document.querySelector('#feedbackIssue').value, content: document.querySelector('#feedbackContent').value.trim(), status: '待处理' });
  localStorage.setItem(FEEDBACK_KEY, JSON.stringify(entries));
  feedbackDialog.close(); window.alert('反馈提交成功，已同步到管理后台的“商品反馈”列表。');
});
document.querySelectorAll('[data-close-feedback]').forEach(button => button.addEventListener('click', () => feedbackDialog.close()));
document.querySelectorAll('[data-close-history]').forEach(button => button.addEventListener('click', () => feedbackHistoryDialog.close()));

document.querySelector('#productExport')?.addEventListener('click', () => {
  const rows = filteredProducts(); const header = '商品编码,商品名称,商品单价,币种,仓库,更新时间,状态';
  const csv = [header, ...rows.map(item => [item.sku, item.name, item.price, item.currency || 'CNY', item.warehouse, item.updatedAt, item.status].map(value => `"${String(value).replace(/"/g, '""')}"`).join(','))].join('\n');
  const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' })); link.download = '商品列表.csv'; link.click(); URL.revokeObjectURL(link.href);
});

let shippingCosts = [];
let shippingCostHistory = [];
const shippingSelect = document.querySelector('#shippingWarehouseFilter');
const shippingToken = () => { try { return JSON.parse(localStorage.getItem(AUTH_SESSION_KEY) || sessionStorage.getItem(AUTH_SESSION_KEY) || '{}').accessToken; } catch { return null; } };
const escapeShippingText = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const costUnitName = value => value === 'per_package' ? '每包裹' : '每单';
const costText = cost => cost ? `${cost.currency_code} ${Number(cost.amount).toFixed(2)} / ${costUnitName(cost.billing_unit)}` : '费用缺失';
async function loadShippingCosts() {
  const response = await fetch('/api/business/warehouse-costs', { headers: { Authorization: `Bearer ${shippingToken()}` } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || '无法读取仓库代发成本');
  shippingCosts = (data.costs || []).map(item => ({ warehouseId: item.warehouse.id, warehouse: item.warehouse.name, cost: item.currentCost ? Number(item.currentCost.amount) : null, current: item.currentCost, previous: item.previousCost ? Number(item.previousCost.amount) : null, previousVersion: item.previousCost, updatedAt: item.currentCost?.effective_date || null, logistics: item.warehouse.shipping_provider_name || '—' }));
  shippingCostHistory = (data.costs || []).flatMap(item => item.history.map((current, index) => ({ warehouse: item.warehouse.name, current, previous: item.history[index + 1] || null })));
  shippingSelect.innerHTML = '<option value="">全部仓库</option>' + shippingCosts.map(item => `<option value="${escapeShippingText(item.warehouseId)}">${escapeShippingText(item.warehouse)}</option>`).join('');
  renderShippingCosts();
  window.profitDataQuality?.refresh();
}
function renderShippingCosts() {
  const selected = shippingSelect.value;
  const items = shippingCosts.filter(item => !selected || item.warehouseId === selected);
  document.querySelector('#shippingCostsBody').innerHTML = items.length ? items.map(item => { const change = item.cost === null || item.previous === null || item.previous === 0 ? null : ((item.cost - item.previous) / item.previous) * 100; return `<tr><td>${escapeShippingText(item.warehouse)}</td><td><strong>${costText(item.current)}</strong></td><td>${item.previousVersion ? costText(item.previousVersion) : '—'}</td><td class="${change > 0 ? 'negative' : 'positive'}">${change === null ? '—' : `${change >= 0 ? '+' : ''}${change.toFixed(1)}%`}</td><td>${escapeShippingText(item.updatedAt || '—')}</td><td>${escapeShippingText(item.logistics)}</td></tr>`; }).join('') : '<tr><td colspan="6">暂无已生效的仓库代发成本</td></tr>';
}
document.querySelector('#shippingSearch')?.addEventListener('click', renderShippingCosts);
const shippingHistoryDialog = document.createElement('dialog');
shippingHistoryDialog.className = 'shipping-history-dialog';
shippingHistoryDialog.innerHTML = '<button class="dialog-close" type="button" id="closeShippingHistory">×</button><h2>代发费用修改记录</h2><p>以下为只读历史版本，不展示修改人及管理操作细节。</p><table><thead><tr><th>仓库</th><th>原代发费用</th><th>新代发费用</th><th>涨幅</th><th>生效日期</th><th>备注</th></tr></thead><tbody id="shippingHistoryBody"></tbody></table></dialog>';
document.body.append(shippingHistoryDialog);
document.querySelector('#shippingHistoryButton')?.addEventListener('click', () => { document.querySelector('#shippingHistoryBody').innerHTML = shippingCostHistory.length ? shippingCostHistory.map(item => { const before = item.previous; const change = !before || Number(before.amount) === 0 ? null : ((Number(item.current.amount) - Number(before.amount)) / Number(before.amount)) * 100; return `<tr><td>${escapeShippingText(item.warehouse)}</td><td>${before ? costText(before) : '—'}</td><td>${costText(item.current)}</td><td>${change === null ? '—' : `${change >= 0 ? '+' : ''}${change.toFixed(1)}%`}</td><td>${escapeShippingText(item.current.effective_date)}</td><td>${escapeShippingText(item.current.note || '—')}</td></tr>`; }).join('') : '<tr><td colspan="6">暂无已生效的费用版本记录</td></tr>'; shippingHistoryDialog.showModal(); });
document.querySelector('#closeShippingHistory')?.addEventListener('click', () => shippingHistoryDialog.close());
renderShippingCosts();

const orderFields = [['店铺','store',['全部店铺','美国旗舰店','菲律宾精选店']],['国家站点','site',['全部站点','美国站','菲律宾站','印尼站']],['仓库','warehouse',['全部仓库',...warehouseNames]],['订单状态','status',['全部','待付款','待发货','已发货','已签收','已取消']],['下单日期','date','range'],['订单 ID','orderId','input'],['商品编码','sku','input'],['快递单号','tracking','input'],['退款状态','refund',['全部','无退款','退款中','已退款']],['完结状态','closed',['全部','未完结','已完结','已关闭']],['物流状态','logistics',['全部','待揽收','运输中','派送中','已签收']]];
const orderFilters = document.querySelector('#orderFilters');
orderFilters.innerHTML = orderFields.map(([label, key, type]) => type === 'input' ? `<label>${label}<input id="order-${key}" /></label>` : type === 'range' ? `<label>${label}<span><input id="order-date-start" type="date" /> - <input id="order-date-end" type="date" /></span></label>` : `<label>${label}<select id="order-${key}">${type.map(value => `<option value="${value.startsWith('全部') ? '' : value}">${value}</option>`).join('')}</select></label>`).join('') + '<div class="order-filter-actions"><button id="orderSearch" type="button">查询</button><button id="orderReset" type="button">重置</button></div>';
const orderStates = ['待付款','待发货','已发货','已签收','已取消']; const logisticsStates = ['待揽收','运输中','派送中','已签收'];
const orders = Array.from({ length: 57 }, (_, index) => ({ id: `TTS${String(202609100000 + index)}`, store: index % 2 ? '美国旗舰店' : '菲律宾精选店', site: index % 2 ? '美国站' : '菲律宾站', sku: `TKS-${String(index % 126 + 1).padStart(5,'0')}`, skuId: `SKU-${String(800000 + index)}`, qty: index % 3 + 1, amount: (18.9 + index * 1.17).toFixed(2), currency: index % 2 ? 'USD' : 'PHP', status: orderStates[index % 5], refund: index % 6 ? '无退款' : '已退款', refundAmount: index % 6 ? '0.00' : '5.50', warehouse: warehouseNames[index % warehouseNames.length], tracking: `JT${String(880000000 + index)}`, delivery: index % 2 ? '标准配送' : '经济配送', carrier: index % 2 ? 'J&T Express' : 'Flash Express', orderDate: `2026-09-${String(10 - index % 9).padStart(2,'0')}`, shipDate: `2026-09-${String(11 - index % 8).padStart(2,'0')}`, closed: index % 4 === 0 ? '未完结' : '已完结', updated: `2026-09-${String(11 - index % 8).padStart(2,'0')}`, logistics: logisticsStates[index % 4] }));
function getOrderDataIssues(order) {
  const product = productCatalog.find(item => item.sku === order.sku);
  const shipping = shippingCosts.find(item => item.warehouse === order.warehouse);
  const issues = [];
  if (!product || !product.costAvailable || product.status !== '可用') issues.push('商品成本缺失');
  if (!shipping || shipping.cost === null) issues.push('仓库代发成本缺失');
  if (order.id.endsWith('013')) issues.push('结算汇率缺失');
  if (order.id.endsWith('017')) issues.push('订单同步缺失');
  return issues;
}
window.profitDataQuality = {
  getOrderIssues: getOrderDataIssues,
  getStoreIssues(shop) {
    const store = shop === 'US Fashion Store' ? '美国旗舰店' : shop === 'PH Lifestyle Store' ? '菲律宾精选店' : '';
    return store ? [...new Set(orders.filter(order => order.store === store).flatMap(getOrderDataIssues))] : [];
  },
  refresh() { document.dispatchEvent(new CustomEvent('data-quality:change')); }
};
let orderPage = 1;
function filteredOrders() { const value = id => document.querySelector(`#order-${id}`)?.value || ''; const start = document.querySelector('#order-date-start').value; const end = document.querySelector('#order-date-end').value; return orders.filter(order => (!value('store') || order.store === value('store')) && (!value('site') || order.site === value('site')) && (!value('warehouse') || order.warehouse === value('warehouse')) && (!value('status') || order.status === value('status')) && (!value('orderId') || order.id.includes(value('orderId'))) && (!value('sku') || order.sku.includes(value('sku'))) && (!value('tracking') || order.tracking.includes(value('tracking'))) && (!value('refund') || order.refund === value('refund')) && (!value('closed') || order.closed === value('closed')) && (!value('logistics') || order.logistics === value('logistics')) && (!start || order.orderDate >= start) && (!end || order.orderDate <= end)); }
function renderOrders() { const filtered = filteredOrders(), size = Number(document.querySelector('#ordersPageSize').value), pages = Math.max(1, Math.ceil(filtered.length / size)); orderPage = Math.min(orderPage,pages); const visible = filtered.slice((orderPage-1)*size,orderPage*size); document.querySelector('#ordersBody').innerHTML = visible.map(order => { const issues = getOrderDataIssues(order); return `<tr><td>${order.store}</td><td>${order.site}</td><td>${order.id}</td><td>${order.sku}</td><td>${order.skuId}</td><td>${order.qty}</td><td>${order.currency} ${order.amount}</td><td><span class="order-tag ${order.status}">${order.status}</span></td><td>${order.refund} / ${order.currency} ${order.refundAmount}</td><td>${order.warehouse}</td><td>${order.tracking}</td><td>${order.delivery}</td><td>${order.carrier}</td><td>${order.orderDate}</td><td>${order.shipDate}</td><td><span class="order-tag ${order.closed}">${order.closed}</span></td><td>${order.updated}</td><td>${order.logistics}</td><td>${issues.length ? `<span class="quality-pill missing">${issues.join('、')}</span>` : '<span class="quality-pill ready">可核算</span>'}</td><td><button class="order-detail-button" data-order="${order.id}">详情</button></td></tr>`; }).join(''); document.querySelector('#ordersTotal').textContent=`共 ${filtered.length} 条`; document.querySelector('#previousOrderPage').disabled=orderPage===1; document.querySelector('#nextOrderPage').disabled=orderPage===pages; document.querySelector('#orderPages').innerHTML=Array.from({length:pages},(_,i)=>`<button class="page-number ${i+1===orderPage?'active':''}" data-order-page="${i+1}">${i+1}</button>`).join(''); }
document.querySelector('#orderSearch').addEventListener('click',()=>{orderPage=1;renderOrders();}); document.querySelector('#orderReset').addEventListener('click',()=>{orderFilters.querySelectorAll('input,select').forEach(field=>field.value='');orderPage=1;renderOrders();}); document.querySelector('#ordersPageSize').addEventListener('change',()=>{orderPage=1;renderOrders();}); document.querySelector('#previousOrderPage').addEventListener('click',()=>{orderPage--;renderOrders();}); document.querySelector('#nextOrderPage').addEventListener('click',()=>{orderPage++;renderOrders();}); document.querySelector('#orderPages').addEventListener('click',event=>{if(event.target.dataset.orderPage){orderPage=Number(event.target.dataset.orderPage);renderOrders();}});
const orderDrawer = document.createElement('aside'); orderDrawer.className='order-drawer is-hidden'; document.body.append(orderDrawer);
document.querySelector('#ordersBody').addEventListener('click',event=>{const id=event.target.dataset.order;if(!id)return;const order=orders.find(item=>item.id===id);orderDrawer.innerHTML=`<button class="dialog-close" id="closeOrderDrawer">×</button><h2>订单详情</h2><p class="drawer-summary">订单 ID：${order.id} · 订单总支付金额：<strong>${order.currency} ${(Number(order.amount)*order.qty).toFixed(2)}</strong></p><h3>订单信息</h3><div class="drawer-grid"><div>完整下单时间<strong>${order.orderDate} 10:26:18</strong></div><div>完整发货时间<strong>${order.shipDate} 15:40:06</strong></div><div>物流状态<strong>${order.logistics}</strong></div><div>数据更新时间<strong>${order.updated} 18:12:30</strong></div></div><h3>各 SKU 分摊金额</h3><table class="drawer-table"><tr><th>商品编码</th><th>SKU ID</th><th>数量</th><th>分摊实付金额</th></tr><tr><td>${order.sku}</td><td>${order.skuId}</td><td>${order.qty}</td><td>${order.currency} ${order.amount}</td></tr></table><h3>物流轨迹</h3><table class="drawer-table"><tr><td>${order.shipDate} 15:40</td><td>${order.carrier} 已揽收</td></tr><tr><td>${order.shipDate} 22:10</td><td>运输中，等待配送</td></tr></table><h3>退款记录</h3><table class="drawer-table"><tr><td>${order.refund}</td><td>${order.currency} ${order.refundAmount}</td><td>${order.refund === '无退款' ? '无退款记录' : '退款已完成'}</td></tr></table>`;orderDrawer.classList.remove('is-hidden');document.querySelector('#closeOrderDrawer').addEventListener('click',()=>orderDrawer.classList.add('is-hidden'));});
renderOrders();
ordersPage.querySelector('.page-heading')?.remove();

const settlementPage = document.querySelector('#settlementPage');
settlementPage.classList.add('settlement-page-content');
settlementPage.innerHTML = '<section class="settlement-filters" id="settlementFilters"></section><div class="settlement-rule-note"><strong>费用计算规则：</strong>“总费用”是汇总字段，不能与明细费用重复相加。利润计算优先使用明细费用；仅当明细缺失时，才使用总费用作为兜底。</div><section class="settlement-table-card"><table><thead><tr><th>结算日期</th><th>结算货币</th><th>交易类型</th><th>结算单 ID</th><th>订单 ID / 调整单 ID</th><th>SKU ID</th><th>商品名称</th><th>数量</th><th>结算总金额</th><th>详情</th></tr></thead><tbody id="settlementsBody"></tbody></table><div class="product-pagination"><span id="settlementsTotal"></span><label>每页<select id="settlementsPageSize"><option value="20">20 条/页</option><option value="50">50 条/页</option><option value="100">100 条/页</option></select></label><div><button id="previousSettlementPage" type="button">上一页</button><span id="settlementPages"></span><button id="nextSettlementPage" type="button">下一页</button></div></div></section>';
const settlementFilters = document.querySelector('#settlementFilters');
settlementFilters.innerHTML = '<label>结算日期范围<span><input id="settlement-start" type="date" /> - <input id="settlement-end" type="date" /></span></label><label>结算货币<select id="settlement-currency"><option value="">全部</option><option>USD</option><option>PHP</option></select></label><label>交易类型<select id="settlement-type"><option value="">全部</option><option>订单结算</option><option>退款</option><option>费用调整</option></select></label><label>结算单 ID<input id="settlement-id" /></label><label>订单 ID / 调整单 ID<input id="settlement-order" /></label><label>SKU ID<input id="settlement-sku" /></label><label>商品名称<input id="settlement-name" placeholder="支持模糊查询" /></label><div class="settlement-filter-actions"><button id="settlementSearch" type="button">查询</button><button id="settlementReset" type="button">重置</button></div>';
const settlementFeeLabels = ['总收入','享受商家折扣后小计','享受折扣前小计','商家折扣','享受商家折扣后的退款小计','享受商家折扣前的退款小计','商家折扣退款','总费用','交易手续费','TikTok Shop 佣金费','信用卡分期付款 - 手续费','商家运费','实际运费','国际段运费','平台运费减免','买家支付运费','实际退货运费','客户运费退款','运费补贴','Guarantee program reimbursement','联盟佣金','联盟服务商佣金','联盟店铺广告佣金','联盟佣金保证金','联盟佣金退款','联盟服务商店铺广告佣金','SFP 服务费','动态佣金','奖金返现服务费','直播特别活动服务费','SST','超级优惠券服务费','EAMS 计划服务费','品牌疯狂优惠/秒杀服务费','TikTok PayLater 计划费用','活动资源费','平台支持费','托管服务计划（销售税）','托管服务计划（每单费用）','GMV Max 优惠券','GMV Max 优惠券销售税','GMV Max 广告费','Guarantee program fee','SFR service fee','调整金额'];
const settlements = Array.from({length:46},(_,index)=>({ date:`2026-09-${String(10-index%9).padStart(2,'0')}`, currency:index%2?'USD':'PHP', type:['订单结算','退款','费用调整'][index%3], id:`STL-${String(2026090000+index)}`, orderId:index%3===2?`ADJ-${String(90000+index)}`:`TTS${String(202609100000+index)}`, sku:`SKU-${String(800000+index)}`, name:`${['便携收纳盒','运动水杯','简约双肩包','无线蓝牙耳机'][index%4]} ${index+1}`, qty:index%3+1, total:(18.5+index*2.13).toFixed(2) }));
let settlementPageNumber=1;
function filteredSettlements(){const val=id=>document.querySelector(`#${id}`)?.value||'';return settlements.filter(s=>(!val('settlement-currency')||s.currency===val('settlement-currency'))&&(!val('settlement-type')||s.type===val('settlement-type'))&&(!val('settlement-id')||s.id.includes(val('settlement-id')))&&(!val('settlement-order')||s.orderId.includes(val('settlement-order')))&&(!val('settlement-sku')||s.sku.includes(val('settlement-sku')))&&(!val('settlement-name')||s.name.toLowerCase().includes(val('settlement-name').toLowerCase()))&&(!val('settlement-start')||s.date>=val('settlement-start'))&&(!val('settlement-end')||s.date<=val('settlement-end')));}
function renderSettlements(){const filtered=filteredSettlements(),size=Number(document.querySelector('#settlementsPageSize').value),pages=Math.max(1,Math.ceil(filtered.length/size));settlementPageNumber=Math.min(settlementPageNumber,pages);const visible=filtered.slice((settlementPageNumber-1)*size,settlementPageNumber*size);document.querySelector('#settlementsBody').innerHTML=visible.map(s=>`<tr><td>${s.date}</td><td>${s.currency}</td><td>${s.type}</td><td>${s.id}</td><td>${s.orderId}</td><td>${s.sku}</td><td>${s.name}</td><td>${s.qty}</td><td>${s.currency} ${s.total}</td><td><button class="order-detail-button" data-settlement="${s.id}">详情</button></td></tr>`).join('');document.querySelector('#settlementsTotal').textContent=`共 ${filtered.length} 条`;document.querySelector('#previousSettlementPage').disabled=settlementPageNumber===1;document.querySelector('#nextSettlementPage').disabled=settlementPageNumber===pages;document.querySelector('#settlementPages').innerHTML=Array.from({length:pages},(_,i)=>`<button class="page-number ${i+1===settlementPageNumber?'active':''}" data-settlement-page="${i+1}">${i+1}</button>`).join('');}
document.querySelector('#settlementSearch').addEventListener('click',()=>{settlementPageNumber=1;renderSettlements();});document.querySelector('#settlementReset').addEventListener('click',()=>{settlementFilters.querySelectorAll('input,select').forEach(el=>el.value='');settlementPageNumber=1;renderSettlements();});document.querySelector('#settlementsPageSize').addEventListener('change',()=>{settlementPageNumber=1;renderSettlements();});document.querySelector('#previousSettlementPage').addEventListener('click',()=>{settlementPageNumber--;renderSettlements();});document.querySelector('#nextSettlementPage').addEventListener('click',()=>{settlementPageNumber++;renderSettlements();});document.querySelector('#settlementPages').addEventListener('click',event=>{if(event.target.dataset.settlementPage){settlementPageNumber=Number(event.target.dataset.settlementPage);renderSettlements();}});
const settlementDrawer=document.createElement('aside');settlementDrawer.className='settlement-drawer is-hidden';document.body.append(settlementDrawer);document.querySelector('#settlementsBody').addEventListener('click',event=>{const id=event.target.dataset.settlement;if(!id)return;const s=settlements.find(item=>item.id===id);const detailFields=[['结算日期',s.date],['结算单 ID',s.id],['货币',s.currency],['交易类型',s.type],['订单ID/调整单ID',s.orderId],['SKU ID',s.sku],['数量',s.qty],['商品名称',s.name],['SKU 名称',s.name],['结算总金额',`${s.currency} ${s.total}`],...settlementFeeLabels.map((label,index)=>[label,`${s.currency} ${(index===0?Number(s.total)*1.25:index===7?Number(s.total)*.18:index===44?0:(Number(s.total)*(index%5+1)/100)).toFixed(2)}`])];settlementDrawer.innerHTML=`<button class="dialog-close" id="closeSettlementDrawer">×</button><h2>结算明细</h2><p class="settlement-summary">结算单 ${s.id} · ${s.type}</p><h3>结算与费用明细</h3><div class="settlement-detail-grid">${detailFields.map(([label,value])=>`<div><span>${label}</span><strong>${value}</strong></div>`).join('')}</div>`;settlementDrawer.classList.remove('is-hidden');document.querySelector('#closeSettlementDrawer').addEventListener('click',()=>settlementDrawer.classList.add('is-hidden'));});
renderSettlements();
const settlementGroups = [
  ['结算基础',['结算日期','结算单 ID','货币','交易类型','订单/调整单 ID','SKU','数量']],
  ['收入与折扣',['总收入','享受商家折扣后小计','享受折扣前小计','商家折扣','GMV Max 优惠券','GMV Max 优惠券销售税']],
  ['退款',['享受商家折扣后的退款小计','享受商家折扣前的退款小计','商家折扣退款','客户运费退款','实际退货运费']],
  ['平台与支付费用',['总费用','交易手续费','TikTok Shop 佣金费','信用卡分期付款 - 手续费','SFP 服务费','SFR service fee']],
  ['物流费用',['商家运费','实际运费','国际段运费','平台运费减免','买家支付运费','运费补贴']],
  ['联盟、广告与活动费用',['联盟佣金','联盟服务商佣金','联盟店铺广告佣金','联盟佣金保证金','联盟佣金退款','联盟服务商店铺广告佣金','GMV Max 广告费','动态佣金','奖金返现服务费','直播特别活动服务费','活动资源费','平台支持费']],
  ['税费、计划与调整',['SST','托管服务计划（销售税）','托管服务计划（每单费用）','Guarantee program fee','Guarantee program reimbursement','超级优惠券服务费','EAMS 计划服务费','品牌疯狂优惠/秒杀服务费','TikTok PayLater 计划费用','调整金额']],
  ['数据信息',['订单更新时间','同步时间','原始结算数据标识']]
];
document.querySelector('#settlementsBody').addEventListener('click', event => {
  const id = event.target.dataset.settlement; if (!id) return;
  const s = settlements.find(item => item.id === id);
  const values = { '结算日期':s.date,'结算单 ID':s.id,'货币':s.currency,'交易类型':s.type,'订单/调整单 ID':s.orderId,'SKU':s.sku,'数量':s.qty,'订单更新时间':`${s.date} 18:12:30`,'同步时间':`${s.date} 18:20:00`,'原始结算数据标识':`RAW-${s.id}` };
  settlementFeeLabels.forEach((label,index) => values[label] = `${s.currency} ${(index === 0 ? Number(s.total) * 1.25 : index === 7 ? Number(s.total) * .18 : index === 44 ? 0 : Number(s.total) * (index % 5 + 1) / 100).toFixed(2)}`);
  settlementDrawer.innerHTML = `<button class="dialog-close" id="closeSettlementDrawer">×</button><h2>结算明细</h2><p class="settlement-summary">结算单 ${s.id} · ${s.type}</p>${settlementGroups.map(([title,fields]) => `<section class="settlement-group"><h3>${title}</h3><div class="settlement-detail-grid">${fields.map(field => `<div><span>${field}</span><strong>${values[field] ?? '—'}</strong></div>`).join('')}</div></section>`).join('')}`;
  settlementDrawer.classList.remove('is-hidden'); document.querySelector('#closeSettlementDrawer').addEventListener('click', () => settlementDrawer.classList.add('is-hidden'));
});
