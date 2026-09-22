(() => {
  const page = document.querySelector('#summaryPage');
  const card = page?.querySelector('.summary-detail');
  if (!page || !card) return;

  const CACHE_TTL = 3 * 60 * 1000;
  let cacheKey = '';
  let cacheAt = 0;
  let activeView = 'store';
  let reportCurrency = 'CNY';
  let reportRange = { start: '', end: '' };
  let authorizedShops = [];
  let stores = [];
  let products = [];

  const $ = selector => document.querySelector(selector);
  const legacyRateFilter = $('#summaryWarehouseFilter');
  if (!$('#summaryRateTypeFilter') && legacyRateFilter) {
    legacyRateFilter.closest('label').innerHTML = '汇率选项<select id="summaryRateTypeFilter"><option value="settlement">报表结算汇率</option><option value="reference">实时参考汇率</option></select>';
  }
  const alertTrigger = $('#summaryAlertTrigger') || document.createElement('button');
  if (!alertTrigger.id) {
    alertTrigger.id = 'summaryAlertTrigger';
    alertTrigger.type = 'button';
    alertTrigger.textContent = '异常提醒';
    $('#summaryReset')?.after(alertTrigger);
  }
  $('#summaryShopFilter').innerHTML = '<option value="">全部已授权店铺</option>';
  $('#summaryCountryFilter').innerHTML = '<option value="">全部站点</option>';
  // 利润汇总默认以人民币口径展示；用户仍可手动切换为 USD。
  $('#summaryCurrencyFilter').value = 'CNY';
  const isVisible = () => !page.classList.contains('is-hidden');
  const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
  const formatDate = value => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  const money = value => value === null || value === undefined || !Number.isFinite(Number(value)) ? '—' : `${reportCurrency} ${Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const percent = value => value === null || value === undefined || !Number.isFinite(Number(value)) ? '—' : `${Number(value).toFixed(2)}%`;
  const stateBadges = row => {
    const items = row.statusItems || [];
    if (!items.length) return '<span class="profit-tab-state ok">正常</span>';
    return `<span class="profit-status-items">${items.map(item => item.code === '商品成本待补'
      ? `<button class="profit-tab-state warn profit-status-export" type="button" data-profit-status-export="product_cost_missing" data-shop-id="${escapeHtml(row.shopId || '')}" title="导出当前筛选范围内的商品成本待补订单">${escapeHtml(item.label || item.code)}</button>`
      : `<span class="profit-tab-state ${item.code === '已取消未结算' ? 'neutral' : 'warn'}">${escapeHtml(item.label || item.code)}</span>`).join('')}</span>`;
  };
  const warehouseCostExplanation = (row, allocated = false) => {
    const notes = [];
    if (row.warehouseCostMatchedOrderCount) notes.push(`${allocated ? '分摊已计' : '已计'} ${row.warehouseCostMatchedOrderCount} 笔`);
    if (row.warehouseCostDuplicateOrderCount) notes.push(`同运单已计 ${row.warehouseCostDuplicateOrderCount} 笔`);
    if (row.warehouseCostCancelledOrderCount) notes.push(`取消未计费 ${row.warehouseCostCancelledOrderCount} 笔`);
    if (row.warehouseCostNonEligibleOrderCount) notes.push(`非计费状态 ${row.warehouseCostNonEligibleOrderCount} 笔`);
    if (row.warehouseCostMissingOrderCount) notes.push(`异常待处理 ${row.warehouseCostMissingOrderCount} 笔`);
    return notes.length ? notes.join('；') : '当前筛选范围内暂无仓库代发费用的计费明细。';
  };
  const session = () => JSON.parse(localStorage.getItem('tiktokShopAuthSession') || sessionStorage.getItem('tiktokShopAuthSession') || '{}');
  const headers = () => ({ Authorization: `Bearer ${session().accessToken || ''}` });
  const dataKey = row => `${row.shopId || ''}::${row.sku || row.code || row.name || ''}`;

  card.innerHTML = `
    <div class="summary-card-head">
      <div><h2>利润明细</h2><p id="profitTabSubtitle">正在读取真实利润数据…</p></div>
      <div class="profit-tab-actions"><select id="profitTabSort"><option value="profit">净利润从高到低</option><option value="sales">销售额从高到低</option><option value="margin">净利率从高到低</option><option value="refundRate">退款率从高到低</option></select><button id="profitTabExport" type="button">导出数据</button></div>
    </div>
    <nav class="profit-tab-nav"><button type="button" class="active" data-view="store">店铺利润</button><button type="button" data-view="product">商品利润</button></nav>
    <section id="profitTabStore"><table><thead><tr><th>店铺 / 站点</th><th>有效订单</th><th>销售额</th><th>退款金额</th><th>平台费用</th><th>结算/预计金额</th><th>商品成本</th><th>仓库代发成本</th><th>推广费</th><th>净利润</th><th>净利率</th><th>退款率</th><th>数据状态</th><th>操作：详情</th></tr></thead><tbody id="profitTabStoreRows"></tbody></table></section>
    <section id="profitTabProduct" class="is-hidden"><div class="profit-product-filter"><input id="profitProductKeyword" placeholder="商品编码 / SKU / 商品名称" /><select id="profitProductState"><option value="">全部利润状态</option><option value="结算未匹配">结算未匹配</option><option value="仓库配置未匹配">仓库配置未匹配</option><option value="仓库配置重复">仓库配置重复</option><option value="代发费用版本缺失">代发费用版本缺失</option><option value="代发费用汇率缺失">代发费用汇率缺失</option><option value="商品成本待补">商品成本待补</option><option value="汇率缺失">汇率缺失</option></select></div><table><thead><tr><th>商品</th><th>商品编码 / SKU ID</th><th>所属店铺</th><th>销售额</th><th>销量</th><th>有效订单</th><th>结算/预计金额</th><th>商品成本</th><th>仓库及运费成本</th><th>平台费用</th><th>推广费</th><th>退款数 / 退款率</th><th>净利润</th><th>净利率</th><th>数据状态</th><th>详情</th></tr></thead><tbody id="profitTabProductRows"></tbody></table></section>`;

  const dateFilter = $('#summaryDateFilter');
  $('#profitProductState')?.insertAdjacentHTML('beforeend', '<option value="商品仓库成本未匹配">商品仓库成本未匹配</option><option value="商品仓库成本匹配重复">商品仓库成本匹配重复</option><option value="商品编码缺失">商品编码缺失</option><option value="商品数量异常">商品数量异常</option><option value="商品成本版本缺失">商品成本版本缺失</option><option value="商品成本汇率缺失">商品成本汇率缺失</option><option value="商品成本非计费状态">商品成本非计费状态</option><option value="已取消未结算">已取消未结算</option>');
  // 利润汇总默认统计前 7 个完整自然日，不包含当天。
  dateFilter.value = '近 7 天';
  const yesterday = new Date();
  yesterday.setHours(0, 0, 0, 0);
  yesterday.setDate(yesterday.getDate() - 1);
  const defaultStart = new Date(yesterday);
  defaultStart.setDate(defaultStart.getDate() - 6);
  const dateControls = document.createElement('span');
  dateControls.className = 'summary-custom-dates is-hidden';
  dateControls.innerHTML = `<input id="summaryCustomStart" type="date" max="${formatDate(yesterday)}" value="${formatDate(defaultStart)}" /><em>至</em><input id="summaryCustomEnd" type="date" max="${formatDate(yesterday)}" value="${formatDate(yesterday)}" />`;
  dateFilter.closest('label')?.after(dateControls);
  dateFilter.addEventListener('change', () => dateControls.classList.toggle('is-hidden', dateFilter.value !== '自定义'));

  const style = document.createElement('style');
  style.textContent = '.summary-custom-dates{display:flex;align-items:end;gap:7px}.summary-custom-dates input{height:36px;width:132px;border:1px solid #dfe6ef;border-radius:7px;background:#fff;padding:0 9px;color:#354158;font:12px inherit}.summary-custom-dates em{padding-bottom:10px;color:#7c899b;font-size:12px;font-style:normal}.profit-tab-actions{display:flex;gap:8px}.profit-tab-actions select,.profit-tab-actions button,.profit-product-filter input,.profit-product-filter select{height:34px;border:1px solid #dfe6ef;border-radius:6px;background:#fff;padding:0 9px;color:#526378;font:12px inherit}.profit-tab-actions button{color:#287fc5;cursor:pointer}.profit-tab-nav{display:flex;gap:18px;margin:18px 0 12px;border-bottom:1px solid #e8edf3}.profit-tab-nav button{position:relative;border:0;background:transparent;padding:9px 2px;color:#8490a2;font:12px inherit;cursor:pointer}.profit-tab-nav button.active{color:#287fc5;font-weight:700}.profit-tab-nav button.active:after{content:"";position:absolute;right:0;bottom:-1px;left:0;height:2px;background:#287fc5}.profit-product-filter{display:flex;gap:9px;margin-bottom:12px}.profit-product-filter input{width:230px}.profit-product-name{display:flex;align-items:center;gap:8px;max-width:230px;white-space:normal}.profit-product-name i{display:grid;place-items:center;width:30px;height:30px;background:#f3f7fa;border-radius:6px;font-style:normal}.profit-product-name span{overflow-wrap:anywhere}.summary-detail td small{display:block;margin-top:4px;color:#73859a}.profit-status-items{display:flex;flex-wrap:wrap;gap:4px}.profit-tab-state{display:inline-block;padding:4px 7px;border-radius:12px;font-size:10px;white-space:nowrap}.profit-tab-state.ok{background:#e8f8ef;color:#218f75}.profit-tab-state.warn{background:#fff4df;color:#b57820}.profit-tab-state.neutral{background:#edf2f7;color:#63748a}.profit-status-export{border:0;cursor:pointer}.profit-status-export:hover{text-decoration:underline}.profit-detail-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:14px}.profit-detail-grid div{padding:10px;border-radius:8px;background:#f7fafc}.profit-detail-grid span,.profit-detail-grid b{display:block}.profit-detail-grid span{margin-bottom:3px;color:#73859a;font-size:12px}.profit-detail-grid b{color:#203656;font-size:14px}';
  document.head.append(style);

  function selectedRange() {
    const end = new Date(yesterday);
    let start = new Date(end);
    if (dateFilter.value === '近 7 天') start.setDate(start.getDate() - 6);
    else if (dateFilter.value === '本月') start = new Date(end.getFullYear(), end.getMonth(), 1);
    else if (dateFilter.value === '自定义') {
      const startValue = $('#summaryCustomStart')?.value;
      const endValue = $('#summaryCustomEnd')?.value;
      if (!startValue || !endValue) throw new Error('请选择开始和结束日期');
      start = new Date(`${startValue}T00:00:00`);
      const chosenEnd = new Date(`${endValue}T00:00:00`);
      if (start > chosenEnd) throw new Error('开始日期不能晚于结束日期');
      if (chosenEnd > end) throw new Error('结束日期不能选择当天或未来日期');
      if (Math.floor((chosenEnd - start) / 86400000) + 1 > 90) throw new Error('自定义时间范围最多 90 天，超过请使用导出报表');
      end.setTime(chosenEnd.getTime());
    } else start.setDate(start.getDate() - 29);
    return { start: formatDate(start), end: formatDate(end) };
  }

  function renderShopOptions() {
    const shopFilter = $('#summaryShopFilter');
    const siteFilter = $('#summaryCountryFilter');
    const previousShop = shopFilter.value;
    shopFilter.innerHTML = `<option value="">全部已授权店铺</option>${authorizedShops.map(shop => `<option value="${escapeHtml(shop.id)}">${escapeHtml(shop.shop_name)}</option>`).join('')}`;
    shopFilter.value = [...shopFilter.options].some(option => option.value === previousShop) ? previousShop : '';
    const previousSite = siteFilter.value;
    const visibleShops = shopFilter.value ? authorizedShops.filter(shop => shop.id === shopFilter.value) : authorizedShops;
    siteFilter.innerHTML = `<option value="">全部站点</option>${[...new Set(visibleShops.map(shop => shop.country_code).filter(Boolean))].map(site => `<option value="${escapeHtml(site)}">${escapeHtml(site)}</option>`).join('')}`;
    siteFilter.value = [...siteFilter.options].some(option => option.value === previousSite) ? previousSite : '';
  }

  function filteredProducts() {
    const keyword = $('#profitProductKeyword').value.trim().toLowerCase();
    const selectedState = $('#profitProductState').value;
    return products.filter(row => (!selectedState || (row.statusItems || []).some(item => item.code === selectedState)) && (!keyword || `${row.code} ${row.sku} ${row.name}`.toLowerCase().includes(keyword)));
  }

  function sortRows(rows) {
    const key = $('#profitTabSort').value;
    return [...rows].sort((left, right) => Number(right[key] ?? -Infinity) - Number(left[key] ?? -Infinity));
  }

  function renderRows() {
    const storeRows = sortRows(stores);
    const productRows = sortRows(filteredProducts());
    $('#profitTabStoreRows').innerHTML = storeRows.length ? storeRows.map(row => {
      return `<tr><td>${escapeHtml(row.shop)}<small>${escapeHtml(row.site)}</small></td><td>${row.orders}</td><td>${money(row.sales)}</td><td>${money(row.refund)}</td><td>${money(row.platform)}</td><td>${money(row.settlement)}</td><td>${money(row.product)}</td><td>${money(row.warehouse)}</td><td>${money(row.promotion)}</td><td>${money(row.profit)}</td><td>${percent(row.margin)}</td><td>${percent(row.refundRate)}</td><td>${stateBadges(row)}</td><td><button class="detail-button" type="button" data-view="store" data-key="${escapeHtml(row.shopId)}">详情</button></td></tr>`;
    }).join('') : '<tr><td colspan="14">暂无符合筛选条件的真实数据</td></tr>';
    $('#profitTabProductRows').innerHTML = productRows.length ? productRows.map(row => `<tr><td><div class="profit-product-name"><i>◫</i><span>${escapeHtml(row.name)}</span></div></td><td>${escapeHtml(row.code)}<small>${escapeHtml(row.sku)}</small></td><td>${escapeHtml(row.shop)}</td><td>${money(row.sales)}</td><td>${row.qty}</td><td>${row.orders}</td><td>${money(row.settlement)}</td><td>${money(row.product)}</td><td>${money(row.warehouse)}</td><td>${money(row.platform)}</td><td>${money(row.promotion)}</td><td>${row.refunds} / ${percent(row.refundRate)}</td><td>${money(row.profit)}</td><td>${percent(row.margin)}</td><td>${stateBadges(row)}</td><td><button class="detail-button" type="button" data-view="product" data-key="${escapeHtml(dataKey(row))}">详情</button></td></tr>`).join('') : '<tr><td colspan="16">暂无符合筛选条件的真实数据</td></tr>';
  }

  function showDetail(view, key) {
    const row = view === 'store' ? stores.find(item => item.shopId === key) : products.find(item => dataKey(item) === key);
    if (!row) return;
    const warehouseCostRule = '按订单的 Warehouse Name、Delivery Option、Shipping Provider Name 精确匹配已授权仓库；有 Tracking ID 的订单按运单去重计费，无 Tracking ID 时仅待发货订单参与预估，已取消且无运单订单取 0。';
    const warehouseCostDetail = warehouseCostExplanation(row, view === 'product');
    const fields = view === 'store'
      ? [['店铺 / 站点', `${row.shop} · ${row.site}`], ['有效订单', row.orders], ['销售额', money(row.sales)], ['退款金额', money(row.refund)], ['平台费用', money(row.platform)], ['结算/预计金额', money(row.settlement)], ['商品成本', money(row.product)], ['仓库代发成本', money(row.warehouse)], ['仓库代发成本计费结果', warehouseCostDetail], ['仓库代发成本取值规则', warehouseCostRule], ['推广费', money(row.promotion)], ['净利润', money(row.profit)], ['净利率', percent(row.margin)], ['退款率', percent(row.refundRate)], ['数据状态', row.state]]
      : [['商品名称', row.name], ['商品编码 / SKU', `${row.code} / ${row.sku}`], ['所属店铺', row.shop], ['销量', row.qty], ['有效订单', row.orders], ['销售额', money(row.sales)], ['退款数 / 退款率', `${row.refunds} / ${percent(row.refundRate)}`], ['结算/预计金额', money(row.settlement)], ['平台费用', money(row.platform)], ['推广费', money(row.promotion)], ['商品成本', money(row.product)], ['仓库及运费成本', money(row.warehouse)], ['仓库及运费成本计费结果', warehouseCostDetail], ['仓库及运费成本取值规则', warehouseCostRule], ['数据状态', row.state]];
    $('#profitDetailContent').innerHTML = `<h2>${view === 'store' ? '店铺利润详情' : '商品利润详情'}</h2><p>统计区间：${escapeHtml(reportRange.start)} 至 ${escapeHtml(reportRange.end)} · ${escapeHtml(reportCurrency)}。数据来源为已授权店铺的订单、结算账单、仓库成本和汇率资料。</p><div class="profit-detail-grid">${fields.map(([label, value]) => `<div><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>`).join('')}</div>`;
    $('#profitDetailDialog').showModal();
  }

  async function exportProductCostMissing(shopId = '') {
    const params = new URLSearchParams({ ...reportRange, currency: reportCurrency, rateType: $('#summaryRateTypeFilter').value || 'settlement', export: 'product_cost_missing', ...(shopId ? { shopId } : {}), ...(!shopId && $('#summaryShopFilter').value ? { shopId: $('#summaryShopFilter').value } : {}), ...($('#summaryCountryFilter').value ? { site: $('#summaryCountryFilter').value } : {}) });
    const response = await fetch(`/api/business/dashboard-overview?${params}`, { headers: headers() });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.message || '导出商品成本待补订单失败');
    }
    const blob = await response.blob();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `商品成本待补_${reportRange.start}_至_${reportRange.end}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  async function loadLiveData(force = false) {
    try {
      const range = selectedRange();
      const shopId = $('#summaryShopFilter').value;
      const site = $('#summaryCountryFilter').value;
      const currency = $('#summaryCurrencyFilter').value || 'CNY';
      const rateType = $('#summaryRateTypeFilter').value || 'settlement';
      const nextKey = JSON.stringify({ account: session().accessToken || '', ...range, shopId, site, currency, rateType });
      if (!force && cacheKey === nextKey && Date.now() - cacheAt < CACHE_TTL) {
        $('#profitTabSubtitle').textContent = `真实数据（已缓存）：${range.start} 至 ${range.end} · ${reportCurrency}`;
        renderRows();
        return;
      }
      $('#profitTabSubtitle').textContent = `正在读取真实数据：${range.start} 至 ${range.end} · ${currency}`;
      const [shopResponse, dataResponse] = await Promise.all([
        fetch('/api/business/shops', { headers: headers() }),
        fetch(`/api/business/dashboard-overview?${new URLSearchParams({ ...range, currency, rateType, ...(shopId ? { shopId } : {}), ...(site ? { site } : {}), ...(force ? { refresh: 'true' } : {}) })}`, { headers: headers() })
      ]);
      const shopData = await shopResponse.json();
      const data = await dataResponse.json();
      if (!shopResponse.ok) throw new Error(shopData.message || '读取授权店铺失败');
      if (!dataResponse.ok) throw new Error(data.message || '读取利润真实数据失败');
      authorizedShops = shopData.shops || [];
      renderShopOptions();
      reportCurrency = data.currency || currency;
      reportRange = { start: data.start || range.start, end: data.end || range.end };
      stores = (data.profitReport?.stores || []).map(row => ({ ...row, orders: row.validOrders, product: row.productCost, warehouse: row.warehouseCost, profit: row.netProfit, margin: row.netMargin, state: row.dataState, statusItems: row.statusItems || [] }));
      products = (data.profitReport?.products || []).map(row => ({ ...row, orders: row.validOrders, refunds: row.refundCount, product: row.productCost, warehouse: row.warehouseCost, profit: row.netProfit, margin: row.netMargin, state: row.dataState, statusItems: row.statusItems || [] }));
      cacheKey = nextKey;
      cacheAt = Date.now();
      $('#profitTabSubtitle').textContent = `真实数据：${reportRange.start} 至 ${reportRange.end} · ${reportCurrency}`;
      renderRows();
    } catch (error) {
      stores = [];
      products = [];
      cacheKey = '';
      cacheAt = 0;
      renderRows();
      $('#profitTabSubtitle').textContent = `${error.message || '读取利润真实数据失败'}，请调整筛选条件后重试`;
    }
  }

  $('#summaryShopFilter').addEventListener('change', () => { if (authorizedShops.length) renderShopOptions(); });
  $('.profit-tab-nav').addEventListener('click', event => {
    const view = event.target.dataset.view;
    if (!view) return;
    activeView = view;
    $('#profitTabStore').classList.toggle('is-hidden', view !== 'store');
    $('#profitTabProduct').classList.toggle('is-hidden', view !== 'product');
    document.querySelectorAll('.profit-tab-nav button').forEach(button => button.classList.toggle('active', button.dataset.view === view));
  });
  $('#profitTabSort').addEventListener('change', renderRows);
  $('#profitProductKeyword').addEventListener('input', renderRows);
  $('#profitProductState').addEventListener('change', renderRows);
  card.addEventListener('click', event => {
    const exportButton = event.target.closest('[data-profit-status-export="product_cost_missing"]');
    if (exportButton) { exportProductCostMissing(exportButton.dataset.shopId).catch(error => window.alert(error.message)); return; }
    const button = event.target.closest('.detail-button'); if (button) showDetail(button.dataset.view, button.dataset.key);
  });
  $('#closeProfitDetail').addEventListener('click', () => $('#profitDetailDialog').close());
  $('#summaryAlertTrigger')?.addEventListener('click', () => {
    $('#profitDetailContent').innerHTML = '<h2>检测预警</h2><p>暂未开放，待前后端交互和预警规则接入后开放使用。</p>';
    $('#profitDetailDialog').showModal();
  });
  $('#summarySearch').addEventListener('click', event => { event.preventDefault(); loadLiveData(true); });
  $('#summaryReset').addEventListener('click', event => {
    event.preventDefault();
    $('#summaryShopFilter').value = '';
    $('#summaryCountryFilter').value = '';
    $('#summaryRateTypeFilter').value = 'settlement';
    $('#summaryDateFilter').value = '近 7 天';
    $('#summaryCurrencyFilter').value = 'CNY';
    dateControls.classList.add('is-hidden');
    cacheKey = '';
    loadLiveData(true);
  });
  $('#profitTabExport').addEventListener('click', () => {
    const rows = activeView === 'store' ? sortRows(stores) : sortRows(filteredProducts());
    const header = activeView === 'store'
      ? ['店铺', '站点', '有效订单', '销售额', '退款金额', '平台费用', '结算/预计金额', '商品成本', '仓库代发成本', '推广费', '净利润', '净利率', '退款率', '数据状态']
      : ['商品编码', 'SKU ID', '商品名称', '所属店铺', '销量', '有效订单', '销售额', '结算/预计金额', '商品成本', '仓库及运费成本', '平台费用', '推广费', '退款数', '退款率', '净利润', '净利率', '数据状态'];
    const body = rows.map(row => activeView === 'store'
      ? [row.shop, row.site, row.orders, row.sales, row.refund, row.platform, row.settlement, row.product, row.warehouse, row.promotion, row.profit, row.margin, row.refundRate, row.state]
      : [row.code, row.sku, row.name, row.shop, row.qty, row.orders, row.sales, row.settlement, row.product, row.warehouse, row.platform, row.promotion, row.refunds, row.refundRate, row.profit, row.margin, row.state]);
    const csv = [header, ...body].map(line => line.map(value => `"${String(value ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }));
    link.download = `${activeView === 'store' ? '店铺利润' : '商品利润'}_${reportRange.start || '统计'}至${reportRange.end || '统计'}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  });
  function showSummaryPage() {
    page.classList.remove('is-hidden');
    $('#topbarTitle').textContent = '利润汇总';
    $('#reportCurrency')?.classList.add('is-hidden');
    $('#topbarSubtitle').textContent = '按筛选条件查看店铺与商品利润明细';
    $('#topbarSubtitle')?.classList.remove('is-hidden');
    document.querySelectorAll('.profit-nav a').forEach(link => link.classList.toggle('active', link.getAttribute('href') === '#summary'));
    loadLiveData();
  }
  document.addEventListener('sales:navigate', event => { if (event.detail?.route === '#summary') showSummaryPage(); });
  document.addEventListener('app:authenticated', () => { if (isVisible()) setTimeout(() => loadLiveData()); });
  renderRows();
  if (isVisible()) loadLiveData();
})();
