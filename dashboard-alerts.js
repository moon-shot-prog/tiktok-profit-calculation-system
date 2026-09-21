(() => {
  const card = document.querySelector('#dashboard .todo-card');
  if (!card) return;
  const heading = card.querySelector('.card-heading');
  const list = card.querySelector('.todo-list');
  heading.innerHTML = '<div><h2>检测预警</h2><p>数据检测与反馈处理功能正在完善</p></div><span class="alert-count">暂未开放</span>';
  list.innerHTML = '<div class="dashboard-alert-empty">暂未开放，开放后将展示同步、成本、结算与汇率异常。</div>';
})();
