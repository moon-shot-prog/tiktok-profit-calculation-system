(() => {
  const template = '\uFEFFproduct_code,product_name,sale_price,effective_date,image_url,status\r\n';

  function downloadTemplate() {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([template], { type: 'text/csv;charset=utf-8' }));
    link.download = '商品导入模板.csv';
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(link.href);
  }

  const session = () => { try { return JSON.parse(localStorage.getItem('tiktokShopAuthSession') || sessionStorage.getItem('tiktokShopAuthSession') || '{}'); } catch { return {}; } };
  async function request(url, body) {
    const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${session().accessToken || ''}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || '操作失败，请稍后重试');
    return data;
  }

  async function submitImport(event, dialog) {
    event.preventDefault();
    const form = event.currentTarget, warehouseId = form.querySelector('#productImportWarehouse')?.value || '';
    const file = form.querySelector('#productImportFile')?.files[0], note = dialog.querySelector('#productImportMessage');
    if (!warehouseId) return note.textContent = '请选择导入仓库';
    if (!file) return note.textContent = '请选择 CSV 或 Excel 文件';
    if (!/\.(csv|xlsx)$/i.test(file.name)) return note.textContent = '仅支持 CSV 或 .xlsx 文件';
    note.textContent = '正在校验文件…';
    try {
      const fileBase64 = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('读取文件失败')); reader.readAsDataURL(file); });
      const payload = mode => ({ mode, warehouseId, fileName: file.name, fileBase64 });
      const preview = await request('/api/admin/products/import', payload('preview'));
      if (!preview.valid) return note.textContent = preview.failures.slice(0, 5).map(item => `第${item.row}行：${item.reason}`).join('；');
      note.innerHTML = `校验完成：共 ${preview.totalRows} 条，新增 ${preview.insertCount}，更新 ${preview.updateCount}。<button id="productImportCommit" type="button">确认导入</button>`;
      note.querySelector('#productImportCommit').onclick = async () => { try { note.textContent = '正在写入商品数据…'; const done = await request('/api/admin/products/import', payload('commit')); dialog.close(); document.querySelector('#adminProductSearch')?.click(); window.alert(done.message); } catch (error) { note.textContent = error.message; } };
    } catch (error) { note.textContent = error.message; }
  }

  function enhance() {
    const dialog = document.querySelector('.product-admin-dialog[open]');
    const form = dialog?.querySelector('#productImportForm');
    const previewButton = form?.querySelector('#productImportPreview');
    if (!form || !previewButton || form.dataset.templateReady) return;
    form.dataset.templateReady = 'true';
    const actions = document.createElement('div');
    actions.className = 'product-import-actions';
    actions.innerHTML = '<button type="button" class="product-import-template">下载导入模板</button>';
    previewButton.before(actions);
    actions.append(previewButton);
    actions.querySelector('.product-import-template').addEventListener('click', downloadTemplate);
    const options = [...document.querySelector('#productWarehouse')?.options || []].filter(option => option.value && !option.textContent.includes('已停用')).map(option => `<option value="${option.value}">${option.textContent}</option>`).join('');
    const upload = form.querySelector('.product-import-upload');
    upload?.insertAdjacentHTML('beforebegin', `<label>仓库<select id="productImportWarehouse" required><option value="">请选择导入仓库</option>${options}</select><small>导入文件无需填写 warehouse_name，所有商品将归属此仓库。</small></label>`);
    const description = dialog.querySelector('h2')?.nextElementSibling;
    if (description?.tagName === 'P') description.textContent = '选择导入仓库后上传 CSV 或 Excel；系统按该仓库中的商品编码识别新增或更新。';
    const uploadHint = upload?.querySelector('small');
    if (uploadHint) uploadHint.textContent = '英文表头：product_code、product_name、sale_price；可选 effective_date（YYYY-MM-DD，默认 2026-08-01）、image_url、status。';
    form.onsubmit = event => submitImport(event, dialog);
  }

  new MutationObserver(enhance).observe(document.body, { childList: true, subtree: true });
  enhance();
})();
