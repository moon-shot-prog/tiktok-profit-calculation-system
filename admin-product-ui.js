(() => {
  const root = document.querySelector('#adminManagement');
  if (!root) return;
  const dialog = document.createElement('dialog');
  dialog.className = 'product-admin-dialog';
  document.body.append(dialog);
  let products = [];
  let warehouses = [];
  let page = 1;
  let pageSize = 20;

  const stateLabels = { pending_review: '待审核', approved: '可用', rejected: '已驳回', disabled: '已停用' };
  const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
  const shortDate = value => value ? new Date(value).toLocaleDateString('zh-CN').replaceAll('/', '-') : '—';
  const session = () => { try { return JSON.parse(localStorage.getItem('tiktokShopAuthSession') || sessionStorage.getItem('tiktokShopAuthSession') || '{}'); } catch { return {}; } };
  const request = async (url, options = {}) => {
    const response = await fetch(url, { ...options, headers: { Authorization: `Bearer ${session().accessToken}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.message || '操作失败，请稍后重试');
    return body;
  };
  function setTopbar() {
    document.querySelector('.admin-topbar .eyebrow').textContent = 'BASIC DATA';
    document.querySelector('#adminSuccess').textContent = '商品管理';
    let description = document.querySelector('#adminTopDescription');
    if (!description) { description = document.createElement('p'); description.id = 'adminTopDescription'; document.querySelector('#adminSuccess').after(description); }
    description.textContent = '维护真实商品资料、审核状态与仓库归属；商品编码以仓库为唯一维度。';
  }
  function activeWarehouses() { return warehouses.filter(item => item.is_active); }
  function filtered() {
    const warehouseId = document.querySelector('#productWarehouse')?.value || '';
    const code = document.querySelector('#productCode')?.value.trim().toLowerCase() || '';
    const name = document.querySelector('#productName')?.value.trim().toLowerCase() || '';
    const start = document.querySelector('#productUpdatedStart')?.value || '';
    const end = document.querySelector('#productUpdatedEnd')?.value || '';
    const status = document.querySelector('#productStatus')?.value || '';
    return products.filter(item => (!warehouseId || item.warehouse_id === warehouseId) && (!code || item.product_code.toLowerCase().includes(code)) && (!name || item.product_name.toLowerCase().includes(name)) && (!start || String(item.updated_at).slice(0, 10) >= start) && (!end || String(item.updated_at).slice(0, 10) <= end) && (!status || item.status === status));
  }
  function warehouseName(id) { return warehouses.find(item => item.id === id)?.name || '已删除仓库'; }
  function draw() {
    const list = filtered();
    const totalPages = Math.max(1, Math.ceil(list.length / pageSize));
    page = Math.min(page, totalPages);
    const current = list.slice((page - 1) * pageSize, page * pageSize);
    document.querySelector('#adminProductRows').innerHTML = current.map(item => {
      const image = item.image_url ? `<img class="product-thumb-image" src="${escapeHtml(item.image_url)}" alt="${escapeHtml(item.product_name)}" />` : `<span class="product-thumb">${escapeHtml(item.product_name.slice(0, 1) || '商')}</span>`;
      return `<tr><td>${image}</td><td><strong>${escapeHtml(item.product_code)}</strong></td><td>${escapeHtml(item.product_name)}</td><td>${escapeHtml(item.currency_code)} ${Number(item.sale_price).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td><td>${escapeHtml(warehouseName(item.warehouse_id))}</td><td>${shortDate(item.updated_at)}</td><td><span class="product-state ${item.status}">${stateLabels[item.status] || item.status}</span></td><td><button data-product-edit="${item.id}">修改</button><button data-product-delete="${item.id}">删除</button></td></tr>`;
    }).join('') || '<tr><td colspan="8" class="admin-empty">暂无真实商品数据，请新增商品。</td></tr>';
    document.querySelector('#adminProductPage').textContent = `${page} / ${totalPages}`;
    document.querySelector('#adminProductPrev').disabled = page <= 1;
    document.querySelector('#adminProductNext').disabled = page >= totalPages;
  }
  function showMessage(message, type = 'info') {
    const box = document.querySelector('#productLiveMessage');
    box.textContent = message; box.dataset.type = type; box.hidden = false;
  }
  async function load() {
    showMessage('正在读取真实商品数据…');
    const data = await request('/api/admin/products');
    products = data.products || []; warehouses = data.warehouses || [];
    document.querySelector('#productWarehouse').innerHTML = `<option value="">全部仓库</option>${warehouses.map(item => `<option value="${item.id}">${escapeHtml(item.name)}${item.is_active ? '' : '（已停用）'}</option>`).join('')}`;
    showMessage(`已读取 ${products.length} 条真实商品数据。`, 'success'); draw();
  }
  function form(item) {
    const editing = Boolean(item);
    const options = activeWarehouses();
    dialog.innerHTML = `<button class="dialog-close" type="button">×</button><h2>${editing ? '修改商品' : '新增商品'}</h2><p>商品编码在同一仓库内不能重复。商品图片当前使用公开图片链接；本地图片上传将在后续接入存储服务。</p><form id="adminProductForm"><label>商品图片链接（可选）<input id="productImageUrl" type="url" placeholder="https://…" value="${escapeHtml(item?.image_url || '')}" /></label><label>商品编码<input id="productFormCode" value="${escapeHtml(item?.product_code || '')}" required /></label><label>商品名称<input id="productFormName" value="${escapeHtml(item?.product_name || '')}" required /></label><label>商品单价<input id="productFormPrice" type="number" min="0" step="0.01" value="${item?.sale_price ?? ''}" required /></label><label>币种<input id="productFormCurrency" value="CNY" readonly /><small>商品售价统一以人民币计价</small></label><label>仓库<select id="productFormWarehouse" required><option value="">请选择仓库</option>${options.map(warehouse => `<option value="${warehouse.id}" ${item?.warehouse_id === warehouse.id ? 'selected' : ''}>${escapeHtml(warehouse.name)}</option>`).join('')}</select></label><label>状态<select id="productFormStatus">${Object.entries(stateLabels).map(([value, label]) => `<option value="${value}" ${(item?.status || 'pending_review') === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label>更新时间<input type="text" value="${editing ? shortDate(item.updated_at) : '保存后自动生成'}" disabled /></label><button type="submit">${editing ? '保存修改' : '保存并新增商品'}</button></form><p id="productFormMessage" class="product-form-note" hidden></p>`;
    dialog.querySelector('#productFormPrice')?.closest('label')?.insertAdjacentHTML('afterend', `<label>成本生效日期<input id="productCostEffectiveDate" type="date" value="${escapeHtml(item?.effective_date || '2026-08-01')}" required /><small>可直接修改当前成本版本的生效日期；修改单价、仓库或编码时会新增成本版本。</small></label>`);
    dialog.showModal(); dialog.querySelector('.dialog-close').onclick = () => dialog.close();
    dialog.querySelector('form').onsubmit = async event => {
      event.preventDefault(); const note = dialog.querySelector('#productFormMessage'); note.hidden = false; note.textContent = '正在保存…';
      const field = id => dialog.querySelector(`#${id}`).value;
      const payload = { warehouseId: field('productFormWarehouse'), productCode: field('productFormCode'), productName: field('productFormName'), salePrice: field('productFormPrice'), currencyCode: field('productFormCurrency'), status: field('productFormStatus'), imageUrl: field('productImageUrl'), effectiveDate: field('productCostEffectiveDate') };
      if (editing) payload.productId = item.id;
      try { await request(editing ? '/api/admin/products/configuration' : '/api/admin/products', { method: editing ? 'PUT' : 'POST', body: JSON.stringify(payload) }); dialog.close(); await load(); showMessage(editing ? '商品已保存。' : '商品已新增。', 'success'); } catch (error) { note.textContent = error.message; }
    };
  }
  function importDialog() {
    dialog.innerHTML = `<button class="dialog-close" type="button">×</button><p class="eyebrow">商品资料导入</p><h2>导入商品</h2><p>上传 CSV 或 Excel 后先校验；按仓库名称与商品编码识别新增或更新，确认后才会写入。</p><form id="productImportForm" class="product-import-form"><label>导入批次<input value="校验后自动生成" readonly></label><label>数据类型<input value="商品资料" readonly></label><label class="product-upload product-import-upload">上传 CSV / Excel<input id="productImportFile" type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required><small>英文表头：warehouse_name、product_code、product_name、sale_price；可选 image_url、status、effective_date（YYYY-MM-DD，默认 2026-08-01）。</small></label><button id="productImportPreview" class="product-import-preview" type="submit">校验并预览</button></form><section id="productImportMessage" class="product-form-note"></section>`;
    dialog.showModal(); dialog.querySelector('.dialog-close').onclick = () => dialog.close();
    const upload = async mode => {
      const file = dialog.querySelector('#productImportFile').files[0], note = dialog.querySelector('#productImportMessage');
      if (!file) throw new Error('请选择 CSV 或 Excel 文件');
      if (!/\.(csv|xlsx)$/i.test(file.name)) throw new Error('仅支持 CSV 或 .xlsx 文件');
      const fileBase64 = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('读取文件失败')); reader.readAsDataURL(file); });
      return request('/api/admin/products/import', { method: 'POST', body: JSON.stringify({ mode, fileName: file.name, fileBase64 }) });
    };
    dialog.querySelector('#productImportForm').onsubmit = async event => {
      event.preventDefault(); const note = dialog.querySelector('#productImportMessage'); note.textContent = '正在校验文件…';
      try {
        const preview = await upload('preview');
        if (!preview.valid) return note.textContent = preview.failures.slice(0, 5).map(item => `第${item.row}行：${item.reason}`).join('；');
        const duplicateHint = preview.duplicateCount ? `文件内 ${preview.duplicateCount} 个重复编码已按最后一条覆盖（去重后 ${preview.totalRows} 条）。` : '';
        note.innerHTML = `校验完成：原始 ${preview.sourceRows ?? preview.totalRows} 条，新增 ${preview.insertCount}，更新 ${preview.updateCount}。${duplicateHint}<button id="productImportCommit" type="button">确认导入</button>`;
        dialog.querySelector('#productImportCommit').onclick = async () => { try { note.textContent = '正在写入商品数据…'; const done = await upload('commit'); dialog.close(); await load(); showMessage(done.message, 'success'); } catch (error) { note.textContent = error.message; } };
      } catch (error) { note.textContent = error.message; }
    };
  }
  async function remove(item) {
    if (!window.confirm(`确认删除商品“${item.product_name}”吗？此操作目前不可恢复。`)) return;
    try { await request('/api/admin/products', { method: 'DELETE', body: JSON.stringify({ productId: item.id }) }); await load(); showMessage('商品已删除。', 'success'); } catch (error) { showMessage(error.message, 'error'); }
  }
  function exportCsv() {
    const rows = filtered();
    const lines = [['商品编码', '商品名称', '商品单价', '币种', '仓库', '更新时间', '状态'], ...rows.map(item => [item.product_code, item.product_name, item.sale_price, item.currency_code, warehouseName(item.warehouse_id), shortDate(item.updated_at), stateLabels[item.status] || item.status])];
    const content = '\uFEFF' + lines.map(line => line.map(value => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\r\n');
    const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' })); link.download = `商品列表_${new Date().toISOString().slice(0, 10)}.csv`; link.click(); URL.revokeObjectURL(link.href);
  }
  function render() {
    root.classList.add('product-management-active');
    setTopbar();
    root.innerHTML = `<section class="product-admin-filters"><label>仓库<select id="productWarehouse"><option value="">全部仓库</option></select></label><label>商品编码<input id="productCode" placeholder="请输入商品编码" /></label><label>商品名称<input id="productName" placeholder="支持模糊查询" /></label><label>更新时间<span><input id="productUpdatedStart" type="date" aria-label="开始日期" /> - <input id="productUpdatedEnd" type="date" aria-label="结束日期" /></span></label><label>状态<select id="productStatus"><option value="">全部状态</option>${Object.entries(stateLabels).map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></label><div><button id="adminProductSearch" type="button">查询</button><button id="adminProductReset" type="button">重置</button></div></section><section class="product-admin-toolbar"><aside><button id="adminProductImport" type="button">导入</button><button id="adminProductExport" type="button">导出</button><button id="adminProductCreate" type="button">新增商品</button></aside></section><section class="product-admin-table"><table><thead><tr><th>商品图片</th><th>商品编码</th><th>商品名称</th><th>商品单价</th><th>仓库</th><th>更新时间</th><th>状态</th><th>操作</th></tr></thead><tbody id="adminProductRows"></tbody></table></section><div class="admin-pagination"><p id="productLiveMessage" class="product-live-message admin-pagination-total" hidden></p><label>每页 <select id="adminProductSize"><option value="20">20 条/页</option><option value="50">50 条/页</option><option value="100">100 条/页</option></select></label><div><button id="adminProductPrev">上一页</button><span id="adminProductPage">1 / 1</span><button id="adminProductNext">下一页</button></div></div><p class="feedback-demo-note">商品数据已接入真实数据库，支持 CSV / Excel 批量校验、预览并确认写入。</p>`;
    document.querySelector('#adminProductSearch').onclick = () => { page = 1; draw(); };
    document.querySelector('#adminProductReset').onclick = () => { document.querySelectorAll('.product-admin-filters input,.product-admin-filters select').forEach(field => field.value = ''); page = 1; draw(); };
    document.querySelector('#adminProductImport').onclick = importDialog; document.querySelector('#adminProductExport').onclick = exportCsv; document.querySelector('#adminProductCreate').onclick = () => form();
    document.querySelector('#adminProductSize').onchange = event => { pageSize = Number(event.target.value); page = 1; draw(); }; document.querySelector('#adminProductPrev').onclick = () => { page--; draw(); }; document.querySelector('#adminProductNext').onclick = () => { page++; draw(); };
    root.onclick = event => { const id = event.target.dataset.productEdit || event.target.dataset.productDelete; if (!id) return; const item = products.find(product => product.id === id); if (event.target.dataset.productEdit) form(item); if (event.target.dataset.productDelete) remove(item); };
    load().catch(error => showMessage(error.message, 'error'));
  }
  document.addEventListener('admin:navigate', event => { if (event.detail.page === 'products') render(); else root.classList.remove('product-management-active'); });
})();
