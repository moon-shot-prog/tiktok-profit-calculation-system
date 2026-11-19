(() => {
  const form = document.querySelector('#dashboardFilters');
  if (!form) return;
  const shop = form.querySelector('#dashboardShopFilter');
  const siteLabel = document.createElement('label');
  siteLabel.innerHTML = '国家站点<select id="dashboardSiteFilter"><option value="">全部站点</option></select>';
  shop.closest('label')?.after(siteLabel);
  const site = form.querySelector('#dashboardSiteFilter');
  const range = form.querySelector('#dashboardRangeFilter');
  const currency = form.querySelector('#dashboardCurrencyFilter');
  const rateType = form.querySelector('#dashboardRateTypeFilter');
  const dateControls = form.querySelector('#dashboardDateControls');
  const startDate = form.querySelector('#dashboardStartDate');
  const endDate = form.querySelector('#dashboardEndDate');
  const startLabel = form.querySelector('#dashboardStartLabel');
  const endLabel = form.querySelector('#dashboardEndLabel');
  const divider = form.querySelector('#dashboardDateDivider');
  const scope = document.querySelector('#dashboardScopeText');
  const previewScope = document.querySelector('#dashboardPreviewScope');
  const ids = ['dashboardSettlementAmount', 'dashboardSettlementNote', 'dashboardProductCost', 'dashboardProductCostNote', 'dashboardWarehouseCost', 'dashboardWarehouseCostNote', 'dashboardPromotionExpense', 'dashboardPromotionExpenseNote', 'dashboardNetProfit', 'dashboardNetProfitNote', 'dashboardNetMargin', 'dashboardNetMarginNote'];
  const elements = Object.fromEntries(ids.map(id => [id, document.querySelector(`#${id}`)]));
  const DASHBOARD_CACHE_TTL = 3 * 60 * 1000;
  let dashboardCacheKey = '', dashboardCacheAt = 0, dashboardCacheData = null, authorizedShops = [], overviewRequestSequence = 0;
  const token = () => { try { return JSON.parse(localStorage.getItem('tiktokShopAuthSession') || sessionStorage.getItem('tiktokShopAuthSession') || '{}').accessToken || ''; } catch { return ''; } };
  const iso = date => date.toISOString().slice(0, 10);
  const yesterday = () => { const date = new Date(); date.setHours(0, 0, 0, 0); date.setDate(date.getDate() - 1); return date; };
  const formatAmount = (amount, targetCurrency) => new Intl.NumberFormat('zh-CN', { style: 'currency', currency: targetCurrency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(amount || 0));
  const formatPercent = value => `${Number(value || 0).toFixed(2)}%`;
  const setText = (id, value) => { if (elements[id]) elements[id].textContent = value; };
  const selectedDates = () => { if (range.value === 'custom') return `${startDate.value || '—'} 至 ${endDate.value || '—'}`; if (range.value === 'day') return startDate.value || '—'; const dates = dateRange(); return `${range.selectedOptions[0]?.textContent || '近 7 天'}（${dates.start} 至 ${dates.end}）`; };
  const label = () => `${shop.selectedOptions[0]?.textContent || '全部已授权店铺'}${site.value ? ` · ${site.selectedOptions[0]?.textContent || site.value}` : ''} · ${selectedDates()} · ${currency.value} · ${rateType.selectedOptions[0]?.textContent || '报表结算汇率'}`;
  function dateRange() { const end = yesterday(); if (range.value === 'custom') return { start: startDate.value, end: endDate.value }; if (range.value === 'day') return { start: startDate.value, end: startDate.value }; const start = new Date(end); if (range.value === '30') start.setDate(start.getDate() - 29); else if (range.value === 'month') start.setDate(1); else start.setDate(start.getDate() - 6); return { start: iso(start), end: iso(end) }; }
  async function fetchOverview(params) { let lastError; for (let attempt = 0; attempt < 3; attempt++) { try { const response = await fetch(`/api/business/dashboard-overview?${params}`, { headers: { Authorization: `Bearer ${token()}` } }); const data = await response.json().catch(() => ({})); if (response.ok) return data; if (response.status < 500) throw new Error(data.message || '读取利润数据失败'); lastError = new Error(data.message || '读取利润数据失败'); } catch (error) { lastError = error; if (/读取利润数据失败/.test(error.message || '')) throw error; } if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1))); } throw lastError || new Error('读取利润数据失败，请稍后重试'); }
  function totals(data) { return (data.profitReport?.stores || []).reduce((sum, row) => ({ settlement: sum.settlement + Number(row.settlement || 0), productCost: sum.productCost + Number(row.productCost || 0), warehouseCost: sum.warehouseCost + Number(row.warehouseCost || 0), promotion: sum.promotion + Number(row.promotion || 0), netProfit: sum.netProfit + Number(row.netProfit || 0), warehouseOrders: sum.warehouseOrders + Number(row.warehouseCostMatchedOrderCount || 0) }), { settlement: 0, productCost: 0, warehouseCost: 0, promotion: 0, netProfit: 0, warehouseOrders: 0 }); }
  function displayOverview(data) {
    const total = totals(data); const settled = Number(data.settledOrderCount || 0), estimated = Number(data.estimatedOrderCount || 0), validOrders = Number(data.validOrderCount || 0), margin = total.settlement ? total.netProfit / total.settlement * 100 : 0;
    const orderCount = value => `${Number(value || 0).toLocaleString('zh-CN')} 单`;
    setText('dashboardSettlementAmount', data.settlementReadFailed ? '—' : formatAmount(total.settlement, data.currency));
    setText('dashboardSettlementNote', data.settlementReadFailed ? '结算账单暂时无法读取' : `${orderCount(settled + estimated)} · 已结算 ${settled} 单、预计 ${estimated} 单`);
    setText('dashboardProductCost', formatAmount(total.productCost, data.currency));
    setText('dashboardProductCostNote', `${orderCount(validOrders)} · 按商品成本版本核算`);
    setText('dashboardWarehouseCost', formatAmount(total.warehouseCost, data.currency));
    setText('dashboardWarehouseCostNote', `${orderCount(total.warehouseOrders)} · 按仓库代发费用版本核算`);
    setText('dashboardPromotionExpense', formatAmount(total.promotion || data.promotionExpense, data.currency));
    setText('dashboardPromotionExpenseNote', `${orderCount(validOrders)} · 推广费用 ${Number(data.promotionExpenseRecordCount || 0)} 条`);
    setText('dashboardNetProfit', data.settlementReadFailed ? '—' : formatAmount(total.netProfit, data.currency));
    setText('dashboardNetProfitNote', `${orderCount(validOrders)} · 结算 − 商品成本 − 仓库代发 − 广告费`);
    setText('dashboardNetMargin', data.settlementReadFailed ? '—' : formatPercent(margin));
    setText('dashboardNetMarginNote', `${orderCount(validOrders)} · 利润 ÷ 结算金额`);
    if (previewScope) previewScope.textContent = `${data.start} 至 ${data.end} · ${data.currency} · ${data.rateType === 'reference' ? '实时参考汇率' : '报表结算汇率'}`;
  }
  function setLoading(message = '正在读取当前筛选范围…') { ['dashboardSettlementAmount', 'dashboardProductCost', 'dashboardWarehouseCost', 'dashboardPromotionExpense', 'dashboardNetProfit', 'dashboardNetMargin'].forEach(id => setText(id, '—')); setText('dashboardSettlementNote', message); setText('dashboardProductCostNote', '正在匹配商品成本'); setText('dashboardWarehouseCostNote', '正在匹配仓库代发费用'); setText('dashboardPromotionExpenseNote', '正在读取推广管理成本'); setText('dashboardNetProfitNote', '正在核算利润'); setText('dashboardNetMarginNote', '正在核算利润率'); if (previewScope) previewScope.textContent = message; }
  async function loadOverview(force = false) {
    if (!ids.every(id => elements[id]) || !token()) return;
    const requestSequence = ++overviewRequestSequence;
    const { start, end } = dateRange(); if (!start || !end || start > end) return;
    const cacheKey = JSON.stringify({ account: token(), start, end, shopId: shop.value, site: site.value, currency: currency.value, rateType: rateType.value });
    if (!force && dashboardCacheKey === cacheKey && Date.now() - dashboardCacheAt < DASHBOARD_CACHE_TTL) { displayOverview(dashboardCacheData); document.dispatchEvent(new CustomEvent('dashboard:overview-loaded', { detail: dashboardCacheData })); return; }
    const hasPreviousResult = dashboardCacheKey === cacheKey && dashboardCacheData;
    if (hasPreviousResult) displayOverview(dashboardCacheData); else setLoading();
    try { const params = new URLSearchParams({ start, end, currency: currency.value, rateType: rateType.value, view: 'dashboard', profitPreview: 'true', ...(force ? { refresh: 'true' } : {}) }); if (shop.value) params.set('shopId', shop.value); if (site.value) params.set('site', site.value); const data = await fetchOverview(params); if (requestSequence !== overviewRequestSequence) return; dashboardCacheKey = cacheKey; dashboardCacheAt = Date.now(); dashboardCacheData = data; displayOverview(data); document.dispatchEvent(new CustomEvent('dashboard:overview-loaded', { detail: data })); } catch (error) { if (requestSequence !== overviewRequestSequence) return; const message = error.message || '数据读取失败'; if (hasPreviousResult) { displayOverview(dashboardCacheData); setText('dashboardSettlementNote', `最新读取失败，已保留上次结果：${message}`); } else setLoading(message); }
  }
  const apply = (force = false) => { scope.textContent = `统计范围：${label()}。`; const dates = dateRange(); document.dispatchEvent(new CustomEvent('dashboard:filters-applied', { detail: { shopId: shop.value, site: site.value, range: range.value, start: dates.start, end: dates.end, currency: currency.value, rateType: rateType.value } })); loadOverview(force); };
  function syncDateControls() { const isCustom = range.value === 'custom', isDay = range.value === 'day'; dateControls.classList.toggle('is-hidden', !isCustom && !isDay); startLabel.firstChild.textContent = isDay ? '选择日期' : '开始日期'; divider.classList.toggle('is-hidden', isDay); endLabel.classList.toggle('is-hidden', isDay); const max = iso(yesterday()); startDate.max = max; endDate.max = max; if (!startDate.value || startDate.value > max) startDate.value = max; if (!endDate.value || endDate.value > max) endDate.value = max; }
  async function loadShops() { try { const response = await fetch('/api/business/shops', { headers: { Authorization: `Bearer ${token()}` } }); const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.message || '无法读取店铺'); authorizedShops = data.shops || []; const current = shop.value; shop.innerHTML = '<option value="">全部已授权店铺</option>' + authorizedShops.map(item => `<option value="${String(item.id || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">${String(item.shop_code || item.shop_name || '').replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char])}</option>`).join(''); shop.value = [...shop.options].some(option => option.value === current) ? current : ''; syncSiteOptions(); } catch { /* 保留默认选项。 */ } }
  function syncSiteOptions() { const current = site.value; const available = shop.value ? authorizedShops.filter(item => item.id === shop.value) : authorizedShops; const sites = [...new Set(available.map(item => item.country_code).filter(Boolean))]; site.innerHTML = `<option value="">全部站点</option>${sites.map(value => `<option value="${String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">${String(value).replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char])}</option>`).join('')}`; site.value = [...site.options].some(option => option.value === current) ? current : ''; }
  form.addEventListener('submit', event => { event.preventDefault(); if (range.value === 'custom' && startDate.value && endDate.value && startDate.value > endDate.value) { scope.textContent = '开始日期不能晚于结束日期'; return; } apply(true); });
  range.addEventListener('change', syncDateControls); shop.addEventListener('change', syncSiteOptions);
  form.querySelector('#dashboardFilterReset').addEventListener('click', () => { shop.value = ''; syncSiteOptions(); site.value = ''; range.value = '7'; currency.value = 'CNY'; rateType.value = 'settlement'; syncDateControls(); apply(true); });
  document.addEventListener('app:authenticated', () => { loadShops().then(apply); });
  currency.value = 'CNY'; syncDateControls(); loadShops().then(apply);
})();
