(() => {
  const root = document.querySelector('#adminManagement');
  function mount() {
    const body = root?.querySelector('#feedbackRows'), card = root?.querySelector('.feedback-table-card');
    if (!body || !card) return;
    if (card.nextElementSibling?.classList.contains('admin-pagination')) { card.nextElementSibling._render?.(); return; }
    const pager = document.createElement('div'); pager.className = 'admin-pagination';
    pager.innerHTML = '<span class="admin-pagination-total"></span><label>每页 <select><option value="20">20 条/页</option><option value="50">50 条/页</option><option value="100">100 条/页</option></select></label><div><button type="button" data-page="previous">上一页</button><span class="admin-pagination-pages"></span><button type="button" data-page="next">下一页</button></div>';
    card.after(pager); let current = 1;
    const render = () => { const rows = [...body.querySelectorAll('tr')].filter(row => !row.querySelector('.admin-empty')), size = Number(pager.querySelector('select').value), pages = Math.max(1, Math.ceil(rows.length / size)); current = Math.min(current, pages); rows.forEach((row, index) => row.classList.toggle('is-hidden', index < (current - 1) * size || index >= current * size)); pager.querySelector('.admin-pagination-total').textContent = `共 ${rows.length} 条`; pager.querySelector('[data-page="previous"]').disabled = current === 1; pager.querySelector('[data-page="next"]').disabled = current === pages; pager.querySelector('.admin-pagination-pages').innerHTML = Array.from({ length: pages }, (_, index) => `<button type="button" class="${index + 1 === current ? 'active' : ''}" data-number="${index + 1}">${index + 1}</button>`).join(''); };
    pager._render = render; pager.addEventListener('click', event => { const page = event.target.dataset.page, number = event.target.dataset.number; if (page === 'previous') current--; if (page === 'next') current++; if (number) current = Number(number); render(); }); pager.querySelector('select').addEventListener('change', () => { current = 1; render(); }); render();
  }
  new MutationObserver(mutations => { if (mutations.some(mutation => mutation.target.id === 'adminManagement' || mutation.target.id === 'feedbackRows')) mount(); }).observe(root, { childList: true, subtree: true }); mount();
})();
