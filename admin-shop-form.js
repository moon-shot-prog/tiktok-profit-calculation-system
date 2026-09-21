(() => {
  const currencies = { US: 'USD', PH: 'PHP', ID: 'IDR', VN: 'VND', TH: 'THB', MY: 'MYR' };
  function enhance() {
    const dialog = document.querySelector('.shop-admin-dialog');
    const warehouseSelect = dialog?.querySelector('#shopWarehouseIds');
    const country = dialog?.querySelector('#shopCountry');
    const currency = dialog?.querySelector('#shopCurrency');
    if (!warehouseSelect || warehouseSelect.dataset.enhanced) return;
    warehouseSelect.dataset.enhanced = 'true';
    const label = warehouseSelect.closest('label');
    const selected = () => [...warehouseSelect.selectedOptions].map(option => option.value);
    const box = document.createElement('div'); box.className = 'shop-warehouse-select';
    box.innerHTML = `<button type="button" class="shop-warehouse-trigger">${selected().length ? `已选 ${selected().length} 个仓库` : '请选择关联仓库'} <b>⌄</b></button><div class="shop-warehouse-menu is-hidden">${[...warehouseSelect.options].map(option => `<label><input type="checkbox" value="${option.value}" ${option.selected ? 'checked' : ''}/>${option.textContent}</label>`).join('')}</div>`;
    warehouseSelect.hidden = true; warehouseSelect.after(box);
    const trigger = box.querySelector('.shop-warehouse-trigger'), menu = box.querySelector('.shop-warehouse-menu');
    const sync = () => { const values = [...menu.querySelectorAll('input:checked')].map(input => input.value); [...warehouseSelect.options].forEach(option => option.selected = values.includes(option.value)); trigger.firstChild.textContent = values.length ? `已选 ${values.length} 个仓库 ` : '请选择关联仓库 '; };
    trigger.addEventListener('click', event => { event.stopPropagation(); menu.classList.toggle('is-hidden'); });
    menu.addEventListener('change', sync);
    document.addEventListener('click', event => { if (!label.contains(event.target)) menu.classList.add('is-hidden'); });
    const updateCurrency = () => { currency.value = currencies[country.value] || 'USD'; };
    country.addEventListener('change', updateCurrency); updateCurrency();
  }
  new MutationObserver(enhance).observe(document.body, { childList: true, subtree: true }); enhance();
})();
