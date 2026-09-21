(() => {
  const page = document.querySelector('#ordersPage');
  if (!page) return;
  const session = () => { try { return JSON.parse(localStorage.getItem('tiktokShopAuthSession') || sessionStorage.getItem('tiktokShopAuthSession') || '{}'); } catch { return {}; } };
  const escapeHtml = value => String(value ?? '—').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
  const api = async (path, retries = 0) => { try { const response = await fetch(path, { headers: { Authorization: `Bearer ${session().accessToken || ''}` } }); const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.message || '读取订单明细失败'); return data; } catch (error) { if (retries > 0) { await new Promise(resolve => setTimeout(resolve, 350)); return api(path, retries - 1); } throw error; } };
  const localDate = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const defaultDateFilters = () => { const end = new Date(); end.setHours(0, 0, 0, 0); end.setDate(end.getDate() - 1); const start = new Date(end); start.setDate(start.getDate() - 6); return { start: localDate(start), end: localDate(end) }; };
  let rows = [], meta = { page: 1, pageSize: 20, totalPages: 1, orderItemCount: 0 }, options = { orderStatuses: [], logisticsStatuses: [] }, shops = [], warehouses = [], filters = defaultDateFilters(), selectedPage = 1, orderPageSize = 20, filterSourcesLoaded = false;
  const CACHE_TTL = 3 * 60 * 1000;
  let cachedKey = '', cachedAt = 0;
  const detailsVisible = () => !page.classList.contains('is-hidden') && !page.querySelector('.order-table-card')?.classList.contains('is-hidden');
  function query() { return new URLSearchParams({ page: String(selectedPage), pageSize: String(orderPageSize), ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value)) }); }
  const cacheKey = () => JSON.stringify({ account: session().accessToken || '', page: selectedPage, pageSize: orderPageSize, filters });
  function filterOptions(values, placeholder) { return `<option value="">${placeholder}</option>${values.map(value => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('')}`; }
  function renderShell() {
    const filterHost = page.querySelector('#orderFilters'); const tableCard = page.querySelector('.order-table-card');
    if (!filterHost || !tableCard) return;
    page.classList.add('business-order-details-active'); tableCard.classList.add('business-order-table');
    filterHost.innerHTML = `<label>店铺<select id="businessOrderShop">${filterOptions(shops.map(shop => shop.shop_name), '全部店铺')}</select></label><label>仓库<select id="businessOrderWarehouse">${filterOptions(warehouses, '全部仓库')}</select></label><label>订单状态<select id="businessOrderStatus">${filterOptions(options.orderStatuses || [], '全部')}</select></label><label>下单日期<span><input id="businessOrderStart" type="date"> - <input id="businessOrderEnd" type="date"></span></label><label>订单 ID<input id="businessOrderId"></label><label>商品编码<input id="businessOrderCode"></label><label>物流状态<select id="businessOrderLogistics">${filterOptions(options.logisticsStatuses || [], '全部')}</select></label><div class="order-filter-actions"><button id="businessOrderSearch" type="button">查询</button><button id="businessOrderReset" type="button">重置</button></div>`;
    let toolbar = page.querySelector('#businessOrderToolbar'); if (!toolbar) { toolbar = document.createElement('section'); toolbar.id = 'businessOrderToolbar'; toolbar.className = 'business-order-toolbar'; tableCard.before(toolbar); }
    toolbar.innerHTML = '<button id="businessOrderExport" type="button">导出数据</button>';
    tableCard.innerHTML = `<table><thead><tr><th><span>店铺</span><span>国家站点</span></th><th>订单 ID</th><th><span>商品编码</span><span>SKU ID</span></th><th>商品名称</th><th>下单数量</th><th>支付金额</th><th><span>订单状态</span><span>取消类型</span></th><th><span>快递单号</span><span>物流承运商</span></th><th>配送方式</th><th>下单时间</th><th>物流状态</th><th>利润数据</th><th>操作</th></tr></thead><tbody id="businessOrderRows"></tbody></table><div class="product-pagination"><span id="businessOrderTotal"></span><label>每页<select id="businessOrderPageSize"><option value="20">20 条/页</option><option value="50">50 条/页</option><option value="100">100 条/页</option></select></label><div><button id="businessOrderPrev" type="button">上一页</button><span id="businessOrderPage"></span><button id="businessOrderNext" type="button">下一页</button></div></div>`;
    const fields = { businessOrderShop: 'shop', businessOrderWarehouse: 'warehouse', businessOrderStatus: 'status', businessOrderStart: 'start', businessOrderEnd: 'end', businessOrderId: 'orderId', businessOrderCode: 'code', businessOrderLogistics: 'logistics' };
    Object.entries(fields).forEach(([id, key]) => { const field = document.querySelector(`#${id}`); field.value = filters[key] || ''; });
    document.querySelector('#businessOrderPageSize').value = String(orderPageSize);
    document.querySelector('#businessOrderSearch').onclick = () => { Object.entries(fields).forEach(([id, key]) => { filters[key] = document.querySelector(`#${id}`).value; }); selectedPage = 1; load(true); };
    document.querySelector('#businessOrderReset').onclick = () => { filters = defaultDateFilters(); selectedPage = 1; load(true); };
    document.querySelector('#businessOrderPageSize').onchange = event => { orderPageSize = Number(event.target.value); selectedPage = 1; load(); };
    document.querySelector('#businessOrderPrev').onclick = () => { selectedPage--; load(); };
    document.querySelector('#businessOrderNext').onclick = () => { selectedPage++; load(); };
    document.querySelector('#businessOrderRows').onclick = event => { const row = rows.find(item => item.id === event.target.dataset.orderDetail); if (row) openDetail(row); };
    document.querySelector('#businessOrderExport').onclick = exportData;
  }
  async function exportData() {
    try {
      const exportQuery = new URLSearchParams({ page: '1', pageSize: '100', export: 'csv', ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value)) });
      const data = await api(`/api/business/order-details?${exportQuery}`); const exportRows = data.orders || [];
      if (!exportRows.length) return window.alert('当前筛选条件下没有可导出的订单明细');
      const quote = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
      const headers = ['店铺','国家站点','订单 ID','商品编码','SKU ID','商品名称','下单数量','支付金额','订单状态','取消类型','快递单号','物流承运商','配送方式','下单时间','物流状态','利润数据'];
      const lines = exportRows.map(item => [item.shop,item.site,item.number,item.code,item.sku,item.name,item.qty,item.paid,item.status,item.refund,item.tracking,item.carrier,item.deliveryOption,item.ordered,item.orderSubstatus,item.profitData].map(quote).join(','));
      const blob = new Blob([`\uFEFF${[headers.map(quote).join(','), ...lines].join('\r\n')}`], { type: 'text/csv;charset=utf-8' }); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `订单明细_${new Date().toISOString().slice(0, 10)}.csv`; link.click(); URL.revokeObjectURL(link.href);
      if ((data.orderMeta?.orderItemCount || 0) > exportRows.length) window.alert(`已导出前 ${exportRows.length} 条，请缩小筛选条件后继续导出。`);
    } catch (error) { window.alert(error.message || '导出订单明细失败'); }
  }
  function draw() {
    const target = document.querySelector('#businessOrderRows'); if (!target) return;
    target.innerHTML = rows.map(item => `<tr><td>${escapeHtml(item.shop)}<small>${escapeHtml(item.site)}</small></td><td><strong>${escapeHtml(item.number)}</strong></td><td>${escapeHtml(item.code)}<small>${escapeHtml(item.sku)}</small></td><td>${escapeHtml(item.name)}</td><td>${item.qty || 0}</td><td>${escapeHtml(item.paid)}</td><td>${escapeHtml(item.status)}<small>${escapeHtml(item.refund)}</small></td><td>${escapeHtml(item.tracking)}<small>${escapeHtml(item.carrier)}</small></td><td>${escapeHtml(item.deliveryOption)}</td><td>${escapeHtml(item.ordered)}</td><td>${escapeHtml(item.orderSubstatus)}</td><td>${escapeHtml(item.profitData)}</td><td><button class="order-detail-button" data-order-detail="${escapeHtml(item.id)}">详情</button></td></tr>`).join('') || '<tr><td colspan="13">暂无符合条件的订单明细</td></tr>';
    document.querySelector('#businessOrderTotal').textContent = `符合筛选条件：SKU 明细 ${meta.orderItemCount || 0} 条`;
    document.querySelector('#businessOrderPage').textContent = `${meta.page || selectedPage} / ${meta.totalPages || 1}`;
    document.querySelector('#businessOrderPrev').disabled = (meta.page || selectedPage) <= 1;
    document.querySelector('#businessOrderNext').disabled = (meta.page || selectedPage) >= (meta.totalPages || 1);
  }
  function openDetail(item) {
    const drawer = document.createElement('aside'); drawer.className = 'order-drawer';
    const raw = Object.entries(item.rawData || {}).map(([key, value]) => `<tr><td>${escapeHtml(key)}</td><td>${escapeHtml(value)}</td></tr>`).join('') || '<tr><td colspan="2">无额外原始字段</td></tr>';
    drawer.innerHTML = `<button class="dialog-close" type="button">×</button><h2>订单详情</h2><p class="drawer-summary">订单 ID：${escapeHtml(item.number)}</p><div class="drawer-grid"><div>店铺 / 国家站点<strong>${escapeHtml(item.shop)} / ${escapeHtml(item.site)}</strong></div><div>订单状态 / 取消类型<strong>${escapeHtml(item.status)} / ${escapeHtml(item.refund)}</strong></div><div>仓库名称<strong>${escapeHtml(item.warehouse)}</strong></div><div>物流状态<strong>${escapeHtml(item.orderSubstatus)}</strong></div><div>下单时间<strong>${escapeHtml(item.ordered)}</strong></div><div>发货时间<strong>${escapeHtml(item.shipped)}</strong></div><div>快递单号 / 承运商<strong>${escapeHtml(item.tracking)} / ${escapeHtml(item.carrier)}</strong></div><div>配送方式<strong>${escapeHtml(item.deliveryOption)}</strong></div></div><h3>商品明细</h3><table class="drawer-table"><thead><tr><th>商品编码</th><th>SKU ID</th><th>商品名称</th><th>数量</th><th>分摊实付金额</th></tr></thead><tbody><tr><td>${escapeHtml(item.code)}</td><td>${escapeHtml(item.sku)}</td><td>${escapeHtml(item.name)}</td><td>${item.qty || 0}</td><td>${escapeHtml(item.paid)}</td></tr></tbody></table><h3>完整导入字段</h3><table class="drawer-table"><tbody>${raw}</tbody></table>`;
    document.body.append(drawer); drawer.querySelector('.dialog-close').onclick = () => drawer.remove();
  }
  async function load(force = false) {
    if (!detailsVisible()) return;
    renderShell();
    if (!session().accessToken) {
      const body = page.querySelector('#businessOrderRows');
      if (body) body.innerHTML = '<tr><td colspan="13">正在恢复登录会话，请稍候…</td></tr>';
      return;
    }
    const key = cacheKey();
    if (!force && cachedKey === key && Date.now() - cachedAt < CACHE_TTL) {
      draw();
      return;
    }
    try {
      // 主订单接口优先展示；店铺和仓库仅用于补充筛选器，不能因其短暂失败而清空订单表。
      const data = await api(`/api/business/order-details?${query()}`, 1);
      rows = data.orders || []; meta = data.orderMeta || meta; options = data.filterOptions || options; orderPageSize = Number(meta.pageSize || orderPageSize);
      cachedKey = key; cachedAt = Date.now();
      // 订单行先展示，店铺与仓库仅用于筛选器补充，不再阻塞主表。
      renderShell(); draw();
      if (!filterSourcesLoaded) {
        Promise.allSettled([api('/api/business/shops', 1), api('/api/business/warehouse-costs', 1)]).then(([shopResult, costResult]) => {
          if (shopResult.status === 'fulfilled') shops = shopResult.value.shops || [];
          if (costResult.status === 'fulfilled') warehouses = [...new Set((costResult.value.costs || []).map(item => item.warehouse?.name).filter(Boolean))];
          filterSourcesLoaded = shopResult.status === 'fulfilled' && costResult.status === 'fulfilled';
          if (detailsVisible()) { renderShell(); draw(); }
        });
      }
    } catch (error) { rows = []; meta = { page: 1, pageSize: 20, totalPages: 1, orderItemCount: 0 }; const body = page.querySelector('#businessOrderRows'); if (body) body.innerHTML = `<tr><td colspan="13">${escapeHtml(error.message)}</td></tr>`; const total = page.querySelector('#businessOrderTotal'); if (total) total.textContent = ''; }
  }
  function setDetailView(active) { page.classList.toggle('business-order-details-active', active); page.querySelector('#businessOrderToolbar')?.classList.toggle('is-hidden', !active); }
  document.addEventListener('app:authenticated', load);
  document.querySelector('#orderDetailNav')?.addEventListener('click', () => setDetailView(true));
  document.querySelector('#settlementNav')?.addEventListener('click', () => setDetailView(false));
  document.addEventListener('sales:navigate', event => {
    if (event.detail?.route !== '#orders') return;
    const showDetails = event.detail?.view !== 'settlement';
    setDetailView(showDetails);
    if (showDetails) load();
  });
  // 页面在隐藏状态下先替换旧示例表，首次打开只会看到真实数据的加载状态。
  renderShell();
  const initialBody = page.querySelector('#businessOrderRows');
  if (initialBody) initialBody.innerHTML = '<tr><td colspan="13">打开页面后读取真实订单数据…</td></tr>';
  load();
})();
