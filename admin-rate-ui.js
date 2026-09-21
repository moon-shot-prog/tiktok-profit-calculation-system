(() => {
  const root = document.querySelector('#adminManagement');
  if (!root) return;
  const dialog = document.createElement('dialog');
  dialog.className = 'rate-admin-dialog'; document.body.append(dialog);
  const bases = ['USD', 'THB', 'MYR', 'VND', 'PHP', 'IDR', 'CNY'];
  const quotes = ['CNY', 'USD'];
  const statusLabels = { active: '生效中', pending: '未生效', expired: '已失效', deactivated: '已作废' };
  let rates = []; let versions = []; let page = 1; let pageSize = 20;
  const session = () => { try { return JSON.parse(localStorage.getItem('tiktokShopAuthSession') || sessionStorage.getItem('tiktokShopAuthSession') || '{}'); } catch { return {}; } };
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const shortDate = value => value ? new Date(value).toLocaleDateString('zh-CN').replaceAll('/', '-') : '—';
  const dateTime = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
  const formatRate = value => value === null || value === undefined || value === '' ? '—' : Number(value).toFixed(6);
  const request = async (url, options = {}) => { const response = await fetch(url, { ...options, headers: { Authorization: `Bearer ${session().accessToken}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) } }); const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.message || '操作失败，请稍后重试'); return data; };
  function top() {
    document.querySelector('.admin-topbar .eyebrow').textContent = 'BASIC DATA';
    document.querySelector('#adminSuccess').textContent = '汇率管理';
    let description = document.querySelector('#adminTopDescription');
    if (!description) { description = document.createElement('p'); description.id = 'adminTopDescription'; document.querySelector('#adminSuccess').after(description); }
    description.textContent = '维护真实报表结算汇率与版本记录；作废记录会永久保留，避免影响历史利润追溯。';
    const stage = document.querySelector('.admin-stage');
    if (stage) stage.textContent = '真实数据模块 · 已连接数据库';
  }
  function message(text, type = 'info') { const box = document.querySelector('#rateLiveMessage'); box.textContent = text; box.dataset.type = type; box.hidden = false; }
  function filtered() { const base = document.querySelector('#rateBase')?.value || ''; const quote = document.querySelector('#rateQuote')?.value || ''; const status = document.querySelector('#rateStatus')?.value || ''; return rates.filter(item => (!base || item.base_currency === base) && (!quote || item.quote_currency === quote) && (!status || item.status === status)); }
  function draw() {
    const list = filtered(); const pages = Math.max(1, Math.ceil(list.length / pageSize)); page = Math.min(page, pages);
    const current = list.slice((page - 1) * pageSize, page * pageSize);
    document.querySelector('#rateRows').innerHTML = current.map(item => `<tr><td><strong>${item.base_currency} / ${item.quote_currency}</strong></td><td>${formatRate(item.settlement_rate)}</td><td>${shortDate(item.effective_date)}</td><td>${escapeHtml(item.note || '—')}</td><td>${dateTime(item.updated_at)}</td><td><span class="rate-status ${item.status}">${statusLabels[item.status] || item.status}</span></td><td><button data-rate-edit="${item.id}">修改</button>${item.is_active ? `<button data-rate-delete="${item.id}">作废</button>` : ''}<button data-rate-history="${item.id}">版本</button></td></tr>`).join('') || '<tr><td colspan="7" class="admin-empty">暂无真实结算汇率数据，请新增结算汇率。</td></tr>';
    document.querySelector('#ratePage').textContent = `${page} / ${pages}`; document.querySelector('#ratePrev').disabled = page <= 1; document.querySelector('#rateNext').disabled = page >= pages;
  }
  async function load() { message('正在读取真实结算汇率数据…'); const data = await request('/api/admin/settlement-rates'); rates = data.rates || []; versions = data.versions || []; message(`已读取 ${rates.length} 条真实结算汇率数据。`, 'success'); draw(); }
  function form(item) {
    const editing = Boolean(item);
    dialog.innerHTML = `<button class="dialog-close" type="button">×</button><h2>${editing ? '修改结算汇率' : '新增结算汇率'}</h2><p>同一基准货币、汇率货币和生效日期只能有一条记录。保存修改会自动写入版本记录。</p><form id="rateForm"><label>基准货币<select id="rateFormBase">${bases.map(value => `<option ${item?.base_currency === value ? 'selected' : ''}>${value}</option>`).join('')}</select></label><label>汇率货币<select id="rateFormQuote">${quotes.map(value => `<option ${item?.quote_currency === value || (!item && value === 'CNY') ? 'selected' : ''}>${value}</option>`).join('')}</select></label><label>结算汇率<input id="rateFormValue" type="number" step="0.00000001" min="0.00000001" value="${item?.settlement_rate ?? ''}" required /></label><label>生效日期<input id="rateFormDate" type="date" value="${item?.effective_date || ''}" required /></label><label class="rate-wide">备注<textarea id="rateFormNote" maxlength="500" placeholder="例如：9 月财务月度结算汇率">${escapeHtml(item?.note || '')}</textarea></label><button type="submit">${editing ? '保存修改' : '保存并新增'}</button></form><p id="rateFormMessage" class="rate-form-note" hidden></p>`;
    dialog.showModal(); dialog.querySelector('.dialog-close').onclick = () => dialog.close();
    dialog.querySelector('#rateForm').onsubmit = async event => { event.preventDefault(); const note = dialog.querySelector('#rateFormMessage'); note.hidden = false; note.textContent = '正在保存…'; const value = id => dialog.querySelector(`#${id}`).value; const payload = { baseCurrency: value('rateFormBase'), quoteCurrency: value('rateFormQuote'), settlementRate: value('rateFormValue'), effectiveDate: value('rateFormDate'), note: value('rateFormNote') }; if (editing) payload.rateId = item.id; try { await request(editing ? '/api/admin/settlement-rates/configuration' : '/api/admin/settlement-rates', { method: editing ? 'PUT' : 'POST', body: JSON.stringify(payload) }); dialog.close(); await load(); message(editing ? '结算汇率已保存，并已生成版本记录。' : '结算汇率已新增。', 'success'); } catch (error) { note.textContent = error.message; } };
  }
  function history(rateId) {
    const rows = versions.filter(item => !rateId || item.rate_id === rateId);
    dialog.innerHTML = `<button class="dialog-close" type="button">×</button><h2>结算汇率版本记录</h2><p>记录会永久保留原数值、新数值、操作时间和备注。</p><table><thead><tr><th>货币对</th><th>操作</th><th>原结算汇率</th><th>新结算汇率</th><th>更新时间</th><th>备注</th></tr></thead><tbody>${rows.map(row => { const before = row.previous_data || {}; const current = row.current_data || {}; return `<tr><td>${escapeHtml(`${current.base_currency || before.base_currency || '—'} / ${current.quote_currency || before.quote_currency || '—'}`)}</td><td>${({ created: '新增', updated: '修改', deactivated: '作废' })[row.action] || row.action}</td><td>${formatRate(before.settlement_rate)}</td><td>${formatRate(current.settlement_rate)}</td><td>${dateTime(row.created_at)}</td><td>${escapeHtml(current.note || before.note || '—')}</td></tr>`; }).join('') || '<tr><td colspan="6">暂无版本记录</td></tr>'}</tbody></table>`;
    dialog.showModal(); dialog.querySelector('.dialog-close').onclick = () => dialog.close();
  }
  async function deactivate(item) { if (!window.confirm(`确认作废 ${item.base_currency}/${item.quote_currency}（生效日期 ${item.effective_date}）吗？作废后会保留记录，不能恢复为删除。`)) return; try { await request('/api/admin/settlement-rates', { method: 'DELETE', body: JSON.stringify({ rateId: item.id }) }); await load(); message('结算汇率已作废，版本记录已保留。', 'success'); } catch (error) { message(error.message, 'error'); } }
  function render() {
    top();
    root.innerHTML = `<section class="rate-filters"><label>基准货币<select id="rateBase"><option value="">全部</option>${bases.map(value => `<option>${value}</option>`).join('')}</select></label><label>汇率货币<select id="rateQuote"><option value="">全部</option>${quotes.map(value => `<option>${value}</option>`).join('')}</select></label><label>状态<select id="rateStatus"><option value="">全部</option>${Object.entries(statusLabels).map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></label><div><button id="rateSearch" type="button">查询</button><button id="rateReset" type="button">重置</button></div><aside><button id="rateCreate" type="button">新增结算汇率</button><button id="rateVersion" type="button">结算汇率版本记录</button></aside></section><p id="rateLiveMessage" class="rate-live-message" hidden></p><section class="rate-table"><table><thead><tr><th>基准货币 / 汇率货币</th><th>结算汇率</th><th>生效日期</th><th>备注</th><th>更新时间</th><th>状态</th><th>操作</th></tr></thead><tbody id="rateRows"></tbody></table></section><div class="admin-pagination"><span id="rateTotal" class="admin-pagination-total"></span><label>每页 <select id="rateSize"><option value="20">20 条/页</option><option value="50">50 条/页</option><option value="100">100 条/页</option></select></label><div><button id="ratePrev">上一页</button><span id="ratePage">1 / 1</span><button id="rateNext">下一页</button></div></div><p class="feedback-demo-note">结算汇率已接入真实数据库；作废不会删除历史记录，版本记录由系统自动生成。</p>`;
    document.querySelector('#rateSearch').onclick = () => { page = 1; draw(); }; document.querySelector('#rateReset').onclick = () => { document.querySelectorAll('.rate-filters select').forEach(field => field.value = ''); page = 1; draw(); }; document.querySelector('#rateCreate').onclick = () => form(); document.querySelector('#rateVersion').onclick = () => history(); document.querySelector('#rateSize').onchange = event => { pageSize = Number(event.target.value); page = 1; draw(); }; document.querySelector('#ratePrev').onclick = () => { page--; draw(); }; document.querySelector('#rateNext').onclick = () => { page++; draw(); };
    root.onclick = event => { const id = event.target.dataset.rateEdit || event.target.dataset.rateDelete || event.target.dataset.rateHistory; if (!id) return; const item = rates.find(rate => rate.id === id); if (event.target.dataset.rateEdit) form(item); if (event.target.dataset.rateDelete) deactivate(item); if (event.target.dataset.rateHistory) history(item.id); };
    load().catch(error => message(error.message, 'error'));
  }
  document.addEventListener('admin:navigate', event => { if (event.detail.page === 'rates') render(); });
})();
