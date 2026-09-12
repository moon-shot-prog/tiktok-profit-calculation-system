(() => {
  const applyQuality = () => {
    const quality = window.profitDataQuality;
    if (!quality) return;
    const updateRows = (selector, statusIndex) => document.querySelectorAll(selector).forEach(row => {
      const shop = row.cells?.[0]?.textContent.trim();
      const issues = quality.getStoreIssues(shop);
      if (!issues.length || !row.cells?.[statusIndex]) return;
      const status = issues.includes('订单同步缺失') ? '不可计算' : '部分缺失';
      row.cells[statusIndex].innerHTML = `<span class="completion ${status === '不可计算' ? 'none' : 'partial'}">${status}</span>`;
      row.dataset.qualityIssues = issues.join('、');
    });
    updateRows('#summaryStoresBody tr', 5);
    updateRows('#summaryDetailBody tr', 10);
    const alerts = document.querySelector('#summaryAlerts');
    if (alerts) {
      const entries = ['US Fashion Store', 'PH Lifestyle Store'].map(shop => ({ shop, issues: quality.getStoreIssues(shop) })).filter(item => item.issues.length);
      if (entries.length) alerts.innerHTML = entries.map(item => `<a href="#orders"><span class="alert-icon warn">!</span><div><b>${item.shop}：利润数据待核对</b><p>${item.issues.join('、')}；相关订单已标记，补齐后会重新纳入汇总。</p></div></a>`).join('');
    }
  };
  document.addEventListener('sales:navigate', event => { if (event.detail?.route === '#summary') queueMicrotask(applyQuality); });
  document.addEventListener('data-quality:change', applyQuality);
  applyQuality();
})();
