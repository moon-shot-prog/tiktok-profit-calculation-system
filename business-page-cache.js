(() => {
  const CACHE_TTL = 3 * 60 * 1000;
  const cacheablePaths = new Set([
    '/api/business/shops',
    '/api/business/products',
    '/api/business/warehouse-costs',
    '/api/business/settlement-rates'
  ]);
  const entries = new Map();
  const originalFetch = window.fetch.bind(window);

  const requestInfo = (input, init = {}) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request ? request.url : input, window.location.origin);
    const method = String(init.method || request?.method || 'GET').toUpperCase();
    const headers = new Headers(init.headers || request?.headers || {});
    return { url, method, headers };
  };
  const isRefresh = (url, init, headers) => init?.cache === 'reload' || headers.get('x-page-cache-refresh') === 'true' || url.searchParams.get('refresh') === 'true';
  const cacheKey = ({ url, headers }) => `${headers.get('authorization') || ''}:${url.pathname}${url.search}`;
  const rebuildResponse = entry => new Response(entry.body.slice(0), { status: entry.status, statusText: entry.statusText, headers: entry.headers });

  window.fetch = async (input, init = {}) => {
    const info = requestInfo(input, init);
    if (info.method !== 'GET' || !cacheablePaths.has(info.url.pathname) || !info.headers.get('authorization')) return originalFetch(input, init);
    const key = cacheKey(info), forceRefresh = isRefresh(info.url, init, info.headers), cached = entries.get(key);
    if (!forceRefresh && cached && Date.now() - cached.createdAt < CACHE_TTL) return rebuildResponse(cached);

    const response = await originalFetch(input, init);
    if (response.ok) {
      response.clone().arrayBuffer().then(body => {
        entries.set(key, { body, status: response.status, statusText: response.statusText, headers: [...response.headers.entries()], createdAt: Date.now() });
      }).catch(() => {});
    }
    return response;
  };

  window.businessPageCache = Object.freeze({
    ttl: CACHE_TTL,
    clear() { entries.clear(); },
    invalidate(pathname) { [...entries.keys()].forEach(key => { if (key.includes(`:${pathname}`)) entries.delete(key); }); }
  });
  document.querySelectorAll('.logout').forEach(button => button.addEventListener('click', () => entries.clear()));
})();
