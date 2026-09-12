(() => {
  const mount = document.querySelector('#adminManagement');
  if (!mount) return;
  let state = { shops: [], users: [] };
  const token = () => {
    const raw = localStorage.getItem('tiktokShopAuthSession') || sessionStorage.getItem('tiktokShopAuthSession');
    try { return JSON.parse(raw || '{}').accessToken; } catch { return null; }
  };
  async function api(url, options = {}) {
    const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}`, ...(options.headers || {}) } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || '操作失败');
    return data;
  }
  const shopChecks = (checked = []) => state.shops.map(shop => `<label><input type="checkbox" value="${shop.id}" ${checked.includes(shop.id) ? 'checked' : ''}/> ${shop.shop_name}</label>`).join('') || '<span class="admin-empty">请先新增店铺</span>';
  function roleText(role) { return ({ super_admin: '超级管理员', admin: '管理员', finance: '财务', business_user: '业务员' })[role] || '未分配'; }
  function render(message = '') {
    const shops = state.shops.map(shop => `<tr><td>${shop.shop_code}</td><td>${shop.shop_name}</td><td>${shop.country_code}</td><td>${shop.currency_code}</td><td>${shop.is_active ? '启用' : '停用'}</td></tr>`).join('') || '<tr><td colspan="5" class="admin-empty">暂未建立店铺</td></tr>';
    const users = state.users.map(user => `<tr data-user="${user.id}"><td>${user.displayName || '—'}<br/><small>${user.email || '—'}</small></td><td>${user.confirmed ? '已激活' : '等待接受邀请'}</td><td><select class="member-role"><option value="business_user" ${user.roles.includes('business_user') ? 'selected' : ''}>业务员</option><option value="finance" ${user.roles.includes('finance') ? 'selected' : ''}>财务</option><option value="admin" ${user.roles.includes('admin') ? 'selected' : ''}>管理员</option><option value="super_admin" ${user.roles.includes('super_admin') ? 'selected' : ''}>超级管理员</option></select></td><td><div class="admin-shop-list">${shopChecks(user.shopIds)}</div></td><td><button class="admin-save" data-save-user="${user.id}">保存授权</button>${!user.confirmed ? `<button class="admin-delete" data-delete-pending="${user.id}">删除未激活账号</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="5" class="admin-empty">暂未邀请成员</td></tr>';
    mount.innerHTML = `<section class="admin-card"><h3>店铺管理</h3><p>建立多国家站点店铺；业务员仅能查看获授权店铺的数据。</p><form id="createShopForm" class="admin-form"><label>店铺编码<input name="shopCode" required placeholder="例如 PH-001"/></label><label>店铺名称<input name="shopName" required placeholder="例如 PH 官方店"/></label><label>国家站点<input name="countryCode" required maxlength="2" placeholder="PH"/></label><label>结算币种<input name="currencyCode" required maxlength="3" placeholder="PHP"/></label><button>新增店铺</button></form><table class="admin-table"><thead><tr><th>编码</th><th>店铺</th><th>站点</th><th>币种</th><th>状态</th></tr></thead><tbody>${shops}</tbody></table></section><section class="admin-card"><h3>成员与店铺授权</h3><p>管理员创建成员账号后，通过公司内部方式发送邮箱与初始密码。成员可立即登录。</p>${message ? `<p class="admin-message">${message}</p>` : ''}<form id="inviteMemberForm" class="admin-form"><label>成员邮箱<input name="email" type="email" required placeholder="member@example.com"/></label><label>初始密码<input name="password" type="password" required minlength="8" placeholder="至少 8 位"/></label><label>初始角色<select name="role"><option value="business_user">业务员</option><option value="finance">财务</option><option value="admin">管理员</option></select></label><div class="admin-shop-list">${shopChecks()}</div><button>创建成员账号</button></form><table class="admin-table"><thead><tr><th>成员</th><th>状态</th><th>角色</th><th>可查看店铺</th><th></th></tr></thead><tbody>${users}</tbody></table></section>`;
    mount.querySelector('#createShopForm').addEventListener('submit', createShop);
    mount.querySelector('#inviteMemberForm').addEventListener('submit', inviteMember);
    mount.querySelectorAll('[data-save-user]').forEach(button => button.addEventListener('click', saveAccess));
    mount.querySelectorAll('[data-delete-pending]').forEach(button => button.addEventListener('click', deletePending));
  }
  async function load() { state = await api('/api/admin/data'); render(); }
  async function createShop(event) { event.preventDefault(); const form = new FormData(event.currentTarget); try { await api('/api/admin/shops', { method: 'POST', body: JSON.stringify(Object.fromEntries(form)) }); await load(); render('店铺已新增'); } catch (error) { render(`<span class="admin-error">${error.message}</span>`); } }
  async function inviteMember(event) { event.preventDefault(); const form = event.currentTarget; try { await api('/api/admin/members', { method: 'POST', body: JSON.stringify({ email: form.email.value, password: form.password.value, role: form.role.value, shopIds: [...form.querySelectorAll('input[type=checkbox]:checked')].map(input => input.value) }) }); await load(); render('成员账号已创建，请通过公司内部方式发送初始密码'); } catch (error) { render(`<span class="admin-error">${error.message}</span>`); } }
  async function saveAccess(event) { const row = event.currentTarget.closest('tr'); try { await api('/api/admin/members/access', { method: 'PUT', body: JSON.stringify({ userId: row.dataset.user, role: row.querySelector('.member-role').value, shopIds: [...row.querySelectorAll('input[type=checkbox]:checked')].map(input => input.value) }) }); await load(); render('成员权限已保存'); } catch (error) { render(`<span class="admin-error">${error.message}</span>`); } }
  async function deletePending(event) { const userId = event.currentTarget.dataset.deletePending; if (!window.confirm('确认删除这个未激活邀请账号？删除后无法恢复。')) return; try { await api('/api/admin/members/pending', { method: 'DELETE', body: JSON.stringify({ userId }) }); await load(); render('未激活邀请账号已删除'); } catch (error) { render(`<span class="admin-error">${error.message}</span>`); } }
  document.addEventListener('app:authenticated', event => { if (['admin', 'super_admin'].includes(event.detail.role)) load().catch(error => render(`<span class="admin-error">${error.message}</span>`)); });
})();
