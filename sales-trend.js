(() => {
  const card = document.querySelector('#dashboard .trend-card');
  if (!card) return;
  card.querySelector('.card-heading h2').textContent = '销售趋势';
  card.querySelector('.card-heading p').textContent = '按有效订单支付金额汇总';
  card.querySelector('.period-tabs')?.remove();
  card.querySelector('.chart-legend').innerHTML = '<span><i class="sales-line"></i>销售额</span>';
  const area = card.querySelector('.chart-area');
  area.innerHTML = '<svg id="salesTrendSvg" viewBox="0 0 640 205" preserveAspectRatio="none" role="img" aria-label="销售趋势图"></svg><div class="chart-x" id="salesTrendX"></div>';
  const format = value => new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value || 0));
  document.addEventListener('dashboard:overview-loaded', event => {
    const series = event.detail.salesSeries || [], values = series.map(item => Number(item.amount || 0));
    const max = Math.max(1, Math.ceil(Math.max(...values, 1) / 10) * 10), width = Math.max(640, series.length * 72), padding = 24;
    const x = index => series.length < 2 ? width / 2 : padding + index / (series.length - 1) * (width - padding * 2);
    const y = value => 190 - value / max * 170;
    const points = series.map((item, index) => `${x(index).toFixed(1)},${y(Number(item.amount || 0)).toFixed(1)}`).join(' ');
    const svg = card.querySelector('#salesTrendSvg'); svg.setAttribute('viewBox', `0 0 ${width} 205`); area.style.minWidth = `${width}px`;
    svg.innerHTML = `<polyline points="${points}" fill="none" stroke="#199dc3" stroke-width="3"/>${series.map((item,index)=>{ const amount=Number(item.amount||0), cx=x(index).toFixed(1), cy=y(amount).toFixed(1), labelY=Math.max(13, y(amount)-10).toFixed(1); return `<circle cx="${cx}" cy="${cy}" r="3.5" fill="#199dc3"><title>${item.date}：${event.detail.currency} ${amount.toFixed(2)}</title></circle><text x="${cx}" y="${labelY}" text-anchor="middle" fill="#168eb4" font-size="10" font-weight="700">${format(amount)}</text>`; }).join('')}`;
    card.querySelector('.chart-y').innerHTML = [max,max*.75,max*.5,max*.25,0].map(value => `<span>${format(value)}</span>`).join('');
    card.querySelector('#salesTrendX').innerHTML = series.map(item => `<span>${item.date.slice(5).replace('-', '/')}</span>`).join('');
    card.querySelector('.card-heading p').textContent = `按有效订单支付金额汇总（${event.detail.currency}）`;
  });
})();
