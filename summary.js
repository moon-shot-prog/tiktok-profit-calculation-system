(() => {
  const page = document.querySelector('#summaryPage');
  if (!page) return;
  const rows = [
    { id: 'us', shop: 'US Fashion Store', country: '美国', gmv: 52468.8, orders: 982, product: 23911.6, shipping: 8340.5, platform: 3912.9, refund: 1549.8, cost: 36187.18, profit: 16281.62, margin: 31.03, refundRate: 2.95, complete: '正常' },
    { id: 'ph', shop: 'PH Lifestyle Store', country: '菲律宾', gmv: 20142.18, orders: 411, product: 9820.6, shipping: 3407.2, platform: 1675.1, refund: 975.4, cost: 14270.03, profit: 5872.15, margin: 29.15, refundRate: 4.84, complete: '部分缺失' },
    { id: 'id', shop: 'ID Trend Store', country: '印尼', gmv: 18234.6, orders: 356, product: 8661.1, shipping: 3104.7, platform: 1442.4, refund: 742.1, cost: 13910.3, profit: 4324.3, margin: 23.71, refundRate: 4.07, complete: '部分缺失' },
    { id: 'vn', shop: 'VN Home Store', country: '越南', gmv: 16189.3, orders: 318, product: 8150.2, shipping: 3052.1, platform: 1260.8, refund: 976.4, cost: 14286.2, profit: 1903.1, margin: 11.76, refundRate: 6.03, complete: '不可计算' },
    { id: 'th', shop: 'TH Market Store', country: '泰国', gmv: 21605.4, orders: 419, product: 11521.9, shipping: 2366.8, platform: 1665.2, refund: 701.4, cost: 15984.8, profit: 5620.6, margin: 26.01, refundRate: 3.25, complete: '正常' }
  ];
  const $ = selector => document.querySelector(selector);
  page.classList.add('summary-demo-page');
  page.querySelector('.cost-list')?.closest('.summary-card')?.remove();
  const alertCard = page.querySelector('.summary-alerts');
  const alertContent = alertCard?.querySelector('#summaryAlerts');
  const alertDialog = document.createElement('dialog');
  alertDialog.className = 'summary-alert-dialog';
  alertDialog.innerHTML = '<button class="dialog-close" type="button" aria-label="关闭">×</button><h2>异常提醒</h2><p>请关注可能影响利润统计准确性的事项。</p>';
  if (alertContent) alertDialog.append(alertContent);
  document.body.append(alertDialog);
  alertCard?.remove();
  const alertButton = document.createElement('button');
  alertButton.type = 'button'; alertButton.className = 'summary-alert-trigger'; alertButton.textContent = '异常提醒';
  page.querySelector('.summary-filters')?.append(alertButton);
  alertButton.addEventListener('click', () => alertDialog.showModal());
  alertDialog.querySelector('.dialog-close').addEventListener('click', () => alertDialog.close());
  const demoStyle = document.createElement('style');
  demoStyle.textContent = '.summary-demo-page > .summary-grid:first-of-type{grid-template-columns:1fr}.summary-alert-trigger{height:36px;padding:0 14px;border:1px solid #dfe6ef;border-radius:7px;background:#fff;color:#69758a;font:12px inherit;cursor:pointer}.summary-alert-dialog{width:min(480px,calc(100% - 30px));border:0;border-radius:12px;padding:24px;box-shadow:0 25px 70px #1a284044}.summary-alert-dialog::backdrop{background:#18243966}.summary-alert-dialog h2{margin:0 0 6px;font-size:18px}.summary-alert-dialog>p{margin:0 0 14px;color:#7d8d9d;font-size:12px}.summary-alert-dialog .dialog-close{float:right;border:0;background:transparent;color:#637b99;font-size:24px;cursor:pointer}.summary-alert-dialog #summaryAlerts{max-height:360px;overflow:auto}';
  document.head.append(demoStyle);
  const legacyWarehouse = $('#summaryWarehouseFilter');
  if (legacyWarehouse) legacyWarehouse.closest('label').innerHTML = '汇率选项<select id="summaryRateTypeFilter"><option value="settlement">报表结算汇率</option><option value="reference">实时参考汇率</option></select>';
  let conversionRate = 7.1842;
  let rateSourceText = '报表结算汇率';
  const fmt = (amount, currency = 'USD') => currency === 'CNY' ? `¥${(amount * conversionRate).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  function loadRate() {
    const type = $('#summaryRateTypeFilter')?.value || 'settlement';
    conversionRate = type === 'reference' ? 7.18 : 7.1842;
    rateSourceText = `${type === 'reference' ? '实时参考汇率' : '报表结算汇率'}（示例）· USD/CNY ${conversionRate.toFixed(4)}`;
  }
  function visible() { const shop = $('#summaryShopFilter').value, country = $('#summaryCountryFilter').value; return rows.filter(row => (!shop || row.shop === shop) && (!country || row.country === country)); }
  const classFor = state => state === '正常' ? '' : state === '部分缺失' ? 'partial' : 'none';
  function render() {
    loadRate(); const list = visible(), currency = $('#summaryCurrencyFilter').value;
    const total = list.reduce((sum, row) => ({ gmv: sum.gmv + row.gmv, orders: sum.orders + row.orders, cost: sum.cost + row.cost, profit: sum.profit + row.profit, refund: sum.refund + row.refund }), { gmv: 0, orders: 0, cost: 0, profit: 0, refund: 0 });
    const margin = total.gmv ? total.profit / total.gmv * 100 : 0, refundRate = total.gmv ? total.refund / total.gmv * 100 : 0;
    $('#summaryGmv').textContent = fmt(total.gmv, currency); $('#summaryOrders').textContent = total.orders.toLocaleString(); $('#summaryCosts').textContent = fmt(total.cost, currency); $('#summaryProfit').textContent = fmt(total.profit, currency); $('#summaryMargin').textContent = `净利率 ${margin.toFixed(2)}%`; $('#summaryRefund').textContent = `${refundRate.toFixed(2)}%`;
    $('#summaryScope').textContent = `统计范围：${list.length === 1 ? list[0].shop : '全部已授权店铺'} · ${$('#summaryDateFilter').value} · ${currency} · ${rateSourceText}`;
    const sorters = { profit: (a, b) => b.profit - a.profit, gmv: (a, b) => b.gmv - a.gmv, margin: (a, b) => b.margin - a.margin, loss: (a, b) => a.profit - b.profit, refund: (a, b) => b.refundRate - a.refundRate };
    const sorted = [...list].sort(sorters[$('#summarySort').value]);
    $('#summaryStoresBody').innerHTML = sorted.map(row => `<tr><td>${row.shop}</td><td>${fmt(row.gmv, currency)}</td><td>${fmt(row.cost, currency)}</td><td class="${row.profit >= 0 ? 'positive' : ''}">${fmt(row.profit, currency)}</td><td>${row.margin.toFixed(2)}%</td><td><span class="completion ${classFor(row.complete)}">${row.complete}</span></td><td><button class="detail-button" data-profit="${row.id}">详情</button></td></tr>`).join('') || '<tr><td colspan="7">没有符合筛选条件的利润数据</td></tr>';
    $('#summaryDetailBody').innerHTML = sorted.map(row => `<tr><td>${row.shop}</td><td>${fmt(row.gmv, currency)}</td><td>${row.orders}</td><td>${fmt(row.product, currency)}</td><td>${fmt(row.shipping, currency)}</td><td>${fmt(row.platform, currency)}</td><td>${fmt(row.refund, currency)}</td><td>${fmt(row.cost, currency)}</td><td class="${row.profit >= 0 ? 'positive' : ''}">${fmt(row.profit, currency)}</td><td>${row.margin.toFixed(2)}%</td><td><span class="completion ${classFor(row.complete)}">${row.complete}</span></td><td><button class="detail-button" data-profit="${row.id}">详情</button></td></tr>`).join('') || '<tr><td colspan="12">没有符合筛选条件的利润数据</td></tr>';
    $('#summaryAlerts').innerHTML = list.filter(row => row.complete !== '正常').map(row => `<a href="#"><span class="alert-icon ${row.complete === '不可计算' ? '' : 'warn'}">!</span><div><b>${row.shop}：${row.complete === '不可计算' ? '关键成本数据缺失' : '利润数据部分缺失'}</b><p>${row.complete === '不可计算' ? '请等待管理员补齐成本与同步数据' : '部分 SKU 成本或订单数据待补充'}</p></div></a>`).join('') || '<p class="summary-empty">当前统计范围内暂无异常提醒</p>';
  }
  function show() { ['#dashboard', '#currencyPage', '#productsPage', '#shippingPage', '#ordersPage', '#storesPage'].forEach(id => $(id)?.classList.add('is-hidden')); page.classList.remove('is-hidden'); $('#topbarTitle').textContent = '利润汇总'; $('#reportCurrency').classList.add('is-hidden'); $('#topbarSubtitle').textContent = '默认按店铺查看经营表现与利润数据完整度'; $('#topbarSubtitle').classList.remove('is-hidden'); document.querySelectorAll('.profit-nav a').forEach(link => link.classList.toggle('active', link.getAttribute('href') === '#summary')); render(); }
  document.addEventListener('sales:navigate', event => { if (event.detail?.route === '#summary') show(); }); $('#summarySearch')?.addEventListener('click', render); $('#summarySort')?.addEventListener('change', render);
  $('#summaryReset')?.addEventListener('click', () => { ['#summaryShopFilter', '#summaryCountryFilter'].forEach(id => $(id).value = ''); $('#summaryRateTypeFilter').value = 'settlement'; $('#summaryDateFilter').value = '近 30 天'; $('#summaryCurrencyFilter').value = 'USD'; $('#summarySort').value = 'profit'; render(); });
  const dialog = $('#profitDetailDialog'); document.addEventListener('click', event => { const id = event.target.dataset.profit; if (!id) return; const row = rows.find(item => item.id === id), currency = $('#summaryCurrencyFilter').value; $('#profitDetailContent').innerHTML = `<h2>${row.shop} · 利润明细</h2><p>${row.country} · 按店铺汇总 · 近 30 天</p><div class="profit-detail-grid">${[['销售额', fmt(row.gmv, currency)], ['有效订单数', row.orders], ['商品成本', fmt(row.product, currency)], ['物流与代发成本', fmt(row.shipping, currency)], ['平台与支付费用', fmt(row.platform, currency)], ['退款金额', fmt(row.refund, currency)], ['总成本', fmt(row.cost, currency)], ['净利润', fmt(row.profit, currency)], ['净利率', `${row.margin.toFixed(2)}%`], ['汇率取值', rateSourceText], ['数据完整度', row.complete], ['数据来源', '订单、结算单、商品与仓库成本']].map(([label, value]) => `<div><span>${label}</span><strong>${value}</strong></div>`).join('')}</div>${row.complete === '正常' ? '' : '<div class="profit-detail-note">该店铺存在数据缺失。利润仅供参考，管理员补齐相关成本或订单数据后将自动更新。</div>'}`; dialog.showModal(); }); $('#closeProfitDetail')?.addEventListener('click', () => dialog.close()); render();
})();
