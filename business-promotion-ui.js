(() => {
  const page = document.querySelector('#businessPromotionsPage');
  if (!page) return;
  let rows = [], shops = [], pageNo = 1, pageSize = 20, hasLoaded = false, loadedAccessToken = '';
  const filters = { shopId: '', start: '', end: '', currency: 'USD', rateType: 'settlement' };
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const session = () => { try { return JSON.parse(localStorage.getItem('tiktokShopAuthSession') || sessionStorage.getItem('tiktokShopAuthSession') || '{}'); } catch { return {}; } };
  const amount = value => Number(value || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  const api = async url => { const response = await fetch(url, { headers: { Authorization: `Bearer ${session().accessToken || ''}` } }); const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.message || '读取推广数据失败'); return data; };
  const visible = () => rows.filter(row => (!filters.shopId || row.shop_id === filters.shopId) && (!filters.start || row.promotion_date >= filters.start) && (!filters.end || row.promotion_date <= filters.end));
  function draw() {
    const filtered = visible(), pages = Math.max(1, Math.ceil(filtered.length / pageSize)); pageNo = Math.min(pageNo, pages);
    const slice = filtered.slice((pageNo - 1) * pageSize, pageNo * pageSize);
    page.querySelector('#businessPromotionRows').innerHTML = slice.map(row => {
      const average = !row.conversion_missing && Number(row.order_count) ? Number(row.cost_amount) / Number(row.order_count) : null;
      const roi = !row.conversion_missing && Number(row.cost_amount) ? Number(row.revenue_amount) / Number(row.cost_amount) : null;
      return `<tr><td><strong>${escape(row.shops?.shop_name || '—')}</strong><small>${escape(row.shops?.country_code || '—')}</small></td><td>${escape(String(row.promotion_date || '').slice(0, 10))}</td><td>${row.conversion_missing ? '—' : amount(row.cost_amount)}</td><td>${Number(row.order_count || 0).toLocaleString('zh-CN')}</td><td>${average === null ? '—' : amount(average)}</td><td>${row.conversion_missing ? '—' : amount(row.revenue_amount)}</td><td class="business-promotion-roi">${roi === null ? '—' : roi.toFixed(2)}</td><td>${escape(row.currency_code || filters.currency)}</td></tr>`;
    }).join('') || '<tr><td colspan="8" class="business-promotion-empty">暂无符合筛选条件的推广数据</td></tr>';
    page.querySelector('#businessPromotionTotal').textContent = `共 ${filtered.length} 条，第 ${pageNo} / ${pages} 页`;
    page.querySelector('#businessPromotionPrev').disabled = pageNo === 1; page.querySelector('#businessPromotionNext').disabled = pageNo === pages;
  }
  function exportCsv() {
    const header = ['店铺/站点', '按天', '成本', 'SKU 订单数（当前店铺）', '平均下单成本（当前店铺）', '总收入（当前店铺）', '投资回报率 (ROI)（当前店铺）', '币种'];
    const content = visible().map(row => { const average = !row.conversion_missing && Number(row.order_count) ? Number(row.cost_amount) / Number(row.order_count) : ''; const roi = !row.conversion_missing && Number(row.cost_amount) ? Number(row.revenue_amount) / Number(row.cost_amount) : ''; return [`${row.shops?.shop_name || ''} / ${row.shops?.country_code || ''}`, row.promotion_date, row.conversion_missing ? '' : row.cost_amount, row.order_count || 0, average, row.conversion_missing ? '' : row.revenue_amount, roi === '' ? '' : Number(roi.toFixed(2)), row.currency_code || filters.currency].map(value => `"${String(value ?? '').replace(/"/g, '""')}"`).join(','); });
    const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([`\uFEFF${header.join(',')}\r\n${content.join('\r\n')}`], { type: 'text/csv;charset=utf-8' })); link.download = `推广管理_${filters.currency}_${new Date().toISOString().slice(0, 10)}.csv`; link.click(); URL.revokeObjectURL(link.href);
  }
  async function load() {
    const body = page.querySelector('#businessPromotionRows'); if (body) body.innerHTML = '<tr><td colspan="8" class="business-promotion-empty">正在读取已授权店铺推广数据…</td></tr>';
    try { const data = await api(`/api/business/promotions?currency=${encodeURIComponent(filters.currency)}&rateType=${encodeURIComponent(filters.rateType)}`); rows = data.promotions || []; shops = data.shops || []; loadedAccessToken = session().accessToken || ''; hasLoaded = true; if (page.querySelector('#businessPromotionShop')) page.querySelector('#businessPromotionShop').innerHTML = `<option value="">全部已授权店铺</option>${shops.map(shop => `<option value="${escape(shop.id)}" ${filters.shopId === shop.id ? 'selected' : ''}>${escape(shop.shop_name)} · ${escape(shop.country_code)}</option>`).join('')}`; draw(); return true; }
    catch (error) { if (body) body.innerHTML = `<tr><td colspan="8" class="business-promotion-empty">${escape(error.message)}</td></tr>`; return false; }
  }
  function render() {
    page.innerHTML = `<section class="business-promotion-filters"><label>店铺<select id="businessPromotionShop"><option value="">全部已授权店铺</option></select></label><label>日期<span><input id="businessPromotionStart" type="date" value="${escape(filters.start)}" /> 至 <input id="businessPromotionEnd" type="date" value="${escape(filters.end)}" /></span></label><label>币种<select id="businessPromotionCurrency"><option value="USD">USD</option><option value="CNY">人民币</option></select></label><label>汇率选项<select id="businessPromotionRateType"><option value="settlement">报表结算汇率</option><option value="reference">实时参考汇率</option></select></label><div><button type="button" id="businessPromotionSearch">查询</button><button type="button" id="businessPromotionReset" class="secondary">重置</button><button type="button" id="businessPromotionExport" class="secondary">导出数据</button></div></section><p class="business-promotion-note">只读数据：首次进入或点击查询时读取数据；离开页面再返回会保留当前数据和筛选条件。金额按所选币种及汇率选项换算。</p><section class="business-promotion-table"><div class="business-promotion-table-scroll"><table><thead><tr><th>店铺 / 站点</th><th>按天</th><th>成本</th><th>SKU 订单数（当前店铺）</th><th>平均下单成本（当前店铺）</th><th>总收入（当前店铺）</th><th>投资回报率 (ROI)（当前店铺）</th><th>币种</th></tr></thead><tbody id="businessPromotionRows"></tbody></table></div><div class="product-pagination"><span id="businessPromotionTotal">共 0 条，第 1 / 1 页</span><label>每页<select id="businessPromotionPageSize"><option value="20">20 条/页</option><option value="50">50 条/页</option><option value="100">100 条/页</option></select></label><div><button id="businessPromotionPrev" type="button">上一页</button><span>当前页</span><button id="businessPromotionNext" type="button">下一页</button></div></div></section>`;
    page.querySelector('#businessPromotionCurrency').value = filters.currency; page.querySelector('#businessPromotionRateType').value = filters.rateType;
    page.querySelector('#businessPromotionSearch').onclick = () => { filters.shopId = page.querySelector('#businessPromotionShop').value; filters.start = page.querySelector('#businessPromotionStart').value; filters.end = page.querySelector('#businessPromotionEnd').value; filters.currency = page.querySelector('#businessPromotionCurrency').value; filters.rateType = page.querySelector('#businessPromotionRateType').value; pageNo = 1; load(); };
    page.querySelector('#businessPromotionReset').onclick = () => { Object.assign(filters, { shopId: '', start: '', end: '' }); pageNo = 1; page.querySelector('#businessPromotionShop').value = ''; page.querySelector('#businessPromotionStart').value = ''; page.querySelector('#businessPromotionEnd').value = ''; draw(); };
    page.querySelector('#businessPromotionExport').onclick = exportCsv; page.querySelector('#businessPromotionPageSize').onchange = event => { pageSize = Number(event.target.value); pageNo = 1; draw(); }; page.querySelector('#businessPromotionPrev').onclick = () => { pageNo -= 1; draw(); }; page.querySelector('#businessPromotionNext').onclick = () => { pageNo += 1; draw(); };
    load();
  }
  document.addEventListener('sales:navigate', event => {
    if (event.detail?.route !== '#promotions') return;
    if (!hasLoaded || loadedAccessToken !== (session().accessToken || '')) render();
  });
  document.addEventListener('business:promotion-cache-reset', () => {
    rows = []; shops = []; pageNo = 1; hasLoaded = false; loadedAccessToken = '';
    Object.assign(filters, { shopId: '', start: '', end: '', currency: 'USD', rateType: 'settlement' });
  });
})();
