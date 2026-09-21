(() => {
  const profitTrend = document.querySelector('#dashboard .trend-card');
  if (!profitTrend || document.querySelector('#refundTrendCard')) return;
  profitTrend.parentElement.insertAdjacentHTML('afterend', `<article class="chart-card refund-trend-card" id="refundTrendCard"><div class="card-heading"><div><h2>退款趋势</h2><p>正在读取已授权店铺的订单数据…</p></div><div class="refund-trend-controls is-hidden"><select id="refundTrendShop"><option value="">全部已授权店铺</option></select><select id="refundTrendRange"><option value="7">近 7 天</option><option value="30">近 30 天</option><option value="custom">自定义</option></select></div></div><div class="refund-custom-range is-hidden" id="refundCustomRange"><input id="refundStartDate" type="date"><span>至</span><input id="refundEndDate" type="date"></div><div class="chart-legend refund-chart-legend"><span><i class="refund-orders-line"></i>当日订单数</span><span><i class="refund-count-line"></i>退款数</span></div><div class="line-chart refund-line-chart" aria-label="退款趋势图"><div class="chart-y" id="refundTrendY"></div><div class="refund-chart-scroll"><div class="chart-area" id="refundChartArea"><svg id="refundTrendSvg" viewBox="0 0 640 205" preserveAspectRatio="none" role="img" aria-label="当日订单数与退款数折线图"></svg><div class="chart-x" id="refundTrendX"></div></div></div></div><div class="refund-daily-list" id="refundDailyList" aria-label="每日退款统计"></div><p class="refund-trend-note" id="refundTrendNote">统计口径：按下单日期去重统计订单 ID；Cancelation/Return Type 非空时计为一笔退款订单。</p></article>`);
  const card = document.querySelector('#refundTrendCard');
  let dashboardShopId = '', dashboardSite = '';
  const token = () => { try { return JSON.parse(localStorage.getItem('tiktokShopAuthSession') || sessionStorage.getItem('tiktokShopAuthSession') || '{}').accessToken || ''; } catch { return ''; } };
  const formatDate = date => date.toISOString().slice(0, 10);
  const shortDate = value => { const date = new Date(`${value}T00:00:00`); return `${date.getMonth() + 1}/${String(date.getDate()).padStart(2, '0')}`; };
  const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
  const chartPadding = 32;
  const pointX = (index, length, width) => length === 1 ? width / 2 : chartPadding + index / (length - 1) * (width - chartPadding * 2);
  const points = (values, max, width) => values.map((value, index) => `${pointX(index, values.length, width).toFixed(1)},${(190 - (value / max * 170)).toFixed(1)}`).join(' ');
  const yesterday = () => { const value = new Date(); value.setHours(0, 0, 0, 0); value.setDate(value.getDate() - 1); return value; };
  function dates() { const range = card.querySelector('#refundTrendRange').value; if (range === 'custom') return { start: card.querySelector('#refundStartDate').value, end: card.querySelector('#refundEndDate').value }; const end = yesterday(), start = new Date(end); start.setDate(end.getDate() - Number(range) + 1); return { start: formatDate(start), end: formatDate(end) }; }
  function render(series, shopLabel) {
    const safeSeries = Array.isArray(series) ? series : [];
    const orders = safeSeries.map(item => Number(item.orders || 0)), refunds = safeSeries.map(item => Number(item.refunds || 0));
    const max = Math.max(1, Math.ceil(Math.max(...orders, ...refunds, 1) / 10) * 10), chartWidth = Math.max(640, safeSeries.length * 74);
    card.querySelector('#refundTrendY').innerHTML = [max, Math.round(max * .75), Math.round(max * .5), Math.round(max * .25), 0].map(value => `<span>${value}</span>`).join('');
    const dots = (kind, valueKey, labelOffset) => safeSeries.map((item, index) => { const x = pointX(index, safeSeries.length, chartWidth), y = 190 - (Number(item[valueKey] || 0) / max * 170), value = Number(item[valueKey] || 0), rateLabel = kind === 'refund-order-dot' ? `<text x="${x.toFixed(1)}" y="${Math.max(12, y - 24).toFixed(1)}" class="refund-rate-label">${Number(item.refundRate || 0).toFixed(2)}%</text>` : '', valueY = kind === 'refund-order-dot' ? Math.max(26, Math.min(201, y + labelOffset)) : Math.max(12, Math.min(201, y + labelOffset)); return `${rateLabel}<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.5" class="${kind}"><title>${item.date}：订单 ${Number(item.orders || 0)} 笔，退款 ${Number(item.refunds || 0)} 笔，退款率 ${Number(item.refundRate || 0).toFixed(2)}%</title></circle><text x="${x.toFixed(1)}" y="${valueY.toFixed(1)}" class="${kind}-label">${value}</text>`; }).join('');
    const chartArea = card.querySelector('#refundChartArea'); chartArea.style.minWidth = `${chartWidth}px`;
    card.querySelector('#refundTrendSvg').setAttribute('viewBox', `0 0 ${chartWidth} 205`);
    card.querySelector('#refundTrendSvg').innerHTML = `<polyline points="${points(orders, max, chartWidth)}" fill="none" stroke="#4c92df" stroke-width="3"/>${dots('refund-order-dot', 'orders', -9)}<polyline points="${points(refunds, max, chartWidth)}" fill="none" stroke="#ef7e8c" stroke-width="3"/>${dots('refund-count-dot', 'refunds', 14)}`;
    card.querySelector('#refundTrendX').innerHTML = safeSeries.map(item => `<span>${shortDate(item.date)}</span>`).join('');
    const totalOrders = orders.reduce((total, value) => total + value, 0), totalRefunds = refunds.reduce((total, value) => total + value, 0), totalRate = totalOrders ? (totalRefunds / totalOrders * 100).toFixed(2) : '0.00';
    card.querySelector('.card-heading p').textContent = `${shopLabel} · ${totalOrders} 笔订单 · ${totalRefunds} 笔退款 · 退款率 ${totalRate}%`;
    card.querySelector('#refundDailyList').innerHTML = safeSeries.map((item, index) => { const current = Number(item.refundRate || 0), previous = index ? Number(safeSeries[index - 1].refundRate || 0) : null, change = previous === null ? '—' : `${current - previous >= 0 ? '+' : ''}${(current - previous).toFixed(2)} 个百分点`; return `<div class="refund-daily-item"><b>${shortDate(item.date)}</b><span>订单 <strong>${Number(item.orders || 0)}</strong></span><span>退款 <strong>${Number(item.refunds || 0)}</strong></span><em>退款率 ${current.toFixed(2)}%</em><small>较前一日 ${change}</small></div>`; }).join('') || '<p class="refund-empty">所选日期暂无订单数据</p>';
    card.querySelector('#refundTrendNote').textContent = '统计口径：读取所选店铺与日期范围内的全部订单；按下单日期、店铺和订单 ID 去重。Cancelation/Return Type 非空时，同一订单仅计一笔退款。';
  }
  async function load() {
    if (!token()) return;
    const { start, end } = dates(); if (!start || !end || start > end) return;
    const shopSelect = card.querySelector('#refundTrendShop'), note = card.querySelector('#refundTrendNote'); note.textContent = '正在读取真实订单与退款记录…';
    try {
      const params = new URLSearchParams({ start, end }); if (shopSelect.value) params.set('shopId', shopSelect.value); if (dashboardSite) params.set('site', dashboardSite);
      const response = await fetch(`/api/business/refund-trend?${params}`, { headers: { Authorization: `Bearer ${token()}` } });
      const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.message || '无法读取退款趋势');
      const selected = dashboardShopId || shopSelect.value;
      shopSelect.innerHTML = '<option value="">全部已授权店铺</option>' + (data.shops || []).map(shop => `<option value="${escapeHtml(shop.id)}">${escapeHtml(shop.shop_code || shop.shop_name)}</option>`).join('');
      shopSelect.value = (data.shops || []).some(shop => shop.id === selected) ? selected : '';
      render(data.series || [], shopSelect.selectedOptions[0]?.textContent || '全部已授权店铺');
    } catch (error) { card.querySelector('#refundTrendNote').textContent = error.message || '退款趋势读取失败'; render([], '暂无可用订单数据'); }
  }
  const range = card.querySelector('#refundTrendRange'), custom = card.querySelector('#refundCustomRange');
  range.addEventListener('change', () => { const enabled = range.value === 'custom'; custom.classList.toggle('is-hidden', !enabled); const end = yesterday(), maxDate = formatDate(end), start = new Date(end); start.setDate(end.getDate() - 6); card.querySelector('#refundStartDate').max = maxDate; card.querySelector('#refundEndDate').max = maxDate; if (enabled && (!card.querySelector('#refundEndDate').value || card.querySelector('#refundEndDate').value > maxDate)) { card.querySelector('#refundStartDate').value = formatDate(start); card.querySelector('#refundEndDate').value = maxDate; } load(); });
  card.querySelector('#refundTrendShop').addEventListener('change', load);
  card.querySelector('#refundStartDate').addEventListener('change', load);
  card.querySelector('#refundEndDate').addEventListener('change', load);
  document.addEventListener('dashboard:filters-applied', event => {
    const detail = event.detail || {}, shopSelect = card.querySelector('#refundTrendShop');
    dashboardShopId = detail.shopId || '';
    dashboardSite = detail.site || '';
    if (!detail.shopId) shopSelect.value = '';
    const rangeValue = ['7', '30'].includes(String(detail.range)) ? String(detail.range) : 'custom';
    range.value = rangeValue;
    card.querySelector('#refundStartDate').value = detail.start || '';
    card.querySelector('#refundEndDate').value = detail.end || '';
    custom.classList.add('is-hidden');
  });
  document.addEventListener('dashboard:overview-loaded', event => {
    const data = event.detail || {};
    // 退款趋势复用首页聚合已读取的订单，避免首屏再次扫描同一时间段的订单与 SKU 明细。
    if (Array.isArray(data.refundSeries)) {
      const shopLabel = dashboardShopId
        ? (card.querySelector('#refundTrendShop').selectedOptions[0]?.textContent || '已选店铺')
        : '全部已授权店铺';
      render(data.refundSeries, shopLabel);
      return;
    }
    // 兼容旧接口响应，只有未返回聚合序列时才单独读取。
    setTimeout(load, 0);
  });
  card.querySelector('#refundTrendNote').textContent = '等待首页核心数据加载完成后读取退款趋势…';
})();
