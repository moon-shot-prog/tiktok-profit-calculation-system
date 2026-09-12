const http = require('http');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const localEnvPath = path.join(__dirname, '.env');
if (typeof process.loadEnvFile === 'function' && fs.existsSync(localEnvPath)) process.loadEnvFile(localEnvPath);

const PORT = process.env.PORT || 3000;
const REFRESH_INTERVAL = 3 * 60 * 60 * 1000;
const QUOTE_CURRENCIES = new Set(['CNY', 'USD']);
const BASES = ['THB', 'MYR', 'VND', 'PHP', 'IDR'];
const cache = new Map();
const inFlight = new Map();
const supabaseUrl = process.env.SUPABASE_URL;
const supabasePublishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
const authClient = supabaseUrl && supabasePublishableKey
  ? createClient(supabaseUrl, supabasePublishableKey, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;
const adminClient = supabaseUrl && process.env.SUPABASE_SECRET_KEY
  ? createClient(supabaseUrl, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;
const pairsFor = quote => [...BASES, quote === 'CNY' ? 'USD' : 'CNY'].map(base => [base, quote]);
const emptyCache = quote => ({ quoteCurrency: quote, updatedAt: null, nextRefreshAt: null, rates: [], source: 'Frankfurter v2 / ECB', status: '延迟' });

async function fetchRate(base, quote, date) {
  const datePart = date ? `?date=${date}&providers=ECB` : '?providers=ECB';
  const response = await fetch(`https://api.frankfurter.dev/v2/rate/${base}/${quote}${datePart}`);
  if (!response.ok) return null;
  return response.json();
}
async function refreshRates(quote) {
  if (inFlight.has(quote)) return inFlight.get(quote);
  const pending = (async () => {
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const rates = await Promise.all(pairsFor(quote).map(async ([base, target]) => {
      try {
        const current = await fetchRate(base, target);
        if (!current?.rate) return { pair: `${base}/${target}`, available: false };
        const previous = await fetchRate(base, target, yesterday);
        const change = previous?.rate ? ((current.rate - previous.rate) / previous.rate) * 100 : null;
        return { pair: `${base}/${target}`, available: true, rate: current.rate, previousRate: previous?.rate ?? null, change, rateDate: current.date };
      } catch { return { pair: `${base}/${target}`, available: false }; }
    }));
    const now = new Date();
    const valid = rates.some(rate => rate.available);
    const prior = cache.get(quote) || emptyCache(quote);
    const record = valid
      ? { quoteCurrency: quote, updatedAt: now.toISOString(), nextRefreshAt: new Date(now.getTime() + REFRESH_INTERVAL).toISOString(), rates, source: 'Frankfurter v2 / ECB', status: '实时' }
      : { ...prior, nextRefreshAt: new Date(now.getTime() + REFRESH_INTERVAL).toISOString(), status: prior.rates.length ? '延迟' : '刷新失败', error: 'Frankfurter v2 未返回可用汇率数据' };
    cache.set(quote, record);
    return record;
  })();
  inFlight.set(quote, pending);
  try { return await pending; } finally { inFlight.delete(quote); }
}
function sendJson(response, status, data) { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }); response.end(JSON.stringify(data)); }
function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', chunk => {
      body += chunk;
      if (body.length > 20_000) request.destroy();
    });
    request.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('请求格式无效')); }
    });
    request.on('error', reject);
  });
}
function getRoleEntry(roles) {
  const priority = ['super_admin', 'admin', 'finance', 'business_user'];
  return priority.find(role => roles.includes(role)) || null;
}
async function getAuthenticatedProfile(accessToken) {
  if (!authClient || !adminClient) throw new Error('服务端尚未配置 Supabase');
  const { data: userData, error: userError } = await authClient.auth.getUser(accessToken);
  if (userError || !userData.user) throw new Error('登录状态已失效');
  const [{ data: profile, error: profileError }, { data: roleRows, error: rolesError }] = await Promise.all([
    adminClient.from('profiles').select('id, display_name').eq('id', userData.user.id).single(),
    adminClient.from('user_roles').select('role').eq('user_id', userData.user.id)
  ]);
  if (profileError || rolesError) throw new Error('无法读取账号权限');
  const roles = roleRows.map(row => row.role);
  return { profile, roles, primaryRole: getRoleEntry(roles) };
}
async function handleLogin(request, response) {
  if (!authClient) return sendJson(response, 503, { message: 'Supabase 配置不完整，请检查 .env' });
  try {
    const { identity, password } = await readJson(request);
    const account = String(identity || '').trim();
    if (!account || !password) return sendJson(response, 400, { message: '请输入账号和密码' });
    const credentials = account.includes('@') ? { email: account, password } : { phone: account, password };
    const { data, error } = await authClient.auth.signInWithPassword(credentials);
    if (error || !data.session) {
      if (String(error?.message || '').toLowerCase().includes('fetch')) return sendJson(response, 503, { message: '暂时无法连接认证服务，请稍后重试' });
      return sendJson(response, 401, { message: '账号或密码不正确' });
    }
    const identityData = await getAuthenticatedProfile(data.session.access_token);
    if (!identityData.primaryRole) return sendJson(response, 403, { message: '该账号尚未分配系统角色，请联系管理员' });
    return sendJson(response, 200, {
      user: { id: data.user.id, email: data.user.email, phone: data.user.phone, displayName: identityData.profile.display_name || data.user.email || data.user.phone },
      roles: identityData.roles,
      primaryRole: identityData.primaryRole,
      session: { accessToken: data.session.access_token, refreshToken: data.session.refresh_token, expiresAt: data.session.expires_at }
    });
  } catch (error) {
    return sendJson(response, 400, { message: error.message || '登录请求失败' });
  }
}
async function handlePasswordReset(request, response) {
  if (!authClient) return sendJson(response, 503, { message: 'Supabase 配置不完整，请检查 .env' });
  try {
    const { identity, redirectTo } = await readJson(request);
    const email = String(identity || '').trim();
    if (!email.includes('@')) return sendJson(response, 400, { message: '首版仅支持已验证邮箱重置密码；手机号重置将在短信服务配置后开放' });
    const { error } = await authClient.auth.resetPasswordForEmail(email, { redirectTo: redirectTo || undefined });
    if (error) throw error;
    return sendJson(response, 200, { message: '若该邮箱已验证，重置链接已发送' });
  } catch (error) {
    return sendJson(response, 400, { message: error.message || '无法发送重置邮件' });
  }
}
async function handleSession(request, response) {
  if (!authClient) return sendJson(response, 503, { message: 'Supabase 配置不完整，请检查 .env' });
  try {
    const { accessToken } = await readJson(request);
    if (!accessToken) return sendJson(response, 401, { message: '登录状态已失效' });
    const { data: userData, error } = await authClient.auth.getUser(accessToken);
    if (error || !userData.user) return sendJson(response, 401, { message: '登录状态已失效' });
    const identityData = await getAuthenticatedProfile(accessToken);
    if (!identityData.primaryRole) return sendJson(response, 403, { message: '该账号尚未分配系统角色' });
    return sendJson(response, 200, {
      user: { id: userData.user.id, email: userData.user.email, phone: userData.user.phone, displayName: identityData.profile.display_name || userData.user.email || userData.user.phone },
      roles: identityData.roles,
      primaryRole: identityData.primaryRole
    });
  } catch (error) {
    return sendJson(response, 401, { message: '登录状态已失效' });
  }
}
function bearerToken(request) {
  const value = request.headers.authorization || '';
  return value.startsWith('Bearer ') ? value.slice(7) : null;
}
async function requireAdministrator(request) {
  const accessToken = bearerToken(request);
  if (!authClient || !adminClient || !accessToken) throw new Error('UNAUTHORIZED');
  const { data, error } = await authClient.auth.getUser(accessToken);
  if (error || !data.user) throw new Error('UNAUTHORIZED');
  const { data: roles, error: rolesError } = await adminClient.from('user_roles').select('role').eq('user_id', data.user.id);
  if (rolesError || !roles.some(row => row.role === 'admin' || row.role === 'super_admin')) throw new Error('FORBIDDEN');
  return data.user;
}
function adminError(response, error) {
  if (error.message === 'UNAUTHORIZED') return sendJson(response, 401, { message: '登录状态已失效，请重新登录' });
  if (error.message === 'FORBIDDEN') return sendJson(response, 403, { message: '只有管理员可以执行此操作' });
  return sendJson(response, 400, { message: error.message || '操作失败，请稍后重试' });
}
async function listAdminData(request, response) {
  try {
    await requireAdministrator(request);
    const [{ data: shops, error: shopsError }, { data: warehouses, error: warehousesError }, { data: profiles, error: profilesError }, { data: roles, error: rolesError }, { data: permissions, error: permissionsError }, usersResult] = await Promise.all([
      adminClient.from('shops').select('id, shop_code, shop_name, country_code, currency_code, is_active, created_at').order('created_at'),
      adminClient.from('warehouses').select('id, name, country_code, is_active').order('name'),
      adminClient.from('profiles').select('id, display_name, created_at'),
      adminClient.from('user_roles').select('user_id, role'),
      adminClient.from('user_shop_permissions').select('user_id, shop_id'),
      adminClient.auth.admin.listUsers({ page: 1, perPage: 200 })
    ]);
    if (shopsError || warehousesError || profilesError || rolesError || permissionsError || usersResult.error) throw new Error('读取管理数据失败');
    const profileById = new Map(profiles.map(profile => [profile.id, profile]));
    const users = usersResult.data.users.map(user => ({
      id: user.id,
      email: user.email,
      displayName: profileById.get(user.id)?.display_name || '',
      confirmed: Boolean(user.email_confirmed_at),
      roles: roles.filter(row => row.user_id === user.id).map(row => row.role),
      shopIds: permissions.filter(row => row.user_id === user.id).map(row => row.shop_id)
    }));
    sendJson(response, 200, { shops, warehouses, users });
  } catch (error) { adminError(response, error); }
}
async function createShop(request, response) {
  try {
    await requireAdministrator(request);
    const body = await readJson(request);
    const shopCode = String(body.shopCode || '').trim();
    const shopName = String(body.shopName || '').trim();
    const countryCode = String(body.countryCode || '').trim().toUpperCase();
    const currencyCode = String(body.currencyCode || '').trim().toUpperCase();
    if (!/^[A-Za-z0-9_-]{2,50}$/.test(shopCode) || !shopName || !/^[A-Z]{2}$/.test(countryCode) || !/^[A-Z]{3}$/.test(currencyCode)) throw new Error('请完整填写店铺编码、名称、国家站点和币种');
    const { data, error } = await adminClient.from('shops').insert({ shop_code: shopCode, shop_name: shopName, country_code: countryCode, currency_code: currencyCode }).select().single();
    if (error) throw new Error(error.code === '23505' ? '该店铺编码已存在' : '新增店铺失败');
    sendJson(response, 201, { shop: data });
  } catch (error) { adminError(response, error); }
}
async function createMember(request, response) {
  try {
    await requireAdministrator(request);
    const body = await readJson(request);
    const email = String(body.email || '').trim();
    const password = String(body.password || '');
    const role = String(body.role || 'business_user');
    const shopIds = Array.isArray(body.shopIds) ? body.shopIds.filter(value => typeof value === 'string') : [];
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('请输入有效的成员邮箱');
    if (password.length < 8) throw new Error('初始密码至少需要 8 位');
    if (!['business_user', 'finance', 'admin'].includes(role)) throw new Error('角色无效');
    const { data, error } = await adminClient.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !data.user) throw new Error(error?.message?.includes('already') ? '该邮箱已存在' : '创建成员失败');
    const userId = data.user.id;
    const [{ error: roleError }, permissionResult] = await Promise.all([
      adminClient.from('user_roles').insert({ user_id: userId, role }),
      shopIds.length ? adminClient.from('user_shop_permissions').insert(shopIds.map(shopId => ({ user_id: userId, shop_id: shopId }))) : Promise.resolve({ error: null })
    ]);
    if (roleError || permissionResult.error) throw new Error('账号已创建，但授权保存失败，请在成员列表重新设置授权');
    sendJson(response, 201, { message: '成员账号已创建，可以使用初始密码登录' });
  } catch (error) { adminError(response, error); }
}
async function updateMemberAccess(request, response) {
  try {
    const actor = await requireAdministrator(request);
    const body = await readJson(request);
    const userId = String(body.userId || '');
    const role = String(body.role || '');
    const shopIds = Array.isArray(body.shopIds) ? [...new Set(body.shopIds.filter(value => typeof value === 'string'))] : [];
    if (!userId || !['business_user', 'finance', 'admin', 'super_admin'].includes(role)) throw new Error('授权参数无效');
    if (userId === actor.id && role !== 'super_admin') throw new Error('不能降低当前超级管理员自身权限');
    const { error: deleteRolesError } = await adminClient.from('user_roles').delete().eq('user_id', userId);
    if (deleteRolesError) throw new Error('更新角色失败');
    const { error: insertRoleError } = await adminClient.from('user_roles').insert({ user_id: userId, role, assigned_by: actor.id });
    if (insertRoleError) throw new Error('更新角色失败');
    const { error: deletePermissionsError } = await adminClient.from('user_shop_permissions').delete().eq('user_id', userId);
    if (deletePermissionsError) throw new Error('更新店铺授权失败');
    if (shopIds.length) {
      const { error: insertPermissionsError } = await adminClient.from('user_shop_permissions').insert(shopIds.map(shopId => ({ user_id: userId, shop_id: shopId, granted_by: actor.id })));
      if (insertPermissionsError) throw new Error('更新店铺授权失败');
    }
    sendJson(response, 200, { message: '成员权限已更新' });
  } catch (error) { adminError(response, error); }
}
async function deletePendingMember(request, response) {
  try {
    const actor = await requireAdministrator(request);
    const { userId } = await readJson(request);
    if (!userId || userId === actor.id) throw new Error('不能删除当前登录管理员');
    const { data, error } = await adminClient.auth.admin.getUserById(userId);
    if (error || !data.user) throw new Error('未找到该成员账号');
    if (data.user.email_confirmed_at || data.user.phone_confirmed_at) throw new Error('仅可删除未激活邀请账号');
    const { error: deleteError } = await adminClient.auth.admin.deleteUser(userId);
    if (deleteError) throw new Error('删除未激活邀请账号失败');
    sendJson(response, 200, { message: '未激活邀请账号已删除' });
  } catch (error) { adminError(response, error); }
}
function serveFile(request, response) {
  const requested = request.url === '/' ? 'index.html' : decodeURIComponent(request.url.split('?')[0]).replace(/^\//, '');
  const filePath = path.join(__dirname, requested);
  if (!filePath.startsWith(__dirname) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) { response.writeHead(404); return response.end('Not found'); }
  const type = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8' }[path.extname(filePath)] || 'application/octet-stream';
  response.writeHead(200, { 'Content-Type': type }); fs.createReadStream(filePath).pipe(response);
}
http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname === '/api/auth/login' && request.method === 'POST') return handleLogin(request, response);
  if (url.pathname === '/api/auth/password-reset' && request.method === 'POST') return handlePasswordReset(request, response);
  if (url.pathname === '/api/auth/session' && request.method === 'POST') return handleSession(request, response);
  if (url.pathname === '/api/admin/data' && request.method === 'GET') return listAdminData(request, response);
  if (url.pathname === '/api/admin/shops' && request.method === 'POST') return createShop(request, response);
  if (url.pathname === '/api/admin/members' && request.method === 'POST') return createMember(request, response);
  if (url.pathname === '/api/admin/members/access' && request.method === 'PUT') return updateMemberAccess(request, response);
  if (url.pathname === '/api/admin/members/pending' && request.method === 'DELETE') return deletePendingMember(request, response);
  if (url.pathname === '/api/health' && request.method === 'GET') return sendJson(response, 200, { status: 'ok', supabaseConfigured: Boolean(authClient && adminClient) });
  if (url.pathname === '/api/reference-rates') {
    const quote = url.searchParams.get('currency') || 'CNY';
    if (!QUOTE_CURRENCIES.has(quote)) return sendJson(response, 400, { message: '仅支持 CNY 或 USD' });
    const current = cache.get(quote);
    const data = !current || !current.nextRefreshAt || new Date(current.nextRefreshAt) <= new Date() || request.method === 'POST' ? await refreshRates(quote) : current;
    return sendJson(response, 200, data);
  }
  serveFile(request, response);
}).listen(PORT, '0.0.0.0', () => console.log(`TikTok Profit System: http://localhost:${PORT}`));
