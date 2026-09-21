(() => {
  const root = document.querySelector('#adminManagement');
  const dialog = document.createElement('dialog');
  const countries = { US: '美国', PH: '菲律宾', ID: '印尼', VN: '越南', TH: '泰国', MY: '马来西亚' };
  const countryOptions = ['US', 'PH', 'ID', 'VN', 'TH', 'MY'];
  const countrySites = [
    { name: '菲律宾', code: 'PH', currency: 'PHP' }, { name: '印尼', code: 'ID', currency: 'IDR' },
    { name: '越南', code: 'VN', currency: 'VND' }, { name: '泰国', code: 'TH', currency: 'THB' },
    { name: '马来西亚', code: 'MY', currency: 'MYR' }
  ];
  let costVersions = [];
  let warehouseCountrySites = [];
  let warehouses = [];
  let links = [];
  let shops = [];
  let page = 1;
  const recentlySavedCostVersions = new Map();

  dialog.className = 'warehouse-modal';
  document.body.append(dialog);
  window.AdminVisualWarehouses = () => (window.AdminVisualData?.warehouses || []).map(item => ({ id: item.id, name: item.name, status: item.status }));
  const session = () => { try { return JSON.parse(localStorage.getItem('tiktokShopAuthSession') || sessionStorage.getItem('tiktokShopAuthSession') || '{}'); } catch { return {}; } };
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const countryName = code => countries[code] || code || '跨境';
  const shortDate = value => value ? new Date(value).toLocaleDateString('zh-CN') : '—';
  const request = async (url, options = {}) => {
    const response = await fetch(url, { ...options, headers: { Authorization: `Bearer ${session().accessToken}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || '操作失败，请稍后重试');
    return data;
  };
  const shopsFor = warehouseId => links.filter(link => link.warehouse_id === warehouseId).map(link => shops.find(shop => shop.id === link.shop_id)).filter(Boolean);
  const countrySitesFor = warehouseId => warehouseCountrySites.filter(link => link.warehouse_id === warehouseId).map(link => countrySites.find(site => site.code === link.country_code)).filter(Boolean);

  function top() {
    document.querySelector('.admin-topbar .eyebrow').textContent = 'BASIC DATA';
    document.querySelector('#adminSuccess').textContent = '仓库管理';
    let description = document.querySelector('#adminTopDescription');
    if (!description) { description = document.createElement('p'); description.id = 'adminTopDescription'; document.querySelector('#adminSuccess').after(description); }
    description.textContent = '维护仓库资料及人民币代发费用版本；费用按订单日期匹配生效版本。';
  }
  async function load() {
    const data = await request('/api/admin/warehouses');
    warehouses = data.warehouses || [];
    links = data.links || [];
    shops = data.shops || [];
    costVersions = data.costVersions || [];
    warehouseCountrySites = data.warehouseCountrySites || [];
    countrySites.splice(0, countrySites.length, ...(data.countrySites || []).map(site => ({ name: site.name, code: site.code, currency: site.default_currency })));
    countrySites.forEach(site => { countries[site.code] = site.name; });
  }
  const currentCost = warehouseId => costVersions.find(version => version.warehouse_id === warehouseId);
  const costHistoryFor = warehouseId => costVersions.filter(version => version.warehouse_id === warehouseId).sort((left, right) => String(right.effective_date || '').localeCompare(String(left.effective_date || '')) || String(right.created_at || '').localeCompare(String(left.created_at || '')));
  const costVersionKey = version => `${version.effective_date || ''}::${Number(version.amount || 0).toFixed(4)}::${version.billing_unit || ''}`;
  function filtered() {
    const warehouseId = document.querySelector('#warehouseFilter')?.value || '';
    const state = document.querySelector('#warehouseStateFilter')?.value || '';
    const name = document.querySelector('#warehouseNameFilter')?.value.trim().toLowerCase() || '';
    return warehouses.filter(item => (!warehouseId || item.id === warehouseId) && (!state || String(item.is_active) === state) && (!name || item.name.toLowerCase().includes(name)));
  }
  function draw() {
    const list = filtered();
    const size = Number(document.querySelector('#warehouseSize')?.value || 20);
    const totalPages = Math.max(1, Math.ceil(list.length / size));
    page = Math.min(page, totalPages);
    const pageRows = list.slice((page - 1) * size, page * size);
    document.querySelector('#warehouseRows').innerHTML = pageRows.map(item => {
      const connectedShops = shopsFor(item.id);
      const cost = currentCost(item.id);
      const carriers = String(item.shipping_provider_name || '').split(/[、,，]/).map(value => value.trim()).filter(Boolean);
      return `<tr><td><strong>${escapeHtml(item.name)}</strong></td><td>${escapeHtml(item.original_warehouse_name || '—')}</td><td>${carriers.length ? carriers.map(carrier => `<i class="warehouse-tag">${escapeHtml(carrier)}</i>`).join('') : '<span class="warehouse-empty">—</span>'}</td><td>${cost ? `CNY ${Number(cost.amount).toFixed(2)} / ${cost.billing_unit === 'per_package' ? '每包裹' : '每单'}` : '<span class="warehouse-empty">成本缺失</span>'}</td><td>${connectedShops.length ? connectedShops.map(shop => `<i class="warehouse-tag">${escapeHtml(shop.shop_name)}</i>`).join('') : '<span class="warehouse-empty">暂未关联店铺</span>'}</td><td>${connectedShops.length}</td><td>${shortDate(item.updated_at)}</td><td><span class="warehouse-state ${item.is_active ? '启用' : '已停用'}">${item.is_active ? '启用' : '已停用'}</span></td><td><button class="warehouse-action" data-detail="${item.id}">详情</button><button class="warehouse-action" data-edit="${item.id}">修改</button><button class="warehouse-action ${item.is_active ? 'danger' : ''}" data-toggle="${item.id}">${item.is_active ? '停用' : '启用'}</button></td></tr>`;
    }).join('') || '<tr><td colspan="7" class="admin-empty">暂无匹配的仓库</td></tr>';
    document.querySelector('#warehouseTotal').textContent = `共 ${list.length} 条，第 ${page} / ${totalPages} 页`;
    document.querySelector('#warehousePrev').disabled = page === 1;
    document.querySelector('#warehouseNext').disabled = page === totalPages;
  }
  function warehouseForm(item = null) {
    const creating = !item;
    const existingCost = currentCost(item?.id);
    const selectedCodes = new Set(warehouseCountrySites.filter(link => link.warehouse_id === item?.id).map(link => link.country_code));
    if (!selectedCodes.size && item?.country_code) selectedCodes.add(item.country_code);
    const currentSite = countrySites.find(site => selectedCodes.has(site.code));
    dialog.innerHTML = `<button class="dialog-close" type="button">×</button><h2>${creating ? '新增仓库' : '修改仓库'}</h2><p>保存会写入真实仓库资料，并新增一条不可覆盖的人民币代发费用版本。</p><form id="warehouseSaveForm"><label>仓库名称<input id="warehouseName" maxlength="80" required value="${escapeHtml(item?.name || '')}" /></label><label>代发费用<input id="warehouseCost" type="number" min="0" step="0.01" inputmode="decimal" required placeholder="请输入数字金额" value="${existingCost?.amount ?? ''}" /></label><label>币种<input id="costCurrency" value="CNY（人民币）" readonly aria-readonly="true" /></label><label>计费单位<select id="costUnit"><option value="每单" ${existingCost?.billing_unit !== 'per_package' ? 'selected' : ''}>每单</option><option value="每包裹" ${existingCost?.billing_unit === 'per_package' ? 'selected' : ''}>每包裹</option></select></label><label>生效日期<input id="costEffectiveDate" type="date" required value="${existingCost?.effective_date || new Date().toISOString().slice(0, 10)}" /></label><label>备注（选填）<input id="costNote" maxlength="200" placeholder="例如：9 月仓库报价" value="${escapeHtml(existingCost?.note || '')}" /></label><label>仓库状态<select id="warehouseActive"><option value="true" ${item?.is_active !== false ? 'selected' : ''}>启用</option><option value="false" ${item?.is_active === false ? 'selected' : ''}>已停用</option></select></label><p class="warehouse-save-message" id="warehouseSaveMessage"></p><button type="submit">${creating ? '保存并新增仓库' : '保存修改'}</button></form>`;
    dialog.showModal();
    dialog.querySelector('.dialog-close').onclick = () => dialog.close();
    dialog.querySelector('form').onsubmit = async event => {
      event.preventDefault();
      const submit = dialog.querySelector('[type="submit"]');
      const message = dialog.querySelector('#warehouseSaveMessage');
      const payload = { name: dialog.querySelector('#warehouseName').value.trim(), originalWarehouseName: dialog.querySelector('#warehouseOriginalSummary')?.textContent.trim().replace('请选择原仓库名称', '') || '', deliveryOption: dialog.querySelector('#warehouseDeliveryOption')?.value.trim() || '', shippingProviderName: dialog.querySelector('#warehouseShippingProvider')?.value.trim() || '', countryCode: null, countryCodes: [], isActive: dialog.querySelector('#warehouseActive').value === 'true', amount: Number(dialog.querySelector('#warehouseCost').value), billingUnit: dialog.querySelector('#costUnit').value, effectiveDate: dialog.querySelector('#costEffectiveDate').value, note: dialog.querySelector('#costNote').value.trim() };
      submit.disabled = true; message.textContent = '正在保存…';
      try {
        if (creating) await request('/api/admin/warehouses', { method: 'POST', body: JSON.stringify(payload) });
        else await request('/api/admin/warehouses/configuration', { method: 'PUT', body: JSON.stringify({ ...payload, warehouseId: item.id }) });
        if (!creating) recentlySavedCostVersions.set(item.id, `${payload.effectiveDate}::${Number(payload.amount).toFixed(4)}::${payload.billingUnit === '每包裹' ? 'per_package' : 'per_order'}`);
        await load(); paint(); draw();
        if (creating) dialog.close(); else detail(warehouses.find(warehouse => warehouse.id === item.id) || item);
      } catch (error) { message.textContent = error.message; }
      finally { submit.disabled = false; }
    };
    return;
    const countryInput = dialog.querySelector('#warehouseCountrySite');
    const newCountryForm = dialog.querySelector('#newCountryForm');
    const countryLabel = countryInput.closest('label');
    const countryBox = document.createElement('div');
    countryBox.className = 'warehouse-country-select';
    countryBox.innerHTML = `<button type="button" class="warehouse-country-trigger">${selectedCodes.size ? `已选 ${selectedCodes.size} 个国家站点` : '请选择国家站点'} <b>⌄</b></button><div class="warehouse-country-menu is-hidden">${countrySites.map(site => `<label><input type="checkbox" value="${escapeHtml(site.name)}" ${selectedCodes.has(site.code) ? 'checked' : ''} />${escapeHtml(site.name)}（${site.code}）</label>`).join('')}<button type="button" class="warehouse-country-add">+ 新增国家站点</button></div>`;
    countryInput.type = 'hidden';
    countryLabel.append(countryBox);
    const countryTrigger = countryBox.querySelector('.warehouse-country-trigger');
    const countryMenu = countryBox.querySelector('.warehouse-country-menu');
    const updateCountryTrigger = () => { const count = countryMenu.querySelectorAll('input[type="checkbox"]:checked').length; countryTrigger.firstChild.textContent = count ? `已选 ${count} 个国家站点 ` : '请选择国家站点 '; };
    countryTrigger.onclick = event => { event.stopPropagation(); countryMenu.classList.toggle('is-hidden'); };
    countryMenu.onchange = event => {
      const check = event.target.closest('input[type="checkbox"]');
      if (!check) return;
      countryInput.value = [...countryMenu.querySelectorAll('input[type="checkbox"]:checked')].map(input => input.value).join(',');
      updateCountryTrigger();
      countryMenu.classList.add('is-hidden');
    };
    countryBox.querySelector('.warehouse-country-add').onclick = () => { newCountryForm.classList.remove('is-hidden'); dialog.querySelector('#newCountryName').focus(); };
    document.addEventListener('click', event => { if (!countryBox.contains(event.target)) countryMenu.classList.add('is-hidden'); }, { once: false });
    // 仓库管理不再维护国家站点；保留历史关联数据，但不在新增/修改表单展示。
    countryLabel.remove();
    newCountryForm.remove();
    countryInput.onkeydown = event => {
      const siteName = countryInput.value.trim();
      if (event.key !== 'Enter' || !siteName || countrySites.some(site => site.name === siteName)) return;
      event.preventDefault();
      newCountryForm.classList.remove('is-hidden');
      dialog.querySelector('#newCountryName').value = siteName;
      dialog.querySelector('#newCountryCode').focus();
    };
    dialog.querySelector('#saveCountrySite').onclick = async () => {
      const name = dialog.querySelector('#newCountryName').value.trim();
      const code = dialog.querySelector('#newCountryCode').value.trim().toUpperCase();
      const currency = dialog.querySelector('#newCountryCurrency').value.trim().toUpperCase();
      if (!name || !/^[A-Z]{2}$/.test(code) || !/^[A-Z]{3}$/.test(currency)) { window.alert('请填写国家／站点名称、两位国家代码和三位默认货币。'); return; }
      const button = dialog.querySelector('#saveCountrySite'); button.disabled = true;
      try {
        const data = await request('/api/admin/country-sites', { method: 'POST', body: JSON.stringify({ name, code, defaultCurrency: currency }) });
        const saved = data.countrySite;
        const existing = countrySites.findIndex(site => site.code === saved.code);
        const site = { name: saved.name, code: saved.code, currency: saved.default_currency };
        if (existing >= 0) countrySites.splice(existing, 1, site); else countrySites.push(site);
        countries[site.code] = site.name;
        countryInput.value = site.name;
        countryMenu.querySelectorAll('input[type="checkbox"]').forEach(input => { if (input.value === site.name) input.checked = true; });
        if (!countryMenu.querySelector(`input[value="${CSS.escape(site.name)}"]`)) countryMenu.querySelector('.warehouse-country-add').insertAdjacentHTML('beforebegin', `<label><input type="checkbox" value="${escapeHtml(site.name)}" checked />${escapeHtml(site.name)}（${site.code}）</label>`);
        updateCountryTrigger();
        newCountryForm.classList.add('is-hidden');
      } catch (error) { window.alert(error.message); }
      finally { button.disabled = false; }
    };
    dialog.querySelector('form').onsubmit = async event => {
      event.preventDefault();
      const message = dialog.querySelector('#warehouseSaveMessage');
      const selectedSites = [];
      const site = null;
      const submit = dialog.querySelector('[type="submit"]');
      const payload = { name: dialog.querySelector('#warehouseName').value.trim(), originalWarehouseName: dialog.querySelector('#warehouseOriginalSummary')?.textContent.trim().replace('请选择原仓库名称', '') || '', deliveryOption: dialog.querySelector('#warehouseDeliveryOption')?.value.trim() || '', shippingProviderName: dialog.querySelector('#warehouseShippingProvider')?.value.trim() || '', countryCode: null, countryCodes: selectedSites.map(entry => entry.code), isActive: dialog.querySelector('#warehouseActive').value === 'true', amount: Number(dialog.querySelector('#warehouseCost').value), billingUnit: dialog.querySelector('#costUnit').value, effectiveDate: dialog.querySelector('#costEffectiveDate').value, note: dialog.querySelector('#costNote').value.trim() };
      submit.disabled = true; message.textContent = '正在保存…';
      try {
        if (creating) await request('/api/admin/warehouses', { method: 'POST', body: JSON.stringify(payload) });
        else await request('/api/admin/warehouses/configuration', { method: 'PUT', body: JSON.stringify({ ...payload, warehouseId: item.id }) });
        await load(); dialog.close(); paint(); draw();
      } catch (error) { message.textContent = error.message; }
      finally { submit.disabled = false; }
    };
  }
  function detail(item) {
    const connectedShops = shopsFor(item.id);
    const cost = currentCost(item.id);
    const recentlySaved = recentlySavedCostVersions.get(item.id);
    const history = costHistoryFor(item.id);
    const historyRows = history.length ? history.map(version => `<tr class="${recentlySaved === costVersionKey(version) ? 'is-recent' : ''}"><td>CNY ${Number(version.amount || 0).toFixed(2)}</td><td>${version.billing_unit === 'per_package' ? '每包裹' : '每单'}</td><td>${shortDate(version.effective_date)}</td><td>${escapeHtml(version.note || '—')}</td><td>${shortDate(version.created_at)}${recentlySaved === costVersionKey(version) ? '<i>本次保存</i>' : ''}</td></tr>`).join('') : '<tr><td colspan="5">暂无费用版本</td></tr>';
    dialog.innerHTML = `<button class="dialog-close" type="button">×</button><h2>${escapeHtml(item.name)}</h2><p class="warehouse-version-summary">当前最新费用版本按生效日期展示；历史订单会按下单日期匹配下方对应版本。</p><div class="warehouse-detail-grid"><div>仓库内部 ID<strong>${escapeHtml(item.id)}</strong></div><div>当前最新代发费用<strong>${cost ? `CNY ${Number(cost.amount).toFixed(2)} / ${cost.billing_unit === 'per_package' ? '每包裹' : '每单'}` : '成本缺失'}</strong></div><div>当前最新生效时间<strong>${cost ? shortDate(cost.effective_date) : '—'}</strong></div><div>状态<strong>${item.is_active ? '启用' : '已停用'}</strong></div><div>关联店铺数<strong>${connectedShops.length}</strong></div><div class="warehouse-detail-wide">关联店铺<strong>${escapeHtml(connectedShops.map(shop => shop.shop_name).join('、') || '暂未关联')}</strong></div><div>创建时间<strong>${shortDate(item.created_at)}</strong></div><div>最近资料更新时间<strong>${shortDate(item.updated_at)}</strong></div><div>原仓库名称<strong>${escapeHtml(item.original_warehouse_name || '—')}</strong></div><div>配送选项<strong>${escapeHtml(item.delivery_option || '—')}</strong></div><div>物流承运商<strong>${escapeHtml(item.shipping_provider_name || '—')}</strong></div></div><section class="warehouse-cost-history"><h3>费用版本历史</h3><table><thead><tr><th>代发费用</th><th>计费单位</th><th>生效时间</th><th>备注</th><th>创建时间</th></tr></thead><tbody>${historyRows}</tbody></table></section><p class="warehouse-readonly-note">保存修改会新增费用版本，不覆盖旧记录；历史订单按下单日期取生效日期不晚于订单日期的最新版本。</p>`;
    if (!dialog.open) dialog.showModal();
    dialog.querySelector('.dialog-close').onclick = () => dialog.close();
  }
  function toggle(item) {
    dialog.innerHTML = `<button class="dialog-close" type="button">×</button><h2>${item.is_active ? '停用仓库' : '启用仓库'}</h2><p>${item.is_active ? `停用“${escapeHtml(item.name)}”前，系统会检查它是否仍关联任何启用店铺。` : `启用后，该仓库可重新被店铺关联。`}</p><div class="warehouse-dialog-actions"><button type="button" class="secondary">取消</button><button type="button" class="${item.is_active ? 'danger-button' : ''}" id="confirmWarehouseToggle">确认${item.is_active ? '停用' : '启用'}</button></div>`;
    dialog.showModal(); dialog.querySelector('.dialog-close').onclick = () => dialog.close(); dialog.querySelector('.secondary').onclick = () => dialog.close();
    dialog.querySelector('#confirmWarehouseToggle').onclick = async () => {
      const button = dialog.querySelector('#confirmWarehouseToggle'); button.disabled = true;
      try {
        await request('/api/admin/warehouses/configuration', { method: 'PUT', body: JSON.stringify({ warehouseId: item.id, name: item.name, countryCode: item.country_code || '', isActive: !item.is_active }) });
        await load(); dialog.close(); draw();
      } catch (error) { window.alert(error.message); button.disabled = false; }
    };
  }
  function paint() {
    top();
    root.innerHTML = `<section class="warehouse-filters"><label>仓库<select id="warehouseFilter"><option value="">全部仓库</option>${warehouses.map(item => `<option value="${item.id}">${escapeHtml(item.name)}</option>`).join('')}</select></label><label>状态<select id="warehouseStateFilter"><option value="">全部状态</option><option value="true">启用</option><option value="false">已停用</option></select></label><label>仓库名称<input id="warehouseNameFilter" placeholder="支持模糊搜索" /></label><div><button type="button" id="warehouseSearch">查询</button><button type="button" id="warehouseReset">重置</button></div><aside><button type="button" id="warehouseCreate">新增仓库</button></aside></section><p class="warehouse-live-note">仓库资料与代发费用版本已接入真实保存；其他后台模块仍保持示例数据。</p><section class="warehouse-table"><table><thead><tr><th>仓库</th><th>原仓库名称</th><th>物流承运商</th><th>代发费用</th><th>关联店铺</th><th>关联店铺数</th><th>更新时间</th><th>状态</th><th>操作</th></tr></thead><tbody id="warehouseRows"></tbody></table></section><div class="admin-pagination"><span id="warehouseTotal"></span><label>每页 <select id="warehouseSize"><option value="20">20 条/页</option><option value="50">50 条/页</option><option value="100">100 条/页</option></select></label><div><button type="button" id="warehousePrev">上一页</button><button class="active" type="button" disabled>当前页</button><button type="button" id="warehouseNext">下一页</button></div></div>`;
    document.querySelector('#warehouseSearch').onclick = () => { page = 1; draw(); };
    document.querySelector('#warehouseReset').onclick = () => { document.querySelector('#warehouseFilter').value = ''; document.querySelector('#warehouseStateFilter').value = ''; document.querySelector('#warehouseNameFilter').value = ''; page = 1; draw(); };
    document.querySelector('#warehouseCreate').onclick = () => warehouseForm();
    document.querySelector('#warehouseSize').onchange = () => { page = 1; draw(); };
    document.querySelector('#warehousePrev').onclick = () => { page -= 1; draw(); };
    document.querySelector('#warehouseNext').onclick = () => { page += 1; draw(); };
    root.onclick = event => { const button = event.target.closest('[data-detail], [data-edit], [data-toggle]'); if (!button) return; const id = button.dataset.detail || button.dataset.edit || button.dataset.toggle; const item = warehouses.find(row => row.id === id); if (!item) return; if (button.dataset.detail) detail(item); if (button.dataset.edit) warehouseForm(item); if (button.dataset.toggle) toggle(item); };
  }
  function render() {
    root.innerHTML = '<p class="warehouse-live-note">正在读取仓库数据…</p>';
    load().then(() => { paint(); draw(); }).catch(error => { root.innerHTML = `<p class="warehouse-live-note">${escapeHtml(error.message)}</p>`; });
  }
  document.addEventListener('admin:navigate', event => { if (event.detail.page === 'warehouses') render(); });
})();
