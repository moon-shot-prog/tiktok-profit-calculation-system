// One shared in-memory catalogue for the visual-first management pages.
// It deliberately lives only in the browser and is replaced by API data later.
window.AdminVisualData = window.AdminVisualData || {
  createId(type) {
    const suffix = window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return `${type}_${suffix}`;
  },
  warehouses: [
    { id: 'w1', name: '跨境仓', cost: 12.8, previous: 12.1, currency: 'CNY', carriers: ['J&T Express', '4PX'], updated: '2026-09-10', unit: '每包裹', status: '启用' },
    { id: 'w2', name: '菲律宾本土', cost: 38.5, previous: 37.2, currency: 'PHP', carriers: ['J&T PH', 'Flash Express'], updated: '2026-09-09', unit: '每包裹', status: '启用' },
    { id: 'w3', name: '越南亚达', cost: 9.8, previous: 9.2, currency: 'CNY', carriers: ['GHN', 'GHTK'], updated: '2026-09-08', unit: '每单', status: '已停用' }
  ]
};
