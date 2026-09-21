(() => {
  const root = document.querySelector('#adminManagement');
  if (!root) return;
  const tasks = [
    { type: '成本缺失', count: '12', description: '菲律宾精选店有 12 个 SKU 尚未维护仓库代发成本', page: 'warehouses', tone: 'warning' },
    { type: '商品待审核', count: '8', description: '新增或导入的商品正在等待管理员确认', page: 'products', tone: 'info' },
    { type: '导入异常', count: '2', description: '订单或结算文件存在待核对的导入失败记录', page: 'orders', tone: 'danger' },
    { type: '待处理反馈', count: '5', description: '业务员提交的问题尚未给出处理结果', page: 'feedback', tone: 'purple' }
  ];
  const health = [
    { shop: '美国旗舰店', order: '导入正常', settlement: '导入正常', time: '2026-09-13 09:30', quality: '完整' },
    { shop: '菲律宾精选店', order: '导入正常', settlement: '等待导入', time: '2026-09-13 08:50', quality: '存在缺失' },
    { shop: '越南家居店', order: '待核对', settlement: '导入正常', time: '2026-09-12 22:10', quality: '待核对' }
  ];
  const recent = [
    ['10:45', '陈管理员', '审核', 'TKS-00021 / 便携收纳盒'],
    ['09:30', '王财务', '状态变更', 'PHP / CNY 结算汇率'],
    ['09:12', '系统', '导入', '订单导入批次 ORD-20260913-01'],
    ['昨日 16:18', '李管理员', '授权调整', '菲律宾精选店']
  ];
  function topbar() {
    document.querySelector('.admin-topbar .eyebrow').textContent = 'ADMIN CONSOLE';
    document.querySelector('#adminSuccess').textContent = '工作概览';
    let description = document.querySelector('#adminTopDescription');
    if (!description) { description = document.createElement('p'); description.id = 'adminTopDescription'; document.querySelector('#adminSuccess').after(description); }
    description.textContent = '集中查看经营状态、数据健康度与待处理事项；当前为前端示例数据。';
  }
  function render() {
    topbar();
    root.innerHTML = `<section class="overview-toolbar"><p>统计时间：2026-09-01 至 2026-09-13 · 全部店铺 · 示例数据</p><aside><button class="admin-pending" type="button">刷新概览</button><button class="admin-pending" type="button">导入数据</button></aside></section><section class="overview-kpis"><article><span>启用店铺</span><strong>3</strong><small>共 4 个已建店铺</small></article><article><span>有效订单</span><strong>2,486</strong><small class="overview-up">↑ 8.4% 较上期</small></article><article><span>本周期净利润</span><strong>$35,920.84</strong><small class="overview-up">↑ 16.2% 较上期</small></article><article><span>数据完整度</span><strong>92.4%</strong><small class="overview-warn">12 个 SKU 待补成本</small></article><article><span>待审核商品</span><strong>8</strong><small>新增或导入商品</small></article><article><span>待处理反馈</span><strong>5</strong><small>等待管理员回复</small></article></section><section class="overview-grid"><article class="overview-card overview-tasks"><div class="overview-head"><div><h3>待处理事项</h3><p>优先处理会影响利润准确性的问题</p></div><button data-overview-page="feedback">查看全部</button></div>${tasks.map(item => `<button class="overview-task ${item.tone}" data-overview-page="${item.page}"><strong>${item.count}</strong><div><span>${item.type}</span><small>${item.description}</small></div><b>›</b></button>`).join('')}</article><article class="overview-card overview-health"><div class="overview-head"><div><h3>数据导入状态</h3><p>订单与结算文件的最近处理情况</p></div><button data-overview-page="orders">查看订单与结算</button></div><table><thead><tr><th>店铺</th><th>订单</th><th>结算单</th><th>最近成功导入</th><th>健康度</th></tr></thead><tbody>${health.map(item => `<tr><td>${item.shop}</td><td><span class="overview-import ${item.order}">${item.order}</span></td><td><span class="overview-import ${item.settlement}">${item.settlement}</span></td><td>${item.time}</td><td><span class="overview-quality ${item.quality}">${item.quality}</span></td></tr>`).join('')}</tbody></table></article></section><section class="overview-grid overview-lower"><article class="overview-card overview-trend"><div class="overview-head"><div><h3>近期利润概况</h3><p>销售额与净利润趋势（示例）</p></div><button data-overview-page="profit">进入利润监控</button></div><svg viewBox="0 0 620 180" preserveAspectRatio="none" aria-label="近期利润概况图"><path d="M0 135 L70 120 L140 131 L210 76 L280 96 L350 61 L420 84 L490 38 L560 54 L620 19" fill="none" stroke="#2497c4" stroke-width="3"/><path d="M0 160 L70 148 L140 156 L210 123 L280 137 L350 105 L420 119 L490 82 L560 96 L620 65" fill="none" stroke="#35bc8d" stroke-width="3"/></svg><div><span>9/01</span><span>9/03</span><span>9/05</span><span>9/07</span><span>9/09</span><span>9/13</span></div></article><article class="overview-card overview-recent"><div class="overview-head"><div><h3>最近操作</h3><p>仅展示关键管理操作</p></div><button data-overview-page="logs">查看操作记录</button></div><div class="overview-recent-list">${recent.map(item => `<div><time>${item[0]}</time><span><strong>${item[1]} · ${item[2]}</strong><small>${item[3]}</small></span></div>`).join('')}</div></article></section><section class="overview-card overview-quick"><div class="overview-head"><div><h3>快捷入口</h3><p>后续按管理员权限开放对应操作</p></div></div><div>${[['导入订单数据','orders'],['导入结算单','orders'],['新增商品','products'],['新增店铺','shops'],['创建成员账号','users']].map(item => `<button class="admin-pending" data-overview-page="${item[1]}">${item[0]}<b>›</b></button>`).join('')}</div></section><p class="feedback-demo-note">视觉优先模式：概览数值、待办、数据状态和快捷入口均为前端示例，不读取或修改 Supabase 数据。</p>`;
    root.querySelectorAll('[data-overview-page]').forEach(button => button.onclick = () => document.querySelector(`[data-admin-page="${button.dataset.overviewPage}"]`)?.click());
  }
  document.addEventListener('admin:navigate', event => { if (event.detail.page === 'overview') render(); });
  render();
})();
