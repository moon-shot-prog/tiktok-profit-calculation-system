(() => {
  const body = document.querySelector('#dashboardRatesBody');
  const meta = document.querySelector('#dashboardRatesMeta');
  const explainer = document.querySelector('#dashboardRatesExplainer');
  if (!body || !meta || !explainer) return;
  const token = () => {
    try { return JSON.parse(localStorage.getItem('tiktokShopAuthSession') || sessionStorage.getItem('tiktokShopAuthSession') || '{}').accessToken || ''; }
    catch { return ''; }
  };
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const formatRate = value => Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 8, minimumFractionDigits: 2 });
  let shops = null;
  async function loadShops() {
    if (shops) return shops;
    const response = await fetch('/api/business/shops', { headers: { Authorization: `Bearer ${token()}` } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || '无法读取授权店铺');
    shops = Array.isArray(data.shops) ? data.shops : [];
    return shops;
  }
  const currentSettlementRate = (rates, base, quote) => rates.filter(rate => rate.status === 'active' && rate.base_currency === base && rate.quote_currency === quote).sort((a, b) => String(b.effective_date).localeCompare(String(a.effective_date)))[0] || null;
  async function load(detail) {
    if (!token()) return;
    body.innerHTML = '<div class="rate-row"><span>汇率数据</span><strong>—</strong><small>正在读取…</small></div>';
    meta.textContent = '正在读取汇率中心数据…';
    try {
      const quote = detail?.currency || 'CNY';
      const [availableShops, referenceResponse, settlementResponse] = await Promise.all([
        loadShops(),
        fetch(`/api/reference-rates?currency=${encodeURIComponent(quote)}`),
        fetch('/api/business/settlement-rates', { headers: { Authorization: `Bearer ${token()}` } })
      ]);
      const referenceData = await referenceResponse.json().catch(() => ({}));
      const settlementData = await settlementResponse.json().catch(() => ({}));
      if (!referenceResponse.ok) throw new Error('无法读取实时参考汇率');
      if (!settlementResponse.ok) throw new Error(settlementData.message || '无法读取报表结算汇率');
      const scopedShops = detail?.shopId ? availableShops.filter(shop => shop.id === detail.shopId) : availableShops;
      const bases = [...new Set(scopedShops.map(shop => String(shop.currency_code || '').toUpperCase()).filter(base => base && base !== quote))];
      if (!bases.length) {
        body.innerHTML = `<div class="rate-row"><span>${escape(quote)} / ${escape(quote)}</span><strong>1.00</strong><small>店铺币种与报表币种相同，无需换算</small></div>`;
        meta.textContent = '当前店铺无需进行币种换算';
        explainer.textContent = '实时参考汇率与报表结算汇率均来自汇率中心。';
        return;
      }
      const referenceByPair = new Map((referenceData.rates || []).filter(rate => rate.available).map(rate => [rate.pair, rate]));
      const settlementRates = settlementData.rates || [];
      const selectedReference = detail?.rateType === 'reference';
      body.innerHTML = bases.map(base => {
        const pair = `${base}/${quote}`;
        const reference = referenceByPair.get(pair);
        const settlement = currentSettlementRate(settlementRates, base, quote);
        const primary = selectedReference ? reference?.rate : settlement?.settlement_rate;
        const primaryLabel = selectedReference ? '实时参考' : '报表结算';
        const other = selectedReference ? (settlement ? `报表结算 ${formatRate(settlement.settlement_rate)} · 生效 ${settlement.effective_date}` : '报表结算未配置') : (reference ? `实时参考 ${formatRate(reference.rate)} · ${reference.rateDate || '当前'}` : '实时参考暂不可用');
        return `<div class="rate-row"><span>${escape(pair)}</span><strong>${primary == null ? '—' : escape(formatRate(primary))}</strong><small>${escape(primaryLabel)} · ${escape(other)}</small></div>`;
      }).join('');
      const updated = referenceData.updatedAt ? new Date(referenceData.updatedAt).toLocaleString('zh-CN', { hour12: false }) : '—';
      meta.textContent = `${selectedReference ? '当前采用实时参考汇率' : '当前采用报表结算汇率'} · 实时数据更新于 ${updated}`;
      explainer.textContent = '实时参考汇率仅供参考；报表结算汇率按订单下单日期匹配，用于金额换算。';
    } catch (error) {
      body.innerHTML = `<div class="rate-row"><span>汇率数据</span><strong>—</strong><small>${escape(error.message || '读取失败')}</small></div>`;
      meta.textContent = '汇率中心数据读取失败';
    }
  }
  document.addEventListener('dashboard:filters-applied', event => load(event.detail));
})();
