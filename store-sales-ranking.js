(() => {
  const card = document.querySelector('#dashboard .lower-grid .table-card');
  const body = card?.querySelector('tbody');
  if (!card || !body) return;
  const subtitle = card.querySelector('.card-heading p');
  if (subtitle) subtitle.textContent = '按销售额排序；净利润与净利率待成本数据完整后计算';
  body.id = 'dashboardStoreRanking';
  body.innerHTML = '<tr><td colspan="4">登录后读取真实销售额</td></tr>';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const amount = (value, currency) => new Intl.NumberFormat('zh-CN', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value || 0));
  document.addEventListener('dashboard:overview-loaded', event => {
    const data = event.detail || {};
    const shops = Array.isArray(data.storeSales) ? data.storeSales : [];
    body.innerHTML = shops.length ? shops.map(shop => `<tr><td><span class="shop-badge">${escape(shop.countryCode || '—')}</span> ${escape(shop.shopCode || shop.shopName || '未命名店铺')}<br /><small>${escape(shop.shopName || '')}</small></td><td>${escape(amount(shop.amount, data.currency || 'CNY'))}</td><td>—</td><td>—</td></tr>`).join('') : '<tr><td colspan="4">当前筛选范围内暂无店铺销售数据</td></tr>';
  });
})();
