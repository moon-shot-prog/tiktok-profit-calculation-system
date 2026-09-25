(() => {
  const root = document.querySelector('#adminManagement');
  if (!root) return;

  let promotions = [], shops = [], currentPage = 1, selectedCurrency = 'USD', selectedRateType = 'settlement';
  const dialog = document.createElement('dialog');
  dialog.id = 'promotionDialog';
  dialog.className = 'shop-admin-dialog';
  document.body.append(dialog);
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const dateText = value => value ? String(value).slice(0, 10) : '—';
  const money = (amount, currency) => `${escapeHtml(currency || '—')} ${Number(amount || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;
  const amountText = amount => Number(amount || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  const session = () => { try { return JSON.parse(localStorage.getItem('tiktokShopAuthSession') || sessionStorage.getItem('tiktokShopAuthSession') || '{}'); } catch { return {}; } };

  async function request(url, options = {}) {
    const token = session().accessToken || '';
    const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.headers || {}) } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || data.error || '请求失败，请稍后重试');
    return data;
  }

  function setTop() {
    const eyebrow = document.querySelector('.admin-topbar .eyebrow');
    const title = document.querySelector('#adminSuccess');
    if (eyebrow) eyebrow.textContent = 'PROMOTION MANAGEMENT';
    if (title) title.textContent = '推广管理';
    let description = document.querySelector('#adminTopDescription');
    if (!description && title) { description = document.createElement('p'); description.id = 'adminTopDescription'; title.after(description); }
    if (description) description.textContent = '维护已录入的真实推广成本、订单及收入数据。';
    document.querySelector('.admin-stage')?.replaceChildren('真实数据模式 · 推广费用已接入数据库');
  }

  function filtered() {
    const shopId = document.querySelector('#promotionShop')?.value || '';
    const start = document.querySelector('#promotionStartDate')?.value || '';
    const end = document.querySelector('#promotionEndDate')?.value || '';
    return promotions.filter(item => (!shopId || item.shop_id === shopId) && (!start || item.promotion_date >= start) && (!end || item.promotion_date <= end));
  }

  function draw() {
    const rows = filtered(), size = Number(document.querySelector('#promotionPageSize')?.value || 20);
    const totalPages = Math.max(1, Math.ceil(rows.length / size));
    currentPage = Math.min(currentPage, totalPages);
    const pageRows = rows.slice((currentPage - 1) * size, currentPage * size);
    document.querySelector('#promotionRows').innerHTML = pageRows.map(item => {
      const average = !item.conversion_missing && Number(item.order_count) ? Number(item.cost_amount) / Number(item.order_count) : null;
      const roi = !item.conversion_missing && Number(item.cost_amount) ? Number(item.revenue_amount) / Number(item.cost_amount) : null;
      const shop = item.shops || {};
      return `<tr><td>${escapeHtml(shop.shop_name || '—')}<small>${escapeHtml(shop.country_code || '—')}</small></td><td>${dateText(item.promotion_date)}</td><td>${item.conversion_missing ? '—' : amountText(item.cost_amount)}</td><td>${Number(item.order_count || 0).toLocaleString('zh-CN')}</td><td>${average === null ? '—' : amountText(average)}</td><td>${item.conversion_missing ? '—' : amountText(item.revenue_amount)}</td><td><strong class="promotion-roi">${roi === null ? '—' : roi.toFixed(2)}</strong></td><td>${escapeHtml(item.currency_code)}</td><td><button type="button" class="promotion-action" data-promotion-action="detail" data-id="${item.id}">详情</button><button type="button" class="promotion-action" data-promotion-action="edit" data-id="${item.id}">修改</button></td></tr>`;
    }).join('') || '<tr><td colspan="9" class="admin-empty">暂无符合筛选条件的真实店铺日推广费数据</td></tr>';
    document.querySelector('#promotionTotal').textContent = `共 ${rows.length} 条，第 ${currentPage} / ${totalPages} 页`;
    document.querySelector('#promotionPrev').disabled = currentPage === 1;
    document.querySelector('#promotionNext').disabled = currentPage === totalPages;
  }

  function shopOptions(selected = '') {
    return `<option value="">请选择店铺</option>${shops.map(shop => `<option value="${shop.id}" ${shop.id === selected ? 'selected' : ''}>${escapeHtml(shop.shop_name)} · ${escapeHtml(shop.country_code)}</option>`).join('')}`;
  }
  function closeDialog() { if (dialog.open) dialog.close(); }

  function formDialog(record) {
    const isEdit = Boolean(record);
    const values = record || { shop_id: '', promotion_date: '', cost_amount: '', order_count: 0, revenue_amount: '', currency_code: 'CNY', note: '' };
    dialog.innerHTML = `<section class="promotion-dialog-content"><button class="dialog-close" type="button" aria-label="关闭">×</button><h2>${isEdit ? '修改店铺日推广费' : '新增店铺日推广费'}</h2><p>按店铺、日期保存真实推广费用；平均下单成本与 ROI 将根据成本、SKU 订单数和总收入自动计算。</p><form id="promotionForm"><label>当前店铺 / 站点<select name="shopId" required>${shopOptions(values.shop_id)}</select></label><label>按天<input name="promotionDate" type="date" required value="${dateText(values.promotion_date) === '—' ? '' : dateText(values.promotion_date)}" /></label><label>成本<input name="costAmount" type="number" min="0" step="0.01" required value="${values.cost_amount}" /></label><label>币种<input name="currencyCode" maxlength="3" required value="${escapeHtml(values.currency_code)}" /></label><label>SKU 订单数<input name="orderCount" type="number" min="0" step="1" required value="${values.order_count}" /></label><label>总收入<input name="revenueAmount" type="number" min="0" step="0.01" required value="${values.revenue_amount}" /></label><label class="promotion-note-field">备注（可选）<textarea name="note" maxlength="500">${escapeHtml(values.note || '')}</textarea></label><div class="promotion-form-actions"><button type="button" class="admin-secondary" data-close>取消</button><button type="submit">${isEdit ? '保存修改' : '确认新增'}</button></div></form></section>`;
    if (!dialog.open) dialog.showModal();
    dialog.querySelectorAll('[data-close], .dialog-close').forEach(button => button.onclick = closeDialog);
    dialog.querySelector('#promotionForm').onsubmit = async event => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const orderCount = Number(form.get('orderCount'));
      const body = { shopId: form.get('shopId'), promotionDate: form.get('promotionDate'), currencyCode: String(form.get('currencyCode')).trim().toUpperCase(), costAmount: Number(form.get('costAmount')), skuCount: orderCount, orderCount, revenueAmount: Number(form.get('revenueAmount')), note: form.get('note') };
      const submit = event.currentTarget.querySelector('[type="submit"]'); submit.disabled = true;
      try { await request(isEdit ? '/api/admin/promotions/configuration' : '/api/admin/promotions', { method: isEdit ? 'PUT' : 'POST', body: JSON.stringify(isEdit ? { id: record.id, ...body } : body) }); closeDialog(); await load(); }
      catch (error) { window.alert(error.message); submit.disabled = false; }
    };
  }

  function detailDialog(record) {
    const shop = record.shops || {};
    const average = Number(record.order_count) ? Number(record.cost_amount) / Number(record.order_count) : null;
    const roi = Number(record.cost_amount) ? Number(record.revenue_amount) / Number(record.cost_amount) : null;
    dialog.innerHTML = `<section class="promotion-dialog-content"><button class="dialog-close" type="button" aria-label="关闭">×</button><h2>店铺日推广费详情</h2><dl class="promotion-detail"><dt>当前店铺 / 站点</dt><dd>${escapeHtml(shop.shop_name || '—')} · ${escapeHtml(shop.country_code || '—')}</dd><dt>按天</dt><dd>${dateText(record.promotion_date)}</dd><dt>成本</dt><dd>${money(record.cost_amount, record.currency_code)}</dd><dt>SKU 订单数</dt><dd>${Number(record.order_count || 0).toLocaleString('zh-CN')}</dd><dt>平均下单成本</dt><dd>${average === null ? '—' : money(average, record.currency_code)}</dd><dt>总收入 / 投资回报率</dt><dd>${money(record.revenue_amount, record.currency_code)} / ${roi === null ? '—' : roi.toFixed(2)}</dd><dt>备注</dt><dd>${escapeHtml(record.note || '—')}</dd></dl></section>`;
    if (!dialog.open) dialog.showModal();
    dialog.querySelector('.dialog-close').onclick = closeDialog;
  }

  function importDialog() {
    dialog.innerHTML = `<section class="promotion-dialog-content"><button class="dialog-close" type="button" aria-label="关闭">×</button><h2>导入店铺日推广费</h2><p>先选择对应店铺，再上传 CSV 或 Excel。系统会先校验，确认后才写入真实数据并生成导入批次。</p><form id="promotionImportForm"><label>对应店铺 / 站点<select name="shopId" required>${shopOptions()}</select></label><label>导入批次<input id="promotionBatchCode" value="校验后自动生成，例如 20260925-0001" readonly /></label><label class="promotion-note-field">上传 CSV / Excel<input name="file" type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required /><small>表头必须为：按天、成本、SKU 订单数（当前店铺）、平均下单成本（当前店铺）、总收入（当前店铺）、投资回报率 (ROI)（当前店铺）、币种。SKU 订单数直接填写整数，例如 34。</small><button type="button" id="promotionImportTemplate" class="promotion-template-button">下载空模板</button></label><div class="promotion-form-actions"><button type="button" class="admin-secondary" data-close>取消</button><button type="submit">校验并预览</button></div></form><section id="promotionImportResult" class="promotion-import-result"></section></section>`;
    if (!dialog.open) dialog.showModal();
    dialog.querySelectorAll('[data-close], .dialog-close').forEach(button => button.onclick = closeDialog);
    dialog.querySelector('#promotionImportTemplate').onclick = () => {
      const headers = ['按天', '成本', 'SKU 订单数（当前店铺）', '平均下单成本（当前店铺）', '总收入（当前店铺）', '投资回报率 (ROI)（当前店铺）', '币种'];
      const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([`\uFEFF${headers.join(',')}\r\n`], { type: 'text/csv;charset=utf-8' })); link.download = '店铺日推广费导入模板.csv'; link.click(); URL.revokeObjectURL(link.href);
    };
    const upload = async mode => {
      const form = dialog.querySelector('#promotionImportForm'), file = form.elements.file.files[0];
      if (!file) throw new Error('请选择 CSV 或 Excel 文件');
      if (!/\.(csv|xlsx)$/i.test(file.name)) throw new Error('仅支持 CSV 或 .xlsx 文件');
      const fileBase64 = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('读取文件失败')); reader.readAsDataURL(file); });
      return request('/api/admin/promotions/import', { method: 'POST', body: JSON.stringify({ mode, shopId: form.elements.shopId.value, fileName: file.name, fileBase64 }) });
    };
    dialog.querySelector('#promotionImportForm').onsubmit = async event => {
      event.preventDefault();
      const note = dialog.querySelector('#promotionImportResult'), submit = event.currentTarget.querySelector('[type="submit"]');
      submit.disabled = true; note.textContent = '正在校验文件…';
      try {
        const preview = await upload('preview');
        if (!preview.valid) { note.innerHTML = `<strong>校验失败</strong>${(preview.failures || []).slice(0, 10).map(item => `<p>第 ${item.row} 行：${escapeHtml(item.reason)}</p>`).join('')}`; return; }
        dialog.querySelector('#promotionBatchCode').value = preview.batchCode;
        note.innerHTML = `<strong>校验完成 · 批次 ${escapeHtml(preview.batchCode)}</strong><p>共 ${preview.totalRows} 条；新增 ${preview.insertCount} 条，更新 ${preview.updateCount} 条。</p><button type="button" id="promotionImportCommit">确认导入</button>`;
        dialog.querySelector('#promotionImportCommit').onclick = async () => {
          const commit = dialog.querySelector('#promotionImportCommit'); commit.disabled = true; note.textContent = '正在写入店铺日推广费…';
          try { const done = await upload('commit'); closeDialog(); await load(); draw(); window.alert(done.message); }
          catch (error) { note.textContent = error.message; commit.disabled = false; }
        };
      } catch (error) { note.textContent = error.message; }
      finally { submit.disabled = false; }
    };
  }

  async function load() {
    try {
      selectedCurrency = document.querySelector('#promotionCurrency')?.value || 'USD';
      selectedRateType = document.querySelector('#promotionRateType')?.value || 'settlement';
      const data = await request(`/api/admin/promotions?currency=${encodeURIComponent(selectedCurrency)}&rateType=${encodeURIComponent(selectedRateType)}`);
      promotions = data.promotions || []; shops = data.shops || []; selectedCurrency = data.currency || selectedCurrency; selectedRateType = data.rateType || selectedRateType; return true;
    }
    catch (error) { document.querySelector('#promotionRows').innerHTML = `<tr><td colspan="9" class="admin-empty">${escapeHtml(error.message)}</td></tr>`; return false; }
  }

  function render() {
    setTop();
    root.innerHTML = `<section class="promotion-workspace"><section class="promotion-fixed-area"><section class="promotion-filters"><label>店铺<select id="promotionShop"><option value="">全部店铺</option></select></label><label>日期<div class="promotion-date-range"><input id="promotionStartDate" type="date" aria-label="开始日期" /><span>至</span><input id="promotionEndDate" type="date" aria-label="结束日期" /></div></label><label>币种<select id="promotionCurrency"><option value="USD" ${selectedCurrency === 'USD' ? 'selected' : ''}>USD</option><option value="CNY" ${selectedCurrency === 'CNY' ? 'selected' : ''}>人民币</option></select></label><label>汇率选项<select id="promotionRateType"><option value="settlement" ${selectedRateType === 'settlement' ? 'selected' : ''}>报表结算汇率</option><option value="reference" ${selectedRateType === 'reference' ? 'selected' : ''}>实时参考汇率</option></select></label><div><button type="button" id="promotionSearch">查询</button><button type="button" id="promotionReset">重置</button></div></section><section class="promotion-control-row"><p class="promotion-live-note">真实数据：按店铺、按天保存推广成本；金额按所选币种和汇率选项换算，SKU 订单数、平均下单成本、总收入与 ROI 均为当前店铺当天的真实记录指标。</p><section class="promotion-toolbar"><div><button type="button" id="promotionImport" class="promotion-import-button">导入</button><button type="button" id="promotionCreate">新增店铺日推广费</button></div></section></section></section><section class="promotion-table"><table><thead><tr><th>店铺 / 站点</th><th>按天</th><th>成本</th><th>SKU 订单数（当前店铺）</th><th>平均下单成本（当前店铺）</th><th>总收入（当前店铺）</th><th>投资回报率 (ROI)（当前店铺）</th><th>币种</th><th>操作</th></tr></thead><tbody id="promotionRows"><tr><td colspan="9" class="admin-empty">正在读取真实店铺日推广费数据…</td></tr></tbody></table></section><div class="admin-pagination"><span id="promotionTotal">共 0 条，第 1 / 1 页</span><label>每页 <select id="promotionPageSize"><option value="20">20 条/页</option><option value="50">50 条/页</option><option value="100">100 条/页</option></select></label><div><button type="button" id="promotionPrev">上一页</button><button class="active" type="button" disabled>当前页</button><button type="button" id="promotionNext">下一页</button></div></div></section>`;
    const fillShops = () => { document.querySelector('#promotionShop').innerHTML = `<option value="">全部店铺</option>${shopOptions().replace('<option value="">请选择店铺</option>', '')}`; };
    document.querySelector('#promotionSearch').onclick = async () => { currentPage = 1; if (await load()) draw(); };
    document.querySelector('#promotionReset').onclick = async () => { document.querySelector('#promotionShop').value = ''; document.querySelector('#promotionStartDate').value = ''; document.querySelector('#promotionEndDate').value = ''; document.querySelector('#promotionCurrency').value = 'USD'; document.querySelector('#promotionRateType').value = 'settlement'; currentPage = 1; if (await load()) draw(); };
    document.querySelector('#promotionImport').onclick = importDialog;
    document.querySelector('#promotionCreate').onclick = () => formDialog();
    document.querySelector('#promotionPageSize').onchange = () => { currentPage = 1; draw(); };
    document.querySelector('#promotionPrev').onclick = () => { currentPage -= 1; draw(); };
    document.querySelector('#promotionNext').onclick = () => { currentPage += 1; draw(); };
    root.onclick = event => { const button = event.target.closest('[data-promotion-action]'); if (!button) return; const record = promotions.find(item => item.id === button.dataset.id); if (record) button.dataset.promotionAction === 'detail' ? detailDialog(record) : formDialog(record); };
    load().then(ok => { if (ok) { fillShops(); draw(); } });
  }

  document.addEventListener('admin:navigate', event => { if (event.detail.page === 'promotions') render(); });
})();
