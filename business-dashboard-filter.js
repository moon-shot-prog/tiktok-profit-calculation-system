(() => {
  const promotionKpi = document.querySelector('#dashboardSignedRate')?.closest('article');
  if (promotionKpi) {
    const label = promotionKpi.querySelector('span');
    const note = promotionKpi.querySelector('#dashboardSignedRateNote');
    if (label) label.textContent = '推广费';
    if (note) note.innerHTML = '<em>推广管理成本</em>';
  }
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
  const DASHBOARD_CACHE_TTL = 3 * 60 * 1000;
  let dashboardCacheKey = '', dashboardCacheAt = 0, dashboardCacheData = null, authorizedShops = [];
  const token = () => {
    try {
      return JSON.parse(localStorage.getItem('tiktokShopAuthSession') || sessionStorage.getItem('tiktokShopAuthSession') || '{}').accessToken || '';
    } catch { return ''; }
  };
  const iso = date => date.toISOString().slice(0, 10);
  const yesterday = () => { const date = new Date(); date.setHours(0, 0, 0, 0); date.setDate(date.getDate() - 1); return date; };
  const selectedDates = () => {
    if (range.value === 'custom') return `${startDate.value || '—'} 至 ${endDate.value || '—'}`;
    if (range.value === 'day') return startDate.value || '—';
    const dates = dateRange();
    return `${range.selectedOptions[0]?.textContent || '近 7 天'}（${dates.start} 至 ${dates.end}）`;
  };
  const label = () => `${shop.selectedOptions[0]?.textContent || '全部已授权店铺'}${site.value ? ` · ${site.selectedOptions[0]?.textContent || site.value}` : ''} · ${selectedDates()} · ${currency.value} · ${rateType.selectedOptions[0]?.textContent || '报表结算汇率'}`;
  function dateRange() {
    const end = yesterday();
    if (range.value === 'custom') return { start: startDate.value, end: endDate.value };
    if (range.value === 'day') return { start: startDate.value, end: startDate.value };
    const start = new Date(end);
    if (range.value === '30') start.setDate(start.getDate() - 29);
    else if (range.value === 'month') start.setDate(1);
    else start.setDate(start.getDate() - 6);
    return { start: iso(start), end: iso(end) };
  }
  const formatAmount = (amount, targetCurrency) => new Intl.NumberFormat('zh-CN', { style: 'currency', currency: targetCurrency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(amount || 0));
  async function fetchOverview(params) {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(`/api/business/dashboard-overview?${params}`, { headers: { Authorization: `Bearer ${token()}` } });
        const data = await response.json().catch(() => ({}));
        if (response.ok) return data;
        if (response.status < 500) throw new Error(data.message || '读取销售额失败');
        lastError = new Error(data.message || '读取销售额失败');
      } catch (error) {
        lastError = error;
        if (/读取销售额失败/.test(error.message || '')) throw error;
      }
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
    }
    throw lastError || new Error('读取销售额失败，请稍后重试');
  }
  function displayOverview(data) {
    const gmv = document.querySelector('#dashboardGmv');
    const note = document.querySelector('#dashboardGmvNote');
    const validOrders = document.querySelector('#dashboardValidOrders');
    const validOrdersNote = document.querySelector('#dashboardValidOrdersNote');
    const settlementAmount = document.querySelector('#dashboardSettlementAmount');
    const settlementNote = document.querySelector('#dashboardSettlementNote');
    const promotionExpense = document.querySelector('#dashboardSignedRate');
    const promotionExpenseNote = document.querySelector('#dashboardSignedRateNote');
    gmv.textContent = formatAmount(data.salesAmount, data.currency);
    validOrders.textContent = new Intl.NumberFormat('zh-CN').format(Number(data.validOrderCount || 0));
    settlementAmount.textContent = data.settlementReadFailed ? '—' : formatAmount(data.settlementExpectedAmount, data.currency);
    promotionExpense.textContent = formatAmount(data.promotionExpense, data.currency);
    note.innerHTML = `<em>${data.rateType === 'reference' ? '支付金额按实时参考汇率换算' : '支付金额按下单日期匹配报表结算汇率'}${data.missingRateItemCount ? ` · ${data.missingRateItemCount} 条缺少汇率` : ''}</em>`;
    validOrdersNote.innerHTML = '<em>按销售额取值订单 ID 去重</em>';
    settlementNote.innerHTML = data.settlementReadFailed ? '<em>结算账单暂时无法读取，不影响销售额与订单数</em>' : `<em>已结算 ${data.settledOrderCount || 0} 笔 · 预计 ${data.estimatedOrderCount || 0} 笔 · ${data.rateType === 'reference' ? '实时参考汇率' : '报表结算汇率'}${data.missingBillRateOrderCount ? ` · ${data.missingBillRateOrderCount} 笔缺少汇率` : ''}</em>`;
    promotionExpenseNote.innerHTML = `<em>推广管理成本 ${data.promotionExpenseRecordCount || 0} 条 · ${data.rateType === 'reference' ? '实时参考汇率' : '报表结算汇率'}${data.missingPromotionRateCount ? ` · ${data.missingPromotionRateCount} 条缺少汇率` : ''}</em>`;
  }
  async function loadGmv(force = false) {
    const gmv = document.querySelector('#dashboardGmv');
    const note = document.querySelector('#dashboardGmvNote');
    const validOrders = document.querySelector('#dashboardValidOrders');
    const validOrdersNote = document.querySelector('#dashboardValidOrdersNote');
    const settlementAmount = document.querySelector('#dashboardSettlementAmount');
    const settlementNote = document.querySelector('#dashboardSettlementNote');
    const promotionExpense = document.querySelector('#dashboardSignedRate');
    const promotionExpenseNote = document.querySelector('#dashboardSignedRateNote');
    if (!gmv || !note || !validOrders || !validOrdersNote || !settlementAmount || !settlementNote || !promotionExpense || !promotionExpenseNote) return;
    if (!token()) return;
    const { start, end } = dateRange();
    if (!start || !end || start > end) return;
    const cacheKey = JSON.stringify({ account: token(), start, end, shopId: shop.value, site: site.value, currency: currency.value, rateType: rateType.value });
    if (!force && dashboardCacheKey === cacheKey && Date.now() - dashboardCacheAt < DASHBOARD_CACHE_TTL) {
      displayOverview(dashboardCacheData);
      document.dispatchEvent(new CustomEvent('dashboard:overview-loaded', { detail: dashboardCacheData }));
      return;
    }
    const hasPreviousResult = dashboardCacheKey === cacheKey && dashboardCacheData;
    if (hasPreviousResult) {
      displayOverview(dashboardCacheData);
      note.innerHTML = '<em>正在更新最新数据…</em>';
    } else {
      gmv.textContent = '—'; validOrders.textContent = '—'; settlementAmount.textContent = '—'; promotionExpense.textContent = '—';
      note.innerHTML = '<em>正在按报表结算汇率换算…</em>'; validOrdersNote.innerHTML = '<em>正在读取订单…</em>'; settlementNote.innerHTML = '<em>正在匹配结算账单…</em>'; promotionExpenseNote.innerHTML = '<em>正在读取推广管理成本…</em>';
    }
    try {
      const params = new URLSearchParams({ start, end, currency: currency.value, rateType: rateType.value, view: 'dashboard', ...(force ? { refresh: 'true' } : {}) });
      if (shop.value) params.set('shopId', shop.value);
      if (site.value) params.set('site', site.value);
      const data = await fetchOverview(params);
      dashboardCacheKey = cacheKey; dashboardCacheAt = Date.now(); dashboardCacheData = data;
      displayOverview(data);
      document.dispatchEvent(new CustomEvent('dashboard:overview-loaded', { detail: data }));
    } catch (error) {
      const message = error.message || '数据读取失败';
      if (hasPreviousResult) {
        displayOverview(dashboardCacheData);
        note.innerHTML = `<em>最新读取失败，已保留上次结果：${message}</em>`;
      } else {
        gmv.textContent = '—'; validOrders.textContent = '—'; settlementAmount.textContent = '—'; promotionExpense.textContent = '—';
        note.innerHTML = `<em>${message}</em>`; validOrdersNote.innerHTML = '<em>—</em>'; settlementNote.innerHTML = '<em>—</em>'; promotionExpenseNote.innerHTML = '<em>—</em>';
      }
    }
  }
  const apply = (force = false) => {
    scope.textContent = `统计范围：${label()}。`;
    const dates = dateRange();
    document.dispatchEvent(new CustomEvent('dashboard:filters-applied', { detail: { shopId: shop.value, site: site.value, range: range.value, start: dates.start, end: dates.end, currency: currency.value, rateType: rateType.value } }));
    loadGmv(force);
  };
  function syncDateControls() {
    const isCustom = range.value === 'custom', isDay = range.value === 'day';
    dateControls.classList.toggle('is-hidden', !isCustom && !isDay);
    startLabel.firstChild.textContent = isDay ? '选择日期' : '开始日期';
    divider.classList.toggle('is-hidden', isDay);
    endLabel.classList.toggle('is-hidden', isDay);
    const max = iso(yesterday());
    startDate.max = max; endDate.max = max;
    if (!startDate.value || startDate.value > max) startDate.value = max;
    if (!endDate.value || endDate.value > max) endDate.value = max;
  }
  async function loadShops() {
    try {
      const response = await fetch('/api/business/shops', { headers: { Authorization: `Bearer ${token()}` } });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || '无法读取店铺');
      authorizedShops = data.shops || [];
      const current = shop.value;
      shop.innerHTML = '<option value="">全部已授权店铺</option>' + authorizedShops.map(item => `<option value="${String(item.id || '').replace(/&/g, '&amp;').replace(/\"/g, '&quot;')}">${String(item.shop_code || item.shop_name || '').replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char])}</option>`).join('');
      shop.value = [...shop.options].some(option => option.value === current) ? current : '';
      syncSiteOptions();
    } catch { /* 读取失败时保留“全部已授权店铺”默认选项。 */ }
  }
  function syncSiteOptions() {
    const current = site.value;
    const available = shop.value ? authorizedShops.filter(item => item.id === shop.value) : authorizedShops;
    const sites = [...new Set(available.map(item => item.country_code).filter(Boolean))];
    site.innerHTML = `<option value="">全部站点</option>${sites.map(value => `<option value="${String(value).replace(/&/g, '&amp;').replace(/\"/g, '&quot;')}">${String(value).replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char])}</option>`).join('')}`;
    site.value = [...site.options].some(option => option.value === current) ? current : '';
  }
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (range.value === 'custom' && startDate.value && endDate.value && startDate.value > endDate.value) { scope.textContent = '开始日期不能晚于结束日期'; return; }
    apply(true);
  });
  range.addEventListener('change', syncDateControls);
  shop.addEventListener('change', syncSiteOptions);
  form.querySelector('#dashboardFilterReset').addEventListener('click', () => { shop.value = ''; syncSiteOptions(); site.value = ''; range.value = '7'; currency.value = 'CNY'; rateType.value = 'settlement'; syncDateControls(); apply(true); });
  document.addEventListener('app:authenticated', () => { loadShops().then(apply); });
  currency.value = 'CNY';
  syncDateControls();
  loadShops().then(apply);
})();
