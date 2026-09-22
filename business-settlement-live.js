(() => {
  const page = document.querySelector('#settlementPage');
  if (!page) return;
  const session = () => { try { return JSON.parse(localStorage.getItem('tiktokShopAuthSession') || sessionStorage.getItem('tiktokShopAuthSession') || '{}'); } catch { return {}; } };
  const escape = value => String(value ?? '—').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
  const api = async path => { const response = window.tiktokAuth?.fetch ? await window.tiktokAuth.fetch(path) : await fetch(path, { headers: { Authorization: `Bearer ${session().accessToken || ''}` } }); const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.message || '读取已结算账单失败'); return data; };
  let rows = [], shops = [], pageNo = 1, pageSize = 20, meta = { totalRows: 0, totalPages: 1 };
  let latestLoad = 0;
  const CACHE_TTL = 3 * 60 * 1000;
  let cachedKey = '', cachedAt = 0;
  const settlementVisible = () => !page.classList.contains('is-hidden');
  const filters = { settlementShop: '', settlementCurrency: '', settlementType: '', settlementStart: '', settlementEnd: '', settlementOrder: '', settlementSku: '' };
  const cacheKey = () => JSON.stringify({ account: session().accessToken || '', pageNo, pageSize, filters });
  function shell() {
    page.classList.remove('settlement-placeholder');
    page.classList.add('business-settlement-active');
    page.innerHTML = `<section class="settlement-filters"><label>结算日期<span><input id="businessSettlementStart" type="date" /> - <input id="businessSettlementEnd" type="date" /></span></label><label>店铺<select id="businessSettlementShop"><option value="">全部授权店铺</option>${shops.map(shop => `<option value="${escape(shop.shop_name)}">${escape(shop.shop_code || shop.shop_name)}</option>`).join('')}</select></label><label>结算货币<input id="businessSettlementCurrency" placeholder="如 VND" /></label><label>交易类型<input id="businessSettlementType" placeholder="支持模糊查询" /></label><label>相关订单 ID<input id="businessSettlementOrder" /></label><label>SKU ID<input id="businessSettlementSku" /></label><div class="settlement-filter-actions"><button id="businessSettlementSearch" type="button">查询</button><button id="businessSettlementReset" type="button">重置</button><button id="businessSettlementExport" type="button">导出数据</button></div></section><div class="settlement-rule-note"><strong>已结算账单：</strong>展示后台导入且生效的已结算账单，仅限当前业务员已授权店铺；未结算和待核对账单不在此页面展示。</div><section class="settlement-table-card"><table><thead><tr><th>店铺 / 国家站点</th><th>结算日期</th><th>结算单 ID</th><th>结算货币</th><th>交易类型</th><th>相关订单 ID</th><th>SKU ID</th><th>商品名称</th><th>数量</th><th>结算总金额</th><th>详情</th></tr></thead><tbody id="businessSettlementsBody"></tbody></table><div class="product-pagination"><span id="businessSettlementsTotal"></span><label>每页<select id="businessSettlementsPageSize"><option value="20">20 条/页</option><option value="50">50 条/页</option><option value="100">100 条/页</option></select></label><div><button id="businessSettlementsPrev" type="button">上一页</button><span id="businessSettlementsPage"></span><button id="businessSettlementsNext" type="button">下一页</button></div></div></section>`;
    page.querySelector('.settlement-table-card th:first-child').innerHTML = '店铺<br>国家站点';
    const fields = { businessSettlementStart: 'settlementStart', businessSettlementEnd: 'settlementEnd', businessSettlementShop: 'settlementShop', businessSettlementCurrency: 'settlementCurrency', businessSettlementType: 'settlementType', businessSettlementOrder: 'settlementOrder', businessSettlementSku: 'settlementSku' };
    Object.entries(fields).forEach(([id, key]) => { const element = page.querySelector(`#${id}`); if (element) element.value = filters[key]; });
    page.querySelector('#businessSettlementsPageSize').value = String(pageSize);
    page.querySelector('#businessSettlementSearch').onclick = () => { Object.entries(fields).forEach(([id, key]) => { filters[key] = page.querySelector(`#${id}`).value.trim(); }); pageNo = 1; load(true); };
    page.querySelector('#businessSettlementReset').onclick = () => { Object.keys(filters).forEach(key => { filters[key] = ''; }); pageNo = 1; load(true); };
    page.querySelector('#businessSettlementsPageSize').onchange = event => { pageSize = Number(event.target.value); pageNo = 1; load(); };
    page.querySelector('#businessSettlementsPrev').onclick = () => { if (pageNo > 1) { pageNo -= 1; load(); } };
    page.querySelector('#businessSettlementsNext').onclick = () => { if (pageNo < (meta.totalPages || 1)) { pageNo += 1; load(); } };
    page.querySelector('#businessSettlementExport').onclick = exportData;
    page.querySelector('#businessSettlementsBody').onclick = event => { const item = rows.find(row => row.id === event.target.dataset.settlementDetail); if (item) detail(item); };
  }
  function draw() {
    const body = page.querySelector('#businessSettlementsBody');
    if (!body) return;
    body.innerHTML = rows.map(row => `<tr><td>${escape(row.shop)}<small>${escape(row.site)}</small></td><td>${escape(row.date)}</td><td><strong>${escape(row.number)}</strong></td><td>${escape(row.currency)}</td><td>${escape(row.type)}</td><td>${escape(row.relatedOrder)}</td><td>${escape(row.sku)}</td><td>${escape(row.name)}</td><td>${escape(row.qty)}</td><td>${escape(row.amount)}</td><td><button class="order-detail-button" data-settlement-detail="${escape(row.id)}">详情</button></td></tr>`).join('') || '<tr><td colspan="11">暂无符合条件的已结算账单</td></tr>';
    page.querySelector('#businessSettlementsTotal').textContent = `符合筛选条件：共 ${meta.totalRows || 0} 条已结算账单`;
    page.querySelector('#businessSettlementsPage').textContent = `${meta.page || pageNo} / ${meta.totalPages || 1}`;
    page.querySelector('#businessSettlementsPrev').disabled = (meta.page || pageNo) <= 1;
    page.querySelector('#businessSettlementsNext').disabled = (meta.page || pageNo) >= (meta.totalPages || 1);
  }
  function detail(row) {
    const drawer = document.createElement('aside'); drawer.className = 'order-drawer';
    const feeRows = Object.entries(row.feeBreakdown || {}).map(([name, amount]) => `<tr><td>${escape(name)}</td><td>${escape(`${row.currency} ${Number(amount || 0).toFixed(2)}`)}</td></tr>`).join('');
    drawer.innerHTML = `<button class="dialog-close" type="button">×</button><h2>已结算账单详情</h2><p class="drawer-summary">结算单 ID：${escape(row.number)}</p><div class="drawer-grid"><div>店铺 / 国家站点<strong>${escape(row.shop)} / ${escape(row.site)}</strong></div><div>结算日期<strong>${escape(row.date)}</strong></div><div>结算货币<strong>${escape(row.currency)}</strong></div><div>交易类型<strong>${escape(row.type)}</strong></div><div>相关订单 ID<strong>${escape(row.relatedOrder)}</strong></div><div>SKU ID<strong>${escape(row.sku)}</strong></div><div>商品名称<strong>${escape(row.name)}</strong></div><div>结算总金额<strong>${escape(row.amount)}</strong></div></div><h3>费用明细</h3><table class="drawer-table"><thead><tr><th>项目</th><th>金额</th></tr></thead><tbody>${feeRows || '<tr><td colspan="2">该账单未提供费用拆分字段</td></tr>'}</tbody></table>`;
    document.body.append(drawer); drawer.querySelector('.dialog-close').onclick = () => drawer.remove();
  }
  async function exportData() {
    try {
      const params = new URLSearchParams({ view: 'settlements', export: 'csv', page: '1', pageSize: '100', ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value)) });
      const response = await fetch(`/api/business/order-details?${params}`, { headers: { Authorization: `Bearer ${session().accessToken || ''}` } });
      if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.message || '导出已结算账单失败'); }
      const url = URL.createObjectURL(await response.blob()); const link = document.createElement('a'); link.href = url; link.download = '已结算账单.csv'; link.click(); URL.revokeObjectURL(url);
    } catch (error) { window.alert(error.message || '导出已结算账单失败'); }
  }
  async function load(force = false) {
    if (!session().accessToken || !settlementVisible()) return;
    const key = cacheKey();
    const loadId = ++latestLoad;
    shell();
    if (!force && cachedKey === key && Date.now() - cachedAt < CACHE_TTL) {
      draw();
      return;
    }
    const body = page.querySelector('#businessSettlementsBody'); body.innerHTML = '<tr><td colspan="11">正在读取后台已结算账单…</td></tr>';
    try {
      const params = new URLSearchParams({ view: 'settlements', settlementTab: 'settled', light: 'true', page: String(pageNo), pageSize: String(pageSize), ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value)) });
      const data = await api(`/api/business/order-details?${params}`);
      if (loadId !== latestLoad) return;
      rows = data.settlements || []; meta = data.settlementMeta || meta; cachedKey = key; cachedAt = Date.now(); shell(); draw();
      api('/api/business/shops').then(shopData => { if (loadId !== latestLoad) return; shops = shopData.shops || []; shell(); draw(); }).catch(() => {});
    } catch (error) { if (loadId === latestLoad) body.innerHTML = `<tr><td colspan="11">${escape(error.message)}</td></tr>`; }
  }
  document.addEventListener('app:authenticated', load);
  document.querySelector('#settlementNav')?.addEventListener('click', load);
  load();
})();
