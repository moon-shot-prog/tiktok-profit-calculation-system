(() => {
  const countries = [
    { name: '菲律宾', code: 'PH', currency: 'PHP' }, { name: '印尼', code: 'ID', currency: 'IDR' },
    { name: '越南', code: 'VN', currency: 'VND' }, { name: '泰国', code: 'TH', currency: 'THB' }
  ];
  function enhance() {
    const dialog = document.querySelector('.warehouse-modal');
    const form = dialog?.querySelector('#warehouseCostForm');
    const warehouse = dialog?.querySelector('#costWarehouse');
    if (!form || !warehouse || form.dataset.newWarehouseEnhanced || dialog.querySelector('h2')?.textContent !== '新增仓库费用') return;
    form.dataset.newWarehouseEnhanced = 'true';
    dialog.querySelector('h2').textContent = '新增仓库';
    const oldLabel = warehouse.closest('label');
    oldLabel.innerHTML = '<span>仓库名称</span><input id="costWarehouse" required placeholder="请输入仓库名称" />';
    oldLabel.insertAdjacentHTML('afterend', `<label class="country-site">国家站点<input id="warehouseCountry" list="warehouseCountryOptions" placeholder="请输入或搜索国家站点" autocomplete="off" /><datalist id="warehouseCountryOptions">${countries.map(country => `<option value="${country.name}"></option>`).join('')}</datalist></label><section class="new-country-form is-hidden"><strong>新增国家站点</strong><label>国家／站点名称<input id="newCountryName" placeholder="例如：新加坡" /></label><label>两位国家代码<input id="newCountryCode" maxlength="2" placeholder="SG" /></label><label>默认货币<input id="newCountryCurrency" placeholder="SGD" /></label><button type="button" id="saveCountrySite">保存并选中</button></section>`);
    const countryInput = dialog.querySelector('#warehouseCountry');
    countryInput.addEventListener('change', () => { const country = countries.find(item => item.name === countryInput.value.trim()); if (country) dialog.querySelector('#costCurrency').value = country.currency; });
    countryInput.addEventListener('keydown', event => { const exists = countries.some(country => country.name === countryInput.value.trim()); if (event.key === 'Enter' && countryInput.value.trim() && !exists) { event.preventDefault(); dialog.querySelector('.new-country-form').classList.remove('is-hidden'); dialog.querySelector('#newCountryName').value = countryInput.value.trim(); } });
    dialog.querySelector('#saveCountrySite').addEventListener('click', () => { const name = dialog.querySelector('#newCountryName').value.trim(), code = dialog.querySelector('#newCountryCode').value.trim().toUpperCase(), currency = dialog.querySelector('#newCountryCurrency').value.trim().toUpperCase(); if (!name || !/^[A-Z]{2}$/.test(code) || !/^[A-Z]{3}$/.test(currency)) return window.alert('请填写国家／站点名称、两位国家代码和三位默认货币。'); countries.push({ name, code, currency }); dialog.querySelector('#warehouseCountryOptions').insertAdjacentHTML('beforeend', `<option value="${name}"></option>`); countryInput.value = name; dialog.querySelector('#costCurrency').value = currency; dialog.querySelector('.new-country-form').classList.add('is-hidden'); });
    const note = dialog.querySelector('#costNote');
    note?.insertAdjacentHTML('afterend', '<p class="warehouse-version-note">新增费用将作为首个代发费用版本；后续修改会新增版本记录，利润计算按订单日期匹配对应版本（接口待接入）。</p>');
  }
  // 仅在文本确实不同的时候更新。此前每次 DOM 变动都会无条件写回同一段文本，
  // 该写入又会触发 MutationObserver，自身形成无限循环并使页面无响应。
  function renameButton() {
    const button = document.querySelector('#warehouseCreate');
    if (button && button.textContent !== '新增仓库') button.textContent = '新增仓库';
  }
  new MutationObserver(() => { enhance(); renameButton(); }).observe(document.body, { childList: true, subtree: true });
  enhance(); renameButton();
})();
