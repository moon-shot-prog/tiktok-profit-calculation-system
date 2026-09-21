(() => {
  const stores = ['美国旗舰店', '菲律宾精选店', '越南家居店', '泰国市场店'];
  function enhance() {
    const form = document.querySelector('#memberCreateForm');
    const scope = document.querySelector('#memberShopScope');
    if (!form || !scope || scope.dataset.enhanced) return;
    scope.dataset.enhanced = 'true';
    const nameInput = document.querySelector('#memberName');
    const emailInput = document.querySelector('#memberEmail');
    if (nameInput && emailInput) { nameInput.required = true; document.querySelector('#memberPassword')?.closest('label')?.after(nameInput.closest('label')); }
    form.closest('.member-create')?.querySelector('.member-create-heading')?.remove();
    form.closest('.member-create')?.insertAdjacentHTML('afterbegin', '<div class="member-create-heading"><h3>创建成员账号</h3><p>管理员填写邮箱、角色、可访问店铺和初始密码，再通过公司内部方式发送给业务员。</p></div>');
    scope.innerHTML = `<span>授权店铺</span><button type="button" class="shop-select-trigger">全部店铺 <b>⌄</b></button><div class="shop-select-menu is-hidden">${stores.map(store => `<label><input type="checkbox" value="${store}" checked />${store}</label>`).join('')}</div><select id="memberShops" multiple hidden>${stores.map(store => `<option value="${store}" selected>${store}</option>`).join('')}</select>`;
    const trigger = scope.querySelector('.shop-select-trigger'), menu = scope.querySelector('.shop-select-menu'), select = scope.querySelector('#memberShops');
    const sync = () => { const checked = [...menu.querySelectorAll('input:checked')].map(input => input.value); [...select.options].forEach(option => option.selected = checked.includes(option.value)); trigger.firstChild.textContent = checked.length === stores.length ? '全部店铺 ' : checked.length ? `已选 ${checked.length} 个店铺 ` : '请选择店铺 '; };
    trigger.addEventListener('click', event => { event.stopPropagation(); menu.classList.toggle('is-hidden'); });
    menu.addEventListener('change', sync);
    document.addEventListener('click', event => { if (!scope.contains(event.target)) menu.classList.add('is-hidden'); });
  }
  new MutationObserver(enhance).observe(document.querySelector('#adminManagement'), { childList: true, subtree: true });
  enhance();
})();
