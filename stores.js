(() => {
  const page = document.querySelector('#storesPage');
  const body = document.querySelector('#shopsBody');
  const country = document.querySelector('#shopCountryFilter');
  const sync = document.querySelector('#shopSyncFilter');
  const name = document.querySelector('#shopNameFilter');
  const detail = document.querySelector('#storeDetailDialog');
  const codeName = { TH: '泰国', MY: '马来西亚', VN: '越南', PH: '菲律宾', ID: '印尼', US: '美国', CN: '中国' };
  let shops = [];
  const token = () => { try { return JSON.parse(localStorage.getItem('tiktokShopAuthSession') || sessionStorage.getItem('tiktokShopAuthSession') || '{}').accessToken; } catch { return null; } };
  const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
  function siteName(value) { return codeName[value] || value || '—'; }
  async function load() {
    const response = await fetch('/api/business/shops', { headers: { Authorization: `Bearer ${token()}` } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || '无法读取店铺数据');
    shops = data.shops || [];
    const selected = country.value;
    country.innerHTML = '<option value="">全部站点</option>' + [...new Set(shops.map(shop => shop.country_code))].sort().map(value => `<option value="${value}">${siteName(value)}</option>`).join('');
    country.value = selected;
  }
  function render(error = '') {
    if (!body) return;
    const search = name.value.trim().toLowerCase();
    const list = shops.filter(shop => (!country.value || shop.country_code === country.value) && (!sync.value || sync.value === '尚未接入') && (!search || `${shop.shop_name} ${shop.shop_code}`.toLowerCase().includes(search)));
    document.querySelector('#shopsCount').textContent = `共 ${list.length} 个已授权店铺`;
    body.innerHTML = error ? `<tr><td colspan="8" class="loading-row">${escapeHtml(error)}</td></tr>` : list.length ? list.map(shop => `<tr><td><strong>${escapeHtml(shop.shop_name)}</strong><br/><small>${escapeHtml(shop.shop_code)}</small></td><td>${siteName(shop.country_code)}</td><td>${escapeHtml(shop.currency_code)}</td><td><div class="warehouse-tags">${shop.warehouses.length ? shop.warehouses.map(warehouse => `<span>${escapeHtml(warehouse.name)}</span>`).join('') : '<span>暂未关联</span>'}</div></td><td><span class="shop-state delayed">尚未接入</span></td><td>—</td><td><span class="health-state warning">等待每日导入</span></td><td><button class="shop-detail-button" data-detail="${shop.id}">查看详情</button></td></tr>`).join('') : '<tr><td colspan="8" class="loading-row">没有符合条件的已授权店铺</td></tr>';
  }
  function show() {
    ['#dashboard', '#currencyPage', '#productsPage', '#shippingPage', '#ordersPage', '#summaryPage'].forEach(selector => document.querySelector(selector)?.classList.add('is-hidden'));
    page.classList.remove('is-hidden'); document.querySelector('#topbarTitle').textContent = '我的店铺'; document.querySelector('#reportCurrency').classList.add('is-hidden'); document.querySelector('#topbarSubtitle').textContent = '仅展示您已获授权店铺；订单与结算数据将通过每日导入更新'; document.querySelector('#topbarSubtitle').classList.remove('is-hidden');
    document.querySelectorAll('.profit-nav a').forEach(link => link.classList.toggle('active', link.getAttribute('href') === '#shops'));
    load().then(() => render()).catch(error => render(error.message));
  }
  document.addEventListener('sales:navigate', event => { if (event.detail?.route === '#shops') show(); });
  document.addEventListener('app:authenticated', event => { if (event.detail.role === 'business_user' && !page.classList.contains('is-hidden')) load().catch(() => {}); });
  document.querySelector('#shopSearch')?.addEventListener('click', () => render());
  document.querySelector('#shopReset')?.addEventListener('click', () => { country.value = ''; sync.value = ''; name.value = ''; render(); });
  name?.addEventListener('keydown', event => { if (event.key === 'Enter') render(); });
  body?.addEventListener('click', event => {
    const id = event.target.dataset.detail; if (!id) return;
    const shop = shops.find(item => item.id === id); if (!shop) return;
    document.querySelector('#storeDetailContent').innerHTML = `<h2>${escapeHtml(shop.shop_name)}</h2><p>${siteName(shop.country_code)}站点 · 业务员只读信息</p><div class="store-detail-grid">${[['店铺编码', shop.shop_code], ['店铺币种', shop.currency_code], ['关联仓库', shop.warehouses.map(item => item.name).join('、') || '暂未关联'], ['店铺状态', shop.is_active ? '启用' : '停用'], ['订单数据', '等待每日文件导入'], ['数据健康度', '尚未生成']].map(item => `<div><span>${item[0]}</span><strong>${escapeHtml(item[1])}</strong></div>`).join('')}</div><div class="store-detail-alert">店铺与仓库资料来自管理后台；订单、结算单和利润指标将在数据导入中心上线后显示。</div>`;
    detail.showModal();
  });
  document.querySelector('#closeStoreDetail')?.addEventListener('click', () => detail.close());
})();
