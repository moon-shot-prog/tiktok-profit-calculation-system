(() => {
  function enhance() {
    const select = document.querySelector('#costCarriers');
    if (!select || select.dataset.enhanced) return;
    select.dataset.enhanced = 'true';
    const host = select.closest('label');
    const selected = () => [...select.selectedOptions].map(option => option.value);
    const box = document.createElement('div'); box.className = 'carrier-multiselect';
    box.innerHTML = `<button type="button" class="carrier-trigger">${selected().length ? `已选 ${selected().length} 个物流商` : '请选择物流商'} <b>⌄</b></button><div class="carrier-menu is-hidden">${[...select.options].map(option => `<label><input type="checkbox" value="${option.value}" ${option.selected ? 'checked' : ''} />${option.value}</label>`).join('')}</div>`;
    select.hidden = true; select.after(box);
    const trigger = box.querySelector('.carrier-trigger'), menu = box.querySelector('.carrier-menu');
    const sync = () => { const values = [...menu.querySelectorAll('input:checked')].map(input => input.value); [...select.options].forEach(option => option.selected = values.includes(option.value)); trigger.firstChild.textContent = values.length ? `已选 ${values.length} 个物流商 ` : '请选择物流商 '; };
    trigger.addEventListener('click', event => { event.stopPropagation(); menu.classList.toggle('is-hidden'); });
    menu.addEventListener('change', sync);
    document.addEventListener('click', event => { if (!host.contains(event.target)) menu.classList.add('is-hidden'); });
  }
  new MutationObserver(enhance).observe(document.body, { childList: true, subtree: true }); enhance();
})();
