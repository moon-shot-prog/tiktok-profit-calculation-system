(() => {
  const card = document.querySelector('#dashboard .lower-grid .table-card');
  const body = card?.querySelector('tbody');
  if (!card || !body) return;
  const subtitle = card.querySelector('.card-heading p');
  if (subtitle) subtitle.textContent = '按净利润排序；净利润＝结算金额－商品成本－仓库代发成本－广告费；净利率＝净利润÷销售额';
  body.id = 'dashboardStoreRanking';
  body.innerHTML = '<tr><td colspan="4">登录后读取真实销售额</td></tr>';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const amount = (value, currency) => new Intl.NumberFormat('zh-CN', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value || 0));
  document.addEventListener('dashboard:overview-loaded', event => {
    const data = event.detail || {};
    const shops = Array.isArray(data.profitReport?.stores) ? data.profitReport.stores : [];
    const sorted = [...shops].sort((left, right) => Number(right.netProfit || 0) - Number(left.netProfit || 0));
    body.innerHTML = sorted.length ? sorted.map(shop => {
      const netProfit = Number(shop.netProfit || 0);
      const margin = Number(shop.sales || 0) ? netProfit / Number(shop.sales || 0) * 100 : null;
      const profitClass = netProfit < 0 ? 'negative' : 'positive';
      return `<tr><td><span class="shop-badge">${escape(shop.site || shop.countryCode || '—')}</span> ${escape(shop.shopCode || shop.shop || shop.shopName || '未命名店铺')}<br /><small>${escape(shop.shop || shop.shopName || '')}</small></td><td>${escape(amount(shop.sales, data.currency || 'CNY'))}</td><td class="${profitClass}">${escape(amount(netProfit, data.currency || 'CNY'))}</td><td class="${profitClass}">${margin === null ? '—' : `${margin.toFixed(2)}%`}</td></tr>`;
    }).join('') : '<tr><td colspan="4">当前筛选范围内暂无可核算利润的店铺数据</td></tr>';
  });
})();
