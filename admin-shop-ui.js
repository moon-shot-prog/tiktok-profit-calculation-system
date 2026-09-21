(() => {
  const root = document.querySelector('#adminManagement');
  const dialog = document.createElement('dialog');
  const countryNames = { US: '美国', PH: '菲律宾', ID: '印尼', VN: '越南', TH: '泰国', MY: '马来西亚' };
  const defaultCurrencies = { US: 'USD', PH: 'PHP', ID: 'IDR', VN: 'VND', TH: 'THB', MY: 'MYR' };
  const countryOptions = ['US', 'PH', 'ID', 'VN', 'TH', 'MY'];
  let shops = [];
  let warehouses = [];
  let links = [];
  let page = 1;

  dialog.className = 'shop-admin-dialog';
  document.body.append(dialog);

  const session = () => { try { return JSON.parse(localStorage.getItem('tiktokShopAuthSession') || sessionStorage.getItem('tiktokShopAuthSession') || '{}'); } catch { return {}; } };
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const countryName = code => countryNames[code] || code || '—';
  const shortDate = value => value ? new Date(value).toLocaleDateString('zh-CN') : '—';
  const request = async (url, options = {}) => {
    const response = await fetch(url, { ...options, headers: { Authorization: `Bearer ${session().accessToken}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || '操作失败，请稍后重试');
    return data;
  };
  const warehouseIdsFor = shopId => links.filter(link => link.shop_id === shopId).map(link => link.warehouse_id);
  const warehouseNamesFor = shopId => warehouseIdsFor(shopId).map(id => warehouses.find(item => item.id === id)?.name).filter(Boolean);
  const activeWarehouses = () => warehouses.filter(item => item.is_active);

  function top() {
    document.querySelector('.admin-topbar .eyebrow').textContent = 'BASIC DATA';
    document.querySelector('#adminSuccess').textContent = '店铺管理';
    let description = document.querySelector('#adminTopDescription');
    if (!description) { description = document.createElement('p'); description.id = 'adminTopDescription'; document.querySelector('#adminSuccess').after(description); }
    description.textContent = '真实数据模块：维护店铺基础资料、关联仓库与启停状态。订单同步信息将在每日导入功能上线后自动生成。';
  }

  async function load() {
    const data = await request('/api/admin/shops');
    shops = data.shops || [];
    warehouses = data.warehouses || [];
    links = data.shopWarehouses || [];
  }

  function filteredShops() {
    const country = document.querySelector('#shopAdminCountry')?.value || '';
    const state = document.querySelector('#shopAdminState')?.value || '';
    const name = document.querySelector('#shopAdminName')?.value.trim().toLowerCase() || '';
    return shops.filter(shop => (!country || shop.country_code === country) && (!state || String(shop.is_active) === state) && (!name || `${shop.shop_name} ${shop.shop_code}`.toLowerCase().includes(name)));
  }

  function draw() {
    const list = filteredShops();
    const size = Number(document.querySelector('#shopAdminSize')?.value || 20);
    const totalPages = Math.max(1, Math.ceil(list.length / size));
    page = Math.min(page, totalPages);
    const pageRows = list.slice((page - 1) * size, page * size);
    document.querySelector('#shopAdminRows').innerHTML = pageRows.map(shop => {
      const names = warehouseNamesFor(shop.id);
      return `<tr><td><strong>${escapeHtml(shop.shop_name)}</strong></td><td>${escapeHtml(shop.shop_code)}</td><td>${escapeHtml(countryName(shop.country_code))}</td><td>${escapeHtml(shop.currency_code)}</td><td>${names.length ? names.map(name => `<i class="shop-admin-tag">${escapeHtml(name)}</i>`).join('') : '<span class="shop-empty-link">暂未关联</span>'}</td><td><span class="shop-sync 未同步">等待导入</span></td><td>—</td><td><span class="shop-admin-state ${shop.is_active ? '启用' : '已停用'}">${shop.is_active ? '启用' : '已停用'}</span></td><td><button class="shop-admin-action" data-detail="${shop.id}">详情</button><button class="shop-admin-action" data-edit="${shop.id}">修改</button><button class="shop-admin-action ${shop.is_active ? 'danger' : ''}" data-toggle="${shop.id}">${shop.is_active ? '停用' : '启用'}</button></td></tr>`;
    }).join('') || '<tr><td colspan="9" class="admin-empty">暂无匹配的店铺</td></tr>';
    document.querySelector('#shopAdminTotal').textContent = `共 ${list.length} 条，第 ${page} / ${totalPages} 页`;
    document.querySelector('#shopAdminPrev').disabled = page === 1;
    document.querySelector('#shopAdminNext').disabled = page === totalPages;
  }

  function warehouseOptions(selectedIds = []) {
    return activeWarehouses().map(warehouse => `<option value="${warehouse.id}" ${selectedIds.includes(warehouse.id) ? 'selected' : ''}>${escapeHtml(warehouse.name)}${warehouse.country_code ? `（${countryName(warehouse.country_code)}）` : ''}</option>`).join('');
  }

  function shopForm(shop = null) {
    const creating = !shop;
    const selectedIds = shop ? warehouseIdsFor(shop.id) : [];
    const currentCountry = shop?.country_code || 'US';
    dialog.innerHTML = `<button class="dialog-close" type="button">×</button><h2>${creating ? '新增店铺' : '修改店铺'}</h2><p>店铺编码为唯一识别项。关联仓库为选填项；停用后业务员将不再看到该店铺。</p><form id="shopSaveForm"><label>店铺名称<input id="shopName" maxlength="120" required value="${escapeHtml(shop?.shop_name || '')}" /></label><label>店铺简称 / 编码<input id="shopCode" pattern="[A-Za-z0-9_-]{2,50}" maxlength="50" required value="${escapeHtml(shop?.shop_code || '')}" /></label><label>国家站点<select id="shopCountry">${countryOptions.map(code => `<option value="${code}" ${code === currentCountry ? 'selected' : ''}>${countryName(code)}</option>`).join('')}</select></label><label>货币类型<select id="shopCurrency">${['USD', 'PHP', 'IDR', 'VND', 'THB', 'MYR'].map(code => `<option value="${code}" ${code === (shop?.currency_code || defaultCurrencies[currentCountry]) ? 'selected' : ''}>${code}</option>`).join('')}</select></label><label class="shop-form-wide">关联仓库（可多选，选填）<select id="shopWarehouseIds" multiple size="5">${warehouseOptions(selectedIds)}</select><small>如需关联，只可选择启用中的仓库。</small></label><label>店铺状态<select id="shopActive"><option value="true" ${shop?.is_active !== false ? 'selected' : ''}>启用</option><option value="false" ${shop?.is_active === false ? 'selected' : ''}>已停用</option></select></label><p class="shop-save-message" id="shopSaveMessage"></p><button type="submit">${creating ? '保存并新增店铺' : '保存修改'}</button></form>`;
    dialog.showModal();
    const shopCodeInput = dialog.querySelector('#shopCode');
    shopCodeInput.placeholder = '例如：越南FEILINKA本土店';
    shopCodeInput.title = '支持中文、英文、数字、下划线和短横线；不支持空格';
    dialog.querySelector('.dialog-close').onclick = () => dialog.close();
    dialog.querySelector('#shopCountry').onchange = event => { dialog.querySelector('#shopCurrency').value = defaultCurrencies[event.target.value] || 'USD'; };
    dialog.querySelector('form').onsubmit = async event => {
      event.preventDefault();
      const submit = dialog.querySelector('[type="submit"]');
      const message = dialog.querySelector('#shopSaveMessage');
      const payload = { shopName: dialog.querySelector('#shopName').value.trim(), shopCode: dialog.querySelector('#shopCode').value.trim(), countryCode: dialog.querySelector('#shopCountry').value, currencyCode: dialog.querySelector('#shopCurrency').value, warehouseIds: [...dialog.querySelector('#shopWarehouseIds').selectedOptions].map(option => option.value), isActive: dialog.querySelector('#shopActive').value === 'true' };
      submit.disabled = true; message.textContent = '正在保存…';
      try {
        if (creating) await request('/api/admin/shops', { method: 'POST', body: JSON.stringify(payload) });
        else await request('/api/admin/shops/configuration', { method: 'PUT', body: JSON.stringify({ ...payload, shopId: shop.id }) });
        await load(); dialog.close(); draw();
      } catch (error) { message.textContent = error.message; }
      finally { submit.disabled = false; }
    };
  }

  function detail(shop) {
    const names = warehouseNamesFor(shop.id);
    dialog.innerHTML = `<button class="dialog-close" type="button">×</button><h2>${escapeHtml(shop.shop_name)}</h2><div class="shop-detail-grid"><div>店铺内部 ID<strong>${escapeHtml(shop.id)}</strong></div><div>店铺简称 / 编码<strong>${escapeHtml(shop.shop_code)}</strong></div><div>国家站点<strong>${escapeHtml(countryName(shop.country_code))}</strong></div><div>货币类型<strong>${escapeHtml(shop.currency_code)}</strong></div><div>关联仓库<strong>${escapeHtml(names.join('、') || '—')}</strong></div><div>状态<strong>${shop.is_active ? '启用' : '已停用'}</strong></div><div>创建时间<strong>${shortDate(shop.created_at)}</strong></div><div>最近资料更新时间<strong>${shortDate(shop.updated_at)}</strong></div></div><p class="shop-readonly-note">订单同步状态和最近同步时间将在每日订单／结算文件导入完成后由系统自动生成，当前不会手工填写。</p>`;
    dialog.showModal(); dialog.querySelector('.dialog-close').onclick = () => dialog.close();
  }

  function toggleShop(shop) {
    dialog.innerHTML = `<button class="dialog-close" type="button">×</button><h2>${shop.is_active ? '停用店铺' : '启用店铺'}</h2><p>${shop.is_active ? `停用后，业务员将无法继续在业务端查看或操作“${escapeHtml(shop.shop_name)}”。历史数据仍保留在管理后台。` : `启用后，已获授权的业务员将重新看到“${escapeHtml(shop.shop_name)}”。`}</p><div class="shop-dialog-actions"><button type="button" class="secondary">取消</button><button type="button" class="${shop.is_active ? 'danger-button' : ''}" id="confirmShopToggle">确认${shop.is_active ? '停用' : '启用'}</button></div>`;
    dialog.showModal();
    dialog.querySelector('.dialog-close').onclick = () => dialog.close();
    dialog.querySelector('.secondary').onclick = () => dialog.close();
    dialog.querySelector('#confirmShopToggle').onclick = async () => {
      const button = dialog.querySelector('#confirmShopToggle'); button.disabled = true;
      try {
        await request('/api/admin/shops/configuration', { method: 'PUT', body: JSON.stringify({ shopId: shop.id, shopCode: shop.shop_code, shopName: shop.shop_name, countryCode: shop.country_code, currencyCode: shop.currency_code, warehouseIds: warehouseIdsFor(shop.id), isActive: !shop.is_active }) });
        await load(); dialog.close(); draw();
      } catch (error) { window.alert(error.message); button.disabled = false; }
    };
  }

  function render() {
    top();
    root.innerHTML = `<section class="shop-admin-filters"><label>国家站点<select id="shopAdminCountry"><option value="">全部站点</option>${countryOptions.map(code => `<option value="${code}">${countryName(code)}</option>`).join('')}</select></label><label>店铺状态<select id="shopAdminState"><option value="">全部状态</option><option value="true">启用</option><option value="false">已停用</option></select></label><label>店铺名称<input id="shopAdminName" placeholder="支持名称或编码搜索" /></label><div><button type="button" id="shopAdminSearch">查询</button><button type="button" id="shopAdminReset">重置</button></div></section><p class="shop-admin-live-note">此模块已接入真实数据库。订单同步状态与最近同步日期将在后续每日导入模块上线后自动更新。</p><section class="shop-admin-toolbar"><button type="button" id="shopAdminCreate">新增店铺</button></section><section class="shop-admin-table"><table><thead><tr><th>店铺名称</th><th>店铺简称</th><th>国家站点</th><th>货币类型</th><th>关联仓库</th><th>订单同步状态</th><th>最近同步日期</th><th>状态</th><th>操作</th></tr></thead><tbody id="shopAdminRows"><tr><td colspan="9" class="admin-empty">正在读取店铺数据…</td></tr></tbody></table></section><div class="admin-pagination"><span id="shopAdminTotal"></span><label>每页 <select id="shopAdminSize"><option value="20">20 条/页</option><option value="50">50 条/页</option><option value="100">100 条/页</option></select></label><div><button type="button" id="shopAdminPrev">上一页</button><button class="active" type="button" disabled>当前页</button><button type="button" id="shopAdminNext">下一页</button></div></div>`;
    document.querySelector('#shopAdminSearch').onclick = () => { page = 1; draw(); };
    document.querySelector('#shopAdminReset').onclick = () => { document.querySelector('#shopAdminCountry').value = ''; document.querySelector('#shopAdminState').value = ''; document.querySelector('#shopAdminName').value = ''; page = 1; draw(); };
    document.querySelector('#shopAdminCreate').onclick = () => shopForm();
    document.querySelector('#shopAdminSize').onchange = () => { page = 1; draw(); };
    document.querySelector('#shopAdminPrev').onclick = () => { page -= 1; draw(); };
    document.querySelector('#shopAdminNext').onclick = () => { page += 1; draw(); };
    root.onclick = event => {
      const button = event.target.closest('[data-detail], [data-edit], [data-toggle]');
      if (!button) return;
      const id = button.dataset.detail || button.dataset.edit || button.dataset.toggle;
      const shop = shops.find(item => item.id === id); if (!shop) return;
      if (button.dataset.detail) detail(shop);
      if (button.dataset.edit) shopForm(shop);
      if (button.dataset.toggle) toggleShop(shop);
    };
    load().then(draw).catch(error => {
      document.querySelector('#shopAdminRows').innerHTML = `<tr><td colspan="9" class="admin-empty">${escapeHtml(error.message)}</td></tr>`;
      document.querySelector('#shopAdminTotal').textContent = '无法读取数据';
    });
  }

  document.addEventListener('admin:navigate', event => { if (event.detail.page === 'shops') render(); });
})();
