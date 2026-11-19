const http = require('http');
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { localDatabaseEnabled, localQuery, withLocalTransaction } = require('./local-db');
const { localLogin, localSession, passwordHash } = require('./local-auth');

const localRuntimeEnvPath = path.join(__dirname, '.env.local');
if (typeof process.loadEnvFile === 'function' && fs.existsSync(localRuntimeEnvPath)) process.loadEnvFile(localRuntimeEnvPath);

const PORT = process.env.PORT || 3000;
// Visual-first stage: keep authentication available, but block every management
// mutation until the user explicitly enables real back-office integration.
const VISUAL_MODE = process.env.VISUAL_MODE !== 'false';
const REFRESH_INTERVAL = 3 * 60 * 60 * 1000;
const QUOTE_CURRENCIES = new Set(['CNY', 'USD']);
const BASES = ['THB', 'MYR', 'VND', 'PHP', 'IDR'];
const SETTLEMENT_RATE_BASES = new Set([...BASES, 'USD', 'CNY']);
const cache = new Map();
const inFlight = new Map();
const dashboardOverviewCache = new Map();
const dashboardAlertsCache = new Map();
const DASHBOARD_OVERVIEW_CACHE_TTL = 3 * 60 * 1000;
const DASHBOARD_ALERTS_CACHE_TTL = 60 * 1000;
// A bill import remains one logical, reversible file batch.  Database writes
// are deliberately split into small chunks so files larger than the old 5,000
// row display threshold are fully processed instead of being silently cut off.
const BILL_IMPORT_WRITE_BATCH_SIZE = 200;
const BILL_ROLLBACK_RETENTION_DAYS = 30;
const BILL_DETAIL_BREAKDOWN_FIELDS = [
  '享受商家折扣后小计', '享受折扣前小计', '商家折扣', '享受商家折扣后的退款小计', '享受商家折扣前的退款小计', '商家折扣退款',
  '交易手续费', 'TikTok Shop 佣金费', '商家运费', '实际运费', '平台运费减免', '买家支付运费', '实际退货运费', '客户运费退款', '运费补贴',
  '物流服务费', '联盟佣金', '联盟服务商佣金', '联盟店铺广告佣金', '联盟佣金保证金', '联盟佣金退款', '联盟服务商店铺广告佣金', 'SFP 服务费',
  '增值税', '奖金返现服务费', '直播特别活动服务费', '超级优惠券服务费', '订单处理手续费', 'EAMS 计划服务费', '秒杀服务费',
  'TikTok Shop 预扣的个人所得税', 'TikTok PayLater 计划费用', '活动资源费', 'GMV Max 优惠券', 'GMV Max 优惠券销售税',
  '托管服务计划（销售税）', '托管服务计划（每单费用）', 'GMV Max 广告费', '调整金额'
];
const BILL_NON_FEE_FIELD_NAMES = new Set([
  '交易类型', 'transaction type', '订单id/调整单id', '订单 id/调整单 id', 'order id/adjustment id', 'sku id',
  '货币', 'currency', '结算单 id', 'settlement statement id', '结算日期', 'settlement date',
  '交易创建日期', 'transaction creation date', '预计结算时间', 'estimated settlement time', '未结算原因', 'unsettled reason',
  '结算总金额', 'settlement total amount', '预计结算金额', 'estimated settlement amount', '总收入', 'total revenue', '总费用', 'total fees',
  '相关订单 id', 'related order id', '商品名称', 'product name', 'sku 名称', 'sku name', '数量', 'quantity'
]);
// Order exports may retain many source columns. Keep normal API requests small,
// but allow a validated order-import preview to carry a larger CSV payload.
// A TikTok CSV can contain multiple SKU rows per order.  Keep the row and
// JSON limits aligned so a legitimate 50,000-row range export is accepted.
const ORDER_IMPORT_MAX_ROWS = 50000;
const ORDER_IMPORT_MAX_PAYLOAD_BYTES = 96 * 1024 * 1024;
if (!localDatabaseEnabled()) throw new Error('未配置本机 PostgreSQL。请检查 .env.local 中的 DATABASE_URL。');
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
function sendJson(response, status, data) { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store, max-age=0' }); response.end(JSON.stringify(data)); }
function rollbackExpiry() { return new Date(Date.now() + BILL_ROLLBACK_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString(); }
async function purgeExpiredImportRollbackSnapshots() {
  return withLocalTransaction(async ({ query }) => {
    const expired = (await query(`select id, import_type from public.order_import_batches where import_type = any($1::text[]) and rollback_expires_at < now() and validation_status = 'completed'`, [['orders', 'settled_bills', 'unsettled_bills']])).rows;
    const billIds = expired.filter(item => item.import_type !== 'orders').map(item => item.id);
    const orderIds = expired.filter(item => item.import_type === 'orders').map(item => item.id);
    let total = 0;
    if (billIds.length) total += (await query('delete from public.tiktok_bill_import_changes where batch_id = any($1::uuid[])', [billIds])).rowCount || 0;
    if (orderIds.length) total += (await query('delete from public.order_import_changes where batch_id = any($1::uuid[])', [orderIds])).rowCount || 0;
    return total;
  });
}
function readJson(request, maxBytes = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = ''; let tooLarge = false;
    request.on('data', chunk => {
      if (tooLarge) return;
      body += chunk;
      if (body.length > maxBytes) {
        tooLarge = true;
        reject(new Error(`导入文件解析后超过 ${Math.floor(maxBytes / 1024 / 1024)}MB，请拆分 CSV 后重试`));
        request.resume();
      }
    });
    request.on('end', () => {
      if (tooLarge) return;
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
  const user = await localSession(accessToken);
  if (!user) throw new Error('登录状态已失效');
  const roles = user.roles || [];
  return { profile: { id: user.id, display_name: user.displayName, is_active: true }, roles, primaryRole: getRoleEntry(roles), user };
}
async function handleLogin(request, response) {
  try {
    const { identity, password } = await readJson(request);
    const account = String(identity || '').trim();
    if (!account || !password) return sendJson(response, 400, { message: '请输入账号和密码' });
    const data = await localLogin(account, password);
    if (!data) return sendJson(response, 401, { message: '账号或密码不正确' });
    const primaryRole = getRoleEntry(data.roles);
    if (!primaryRole) return sendJson(response, 403, { message: '该账号尚未分配系统角色，请联系管理员' });
    return sendJson(response, 200, { user: data.user, roles: data.roles, primaryRole, session: { accessToken: data.token, refreshToken: data.token, expiresAt: data.expiresAt } });
  } catch (error) {
    if (error.message === 'ACCOUNT_DISABLED') return sendJson(response, 403, { message: '该账号已被停用，请联系管理员' });
    return sendJson(response, 400, { message: error.message || '登录请求失败' });
  }
}
async function handlePasswordReset(request, response) {
  return sendJson(response, 501, { message: '本机模式不发送密码重置邮件，请联系管理员重置密码。' });
}
async function handlePasswordUpdate(request, response) {
  return sendJson(response, 501, { message: '本机模式请由管理员在成员管理中重置密码。' });
}
async function handleSession(request, response) {
  try {
    const { accessToken } = await readJson(request);
    if (!accessToken) return sendJson(response, 401, { message: '登录状态已失效' });
    const user = await localSession(accessToken);
    if (!user) return sendJson(response, 401, { message: '登录状态已失效' });
    const primaryRole = getRoleEntry(user.roles);
    if (!primaryRole) return sendJson(response, 403, { message: '该账号尚未分配系统角色' });
    return sendJson(response, 200, { user, roles: user.roles, primaryRole });
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
  if (!accessToken) throw new Error('UNAUTHORIZED');
  const user = await localSession(accessToken);
  if (!user) throw new Error('UNAUTHORIZED');
  if (!user.roles.some(role => role === 'admin' || role === 'super_admin')) throw new Error('FORBIDDEN');
  return user;
}
function adminError(response, error) {
  if (error.message === 'UNAUTHORIZED' || error.message === '登录状态已失效') return sendJson(response, 401, { message: '登录状态已失效，请重新登录' });
  if (error.message === 'ACCOUNT_DISABLED') return sendJson(response, 403, { message: '该账号已被停用，请联系管理员' });
  if (error.message === 'FORBIDDEN') return sendJson(response, 403, { message: '只有管理员可以执行此操作' });
  return sendJson(response, 400, { message: error.message || '操作失败，请稍后重试' });
}
async function writeAudit(actorId, entityType, entityId, action, beforeData, afterData) {
  try {
    await localQuery(
      `insert into public.audit_logs (actor_id, entity_type, entity_id, action, before_data, after_data)
       values ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
      [actorId || null, entityType, entityId || null, action, beforeData ? JSON.stringify(beforeData) : null, afterData ? JSON.stringify(afterData) : null]
    );
  } catch (error) {
    console.error('Local audit log write failed:', error.message);
  }
}
function normaliseIds(values) {
  return Array.isArray(values) ? [...new Set(values.filter(value => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value)))] : [];
}
function localIdentifier(value) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(String(value || ''))) throw new Error('本机数据库字段名无效');
  return value;
}
async function localUpsert(query, table, record, conflictColumns, immutableColumns = []) {
  const keys = Object.keys(record).map(localIdentifier);
  const conflicts = conflictColumns.map(localIdentifier);
  const immutable = new Set([...conflicts, ...immutableColumns].map(localIdentifier));
  const values = keys.map(key => record[key]);
  const placeholders = keys.map((_, index) => `$${index + 1}`).join(', ');
  const updates = keys.filter(key => !immutable.has(key)).map(key => `${key} = excluded.${key}`).join(', ');
  const sql = `insert into ${table} (${keys.join(', ')}) values (${placeholders}) on conflict (${conflicts.join(', ')}) do ${updates ? `update set ${updates}` : 'nothing'} returning *`;
  return (await query(sql, values)).rows[0] || null;
}
function normaliseImageUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
    return url.toString();
  } catch {
    throw new Error('商品图片链接必须以 http:// 或 https:// 开头');
  }
}
async function handleSessionRefresh(request, response) {
  try {
    const { refreshToken } = await readJson(request);
    if (!refreshToken || typeof refreshToken !== 'string') return sendJson(response, 401, { message: '登录状态已失效' });
    const user = await localSession(refreshToken);
    if (!user) return sendJson(response, 401, { message: '登录状态已失效' });
    const primaryRole = getRoleEntry(user.roles || []);
    if (!primaryRole) return sendJson(response, 403, { message: '该账号尚未分配系统角色' });
    return sendJson(response, 200, { user: { id: user.id, email: user.email, phone: user.phone, displayName: user.displayName }, roles: user.roles, primaryRole, session: { accessToken: refreshToken, refreshToken, expiresAt: Math.floor(Date.now() / 1000) + 12 * 60 * 60 } });
  } catch (error) {
    return sendJson(response, 401, { message: '登录状态已失效' });
  }
}
function settlementRatePayload(body) {
  const baseCurrency = String(body.baseCurrency || '').trim().toUpperCase();
  const quoteCurrency = String(body.quoteCurrency || '').trim().toUpperCase();
  const settlementRate = Number(body.settlementRate);
  const effectiveDate = String(body.effectiveDate || '').trim();
  const note = String(body.note || '').trim() || null;
  const allowed = SETTLEMENT_RATE_BASES.has(baseCurrency) && QUOTE_CURRENCIES.has(quoteCurrency) && baseCurrency !== quoteCurrency;
  if (!allowed || !Number.isFinite(settlementRate) || settlementRate <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate) || note?.length > 500) throw new Error('请填写有效的基准货币、汇率货币、正数结算汇率、生效日期和备注');
  return { baseCurrency, quoteCurrency, settlementRate, effectiveDate, note };
}
async function listSettlementRateManagementData(request, response) {
  try {
    await requireAdministrator(request);
    const [ratesResult, versionsResult] = await Promise.all([
      localQuery(`select id, base_currency, quote_currency, settlement_rate, effective_date, note, is_active, created_at, updated_at from public.settlement_exchange_rates order by effective_date desc, updated_at desc`),
      localQuery(`select id, rate_id, action, previous_data, current_data, created_at from public.settlement_exchange_rate_versions order by created_at desc limit 300`)
    ]);
    const rates = ratesResult.rows, versions = versionsResult.rows;
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
    const activeByPair = new Map();
    rates.filter(rate => rate.is_active && rate.effective_date <= today).forEach(rate => {
      const key = `${rate.base_currency}/${rate.quote_currency}`;
      const current = activeByPair.get(key);
      if (!current || rate.effective_date > current.effective_date) activeByPair.set(key, rate);
    });
    const enriched = rates.map(rate => {
      const current = activeByPair.get(`${rate.base_currency}/${rate.quote_currency}`);
      const status = !rate.is_active ? 'deactivated' : rate.effective_date > today ? 'pending' : current?.id === rate.id ? 'active' : 'expired';
      return { ...rate, status };
    });
    return sendJson(response, 200, { rates: enriched, versions, today });
  } catch (error) { adminError(response, error); }
}
async function createSettlementRate(request, response) {
  try {
    const actor = await requireAdministrator(request);
    const payload = settlementRatePayload(await readJson(request));
    const data = await withLocalTransaction(async ({ query }) => {
      let rate;
      try { rate = (await query(`insert into public.settlement_exchange_rates (base_currency,quote_currency,settlement_rate,effective_date,note,created_by,updated_by) values ($1,$2,$3,$4,$5,$6,$6) returning *`, [payload.baseCurrency, payload.quoteCurrency, payload.settlementRate, payload.effectiveDate, payload.note, actor.id])).rows[0]; }
      catch (error) { if (error.code === '23505') throw new Error('同一货币对与生效日期已经存在结算汇率'); throw error; }
      await query(`insert into public.audit_logs (actor_id,entity_type,entity_id,action,before_data,after_data) values ($1,'settlement_exchange_rate',$2,'create',null,$3::jsonb)`, [actor.id, rate.id, JSON.stringify(rate)]);
      return rate;
    });
    return sendJson(response, 201, { rate: data });
  } catch (error) { adminError(response, error); }
}
async function updateSettlementRate(request, response) {
  try {
    const actor = await requireAdministrator(request);
    const body = await readJson(request);
    const rateId = String(body.rateId || '');
    if (!/^[0-9a-f-]{36}$/i.test(rateId)) throw new Error('结算汇率参数无效');
    const payload = settlementRatePayload(body);
    const before = (await localQuery(`select * from public.settlement_exchange_rates where id=$1`, [rateId])).rows[0]; if (!before) throw new Error('未找到该结算汇率');
    const effectiveDateChanged = String(before.effective_date).slice(0, 10) !== payload.effectiveDate;
    const result = await withLocalTransaction(async ({ query }) => {
      let rate;
      try {
        if (effectiveDateChanged) {
          // 生效日是计算口径的一部分。新日期必须保留为新记录，不能覆盖旧日期，
          // 否则旧订单会在下次重算时错误地套用新汇率。
          rate = (await query(`insert into public.settlement_exchange_rates (base_currency,quote_currency,settlement_rate,effective_date,note,created_by,updated_by) values ($1,$2,$3,$4,$5,$6,$6) returning *`, [payload.baseCurrency, payload.quoteCurrency, payload.settlementRate, payload.effectiveDate, payload.note, actor.id])).rows[0];
          await query(`insert into public.audit_logs (actor_id,entity_type,entity_id,action,before_data,after_data) values ($1,'settlement_exchange_rate',$2,'create_effective_version',$3::jsonb,$4::jsonb)`, [actor.id, rate.id, JSON.stringify(before), JSON.stringify({ ...rate, previous_rate_id: before.id })]);
          return { rate, versionCreated: true };
        }
        rate = (await query(`update public.settlement_exchange_rates set base_currency=$1,quote_currency=$2,settlement_rate=$3,note=$4,updated_by=$5 where id=$6 returning *`, [payload.baseCurrency, payload.quoteCurrency, payload.settlementRate, payload.note, actor.id, rateId])).rows[0];
      } catch (error) { if (error.code === '23505') throw new Error('同一货币对与生效日期已经存在结算汇率'); throw error; }
      await query(`insert into public.audit_logs (actor_id,entity_type,entity_id,action,before_data,after_data) values ($1,'settlement_exchange_rate',$2,'update',$3::jsonb,$4::jsonb)`, [actor.id, rateId, JSON.stringify(before), JSON.stringify(rate)]);
      return { rate, versionCreated: false };
    });
    dashboardOverviewCache.clear();
    return sendJson(response, 200, { rate: result.rate, versionCreated: result.versionCreated, message: result.versionCreated ? '已保留原汇率，并新增一条按新生效日期计算的历史版本' : '结算汇率已更新' });
  } catch (error) { adminError(response, error); }
}
async function deactivateSettlementRate(request, response) {
  try {
    const actor = await requireAdministrator(request);
    const { rateId } = await readJson(request);
    if (!/^[0-9a-f-]{36}$/i.test(String(rateId || ''))) throw new Error('结算汇率参数无效');
    const before = (await localQuery(`select * from public.settlement_exchange_rates where id=$1`, [rateId])).rows[0]; if (!before) throw new Error('未找到该结算汇率');
    if (!before.is_active) return sendJson(response, 200, { message: '该结算汇率已作废' });
    const data = await withLocalTransaction(async ({ query }) => {
      const rate = (await query(`update public.settlement_exchange_rates set is_active=false,updated_by=$1 where id=$2 returning *`, [actor.id, rateId])).rows[0];
      await query(`insert into public.audit_logs (actor_id,entity_type,entity_id,action,before_data,after_data) values ($1,'settlement_exchange_rate',$2,'deactivate',$3::jsonb,$4::jsonb)`, [actor.id, rateId, JSON.stringify(before), JSON.stringify(rate)]);
      return rate;
    });
    return sendJson(response, 200, { rate: data });
  } catch (error) { adminError(response, error); }
}
async function listAdminData(request, response) {
  try {
    await requireAdministrator(request);
    const [shops, warehouses, shopWarehouses, profiles, roles, permissions, users] = await Promise.all([
      localQuery(`select id,shop_code,shop_name,country_code,currency_code,is_active,created_at from public.shops order by created_at`),
      localQuery(`select id,name,country_code,is_active from public.warehouses order by name`), localQuery(`select shop_id,warehouse_id from public.shop_warehouses`),
      localQuery(`select id,display_name,created_at from public.profiles`), localQuery(`select user_id,role from public.user_roles`), localQuery(`select user_id,shop_id from public.user_shop_permissions`),
      localQuery(`select id,email from auth.users`)
    ]);
    const profileById = new Map(profiles.rows.map(profile => [profile.id, profile]));
    return sendJson(response, 200, { shops: shops.rows, warehouses: warehouses.rows, shopWarehouses: shopWarehouses.rows, users: users.rows.map(user => ({ id:user.id,email:user.email,displayName:profileById.get(user.id)?.display_name || '',confirmed:true,roles:roles.rows.filter(row=>row.user_id===user.id).map(row=>row.role),shopIds:permissions.rows.filter(row=>row.user_id===user.id).map(row=>row.shop_id) })) });
  } catch (error) { adminError(response, error); }
}
async function createShop(request, response) {
  try {
    const actor = await requireAdministrator(request);
    const body = await readJson(request);
    const shopCode = String(body.shopCode || '').trim();
    const shopName = String(body.shopName || '').trim();
    const countryCode = String(body.countryCode || '').trim().toUpperCase();
    const currencyCode = String(body.currencyCode || '').trim().toUpperCase();
    const warehouseIds = normaliseIds(body.warehouseIds);
    const isActive = body.isActive !== false;
    if (!/^[\p{L}\p{N}_-]{2,50}$/u.test(shopCode)) throw new Error('店铺编码需为 2–50 个中文、英文、数字、下划线或短横线，且不能包含空格');
    if (!shopName || !/^[A-Z]{2}$/.test(countryCode) || !/^[A-Z]{3}$/.test(currencyCode)) throw new Error('请完整填写店铺名称、国家站点和币种');
    const data = await withLocalTransaction(async ({ query }) => {
        if (warehouseIds.length) { const valid=(await query(`select id from public.warehouses where is_active=true and id=any($1::uuid[])`,[warehouseIds])).rows; if(valid.length!==warehouseIds.length) throw new Error('存在无效或已停用的仓库，请刷新后重试'); }
        let shop; try { shop=(await query(`insert into public.shops (shop_code,shop_name,country_code,currency_code,is_active) values ($1,$2,$3,$4,$5) returning *`,[shopCode,shopName,countryCode,currencyCode,isActive])).rows[0]; } catch(error) { if(error.code==='23505') throw new Error('该店铺编码已存在'); throw error; }
        for (const warehouseId of warehouseIds) await query(`insert into public.shop_warehouses (shop_id,warehouse_id) values ($1,$2)`,[shop.id,warehouseId]);
        await query(`insert into public.audit_logs (actor_id,entity_type,entity_id,action,before_data,after_data) values ($1,'shop',$2,'create',null,$3::jsonb)`,[actor.id,shop.id,JSON.stringify({...shop,warehouseIds})]); return shop;
    });
    return sendJson(response,201,{shop:data});
  } catch (error) { adminError(response, error); }
}
function normaliseCountryCodes(values, fallback) {
  const input = Array.isArray(values) ? values : [fallback];
  return [...new Set(input.map(value => String(value || '').trim().toUpperCase()).filter(value => /^[A-Z]{2}$/.test(value)))];
}
async function updateShop(request, response) {
  try {
    const actor = await requireAdministrator(request);
    const body = await readJson(request);
    const shopId = String(body.shopId || '');
    const shopCode = String(body.shopCode || '').trim();
    const shopName = String(body.shopName || '').trim();
    const countryCode = String(body.countryCode || '').trim().toUpperCase();
    const currencyCode = String(body.currencyCode || '').trim().toUpperCase();
    const warehouseIds = normaliseIds(body.warehouseIds);
    const isActive = body.isActive !== false;
    if (!/^[0-9a-f-]{36}$/i.test(shopId)) throw new Error('店铺参数无效');
    if (!/^[\p{L}\p{N}_-]{2,50}$/u.test(shopCode)) throw new Error('店铺编码需为 2–50 个中文、英文、数字、下划线或短横线，且不能包含空格');
    if (!shopName || !/^[A-Z]{2}$/.test(countryCode) || !/^[A-Z]{3}$/.test(currencyCode)) throw new Error('请完整填写店铺名称、国家站点和币种');
    await withLocalTransaction(async ({ query }) => {
        const before=(await query(`select id,shop_code,shop_name,country_code,currency_code,is_active from public.shops where id=$1 for update`,[shopId])).rows[0]; if(!before) throw new Error('未找到该店铺');
        if(warehouseIds.length){const valid=(await query(`select id from public.warehouses where is_active=true and id=any($1::uuid[])`,[warehouseIds])).rows;if(valid.length!==warehouseIds.length)throw new Error('存在无效或已停用的仓库，请刷新后重试');}
        try { await query(`update public.shops set shop_code=$1,shop_name=$2,country_code=$3,currency_code=$4,is_active=$5 where id=$6`,[shopCode,shopName,countryCode,currencyCode,isActive,shopId]); } catch(error) {if(error.code==='23505')throw new Error('该店铺编码已存在');throw error;}
        await query(`delete from public.shop_warehouses where shop_id=$1`,[shopId]); for(const warehouseId of warehouseIds)await query(`insert into public.shop_warehouses (shop_id,warehouse_id) values ($1,$2)`,[shopId,warehouseId]);
        await query(`insert into public.audit_logs (actor_id,entity_type,entity_id,action,before_data,after_data) values ($1,'shop',$2,'update_configuration',$3::jsonb,$4::jsonb)`,[actor.id,shopId,JSON.stringify(before),JSON.stringify({shopCode,shopName,countryCode,currencyCode,isActive,warehouseIds})]);
    });
    return sendJson(response,200,{message:'店铺配置已保存'});
  } catch (error) { adminError(response, error); }
}
async function listShopManagementData(request, response) {
  try {
    await requireAdministrator(request);
    const [shops, warehouses, shopWarehouses, syncedOrders] = await Promise.all([
      localQuery(`select id,shop_code,shop_name,country_code,currency_code,is_active,created_at,updated_at from public.shops order by shop_name`),
      localQuery(`select id,name,country_code,is_active from public.warehouses order by name`),
      localQuery(`select shop_id,warehouse_id from public.shop_warehouses`),
      // Business date, not the file upload timestamp: this reflects the latest
      // order date that the sync assistant successfully committed per shop.
      localQuery(`select shop_id, max(ordered_at::date)::text as latest_sync_date, max(synced_at) as latest_sync_at from public.orders where source_identifier like 'IMP-%' group by shop_id`)
    ]);
    const syncByShop = new Map(syncedOrders.rows.map(item => [item.shop_id, item]));
    const shopRows = shops.rows.map(shop => {
      const sync = syncByShop.get(shop.id);
      return { ...shop, order_sync_status: sync ? '已同步' : '等待导入', latest_sync_date: sync?.latest_sync_date || null, latest_sync_at: sync?.latest_sync_at || null };
    });
    return sendJson(response,200,{shops:shopRows,warehouses:warehouses.rows,shopWarehouses:shopWarehouses.rows});
  } catch (error) { adminError(response, error); }
}
function promotionPayload(body) {
  const shopId = String(body.shopId || ''), campaignName = String(body.campaignName || '店铺日推广费').trim(), promotionDate = String(body.promotionDate || ''), costAmount = Number(body.costAmount), skuCount = Number(body.skuCount || 0), orderCount = Number(body.orderCount || 0), revenueAmount = Number(body.revenueAmount || 0), currencyCode = String(body.currencyCode || '').trim().toUpperCase(), note = String(body.note || '').trim() || null;
  if (!/^[0-9a-f-]{36}$/i.test(shopId) || !campaignName || campaignName.length > 120 || !/^\d{4}-\d{2}-\d{2}$/.test(promotionDate) || !Number.isFinite(costAmount) || costAmount < 0 || !Number.isInteger(skuCount) || skuCount < 0 || !Number.isInteger(orderCount) || orderCount < 0 || !Number.isFinite(revenueAmount) || revenueAmount < 0 || !/^[A-Z]{3}$/.test(currencyCode)) throw new Error('请完整填写店铺、日期、推广计划、成本、SKU 数、订单数、总收入和币种');
  return { shopId, campaignName, promotionDate, costAmount, skuCount, orderCount, revenueAmount, currencyCode, note };
}
function promotionAmount(value, label) {
  const normalized = String(value ?? '').replace(/,/g, '').replace(/^(?:CNY|VND|USD|PHP|IDR|THB|MYR)\s*/i, '').replace(/[¥￥$]/g, '').trim();
  const amount = Number(normalized);
  if (!Number.isFinite(amount) || amount < 0) throw new Error(`${label}必须是大于或等于 0 的数字`);
  return amount;
}
function promotionDate(value) {
  const source = String(value || '').trim().replace(/[/.]/g, '-');
  if (!/^\d{4}-\d{1,2}-\d{1,2}$/.test(source)) throw new Error('按天必须是 YYYY-MM-DD 格式');
  const [year, month, day] = source.split('-').map(Number), date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw new Error('按天不是有效日期');
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
function promotionSkuOrders(value) {
  const source = String(value || '').trim();
  if (!/^\d+$/.test(source)) throw new Error('SKU 订单数必须为整数');
  const count = Number(source);
  return { skuCount: count, orderCount: count };
}
async function parsePromotionImportRows(fileBase64, fileName) {
  const raw = String(fileBase64 || '').replace(/^data:[^,]+,/, '');
  if (!raw) return [];
  const isExcel = /\.xlsx$/i.test(String(fileName || ''));
  let matrix = [];
  if (isExcel) {
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(Buffer.from(raw, 'base64'));
    const sheet = workbook.worksheets[0]; if (!sheet) throw new Error('Excel 文件中没有工作表');
    sheet.eachRow({ includeEmpty: false }, row => matrix.push(row.values.slice(1).map(value => value instanceof Date ? value.toISOString().slice(0, 10) : String(value ?? '').trim())));
  } else {
    const bytes = Buffer.from(raw, 'base64'); let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { text = new TextDecoder('gbk').decode(bytes); }
    matrix = parseCsvRows(text);
  }
  if (matrix.length < 2) return [];
  const required = ['按天', '成本', 'SKU 订单数（当前店铺）', '平均下单成本（当前店铺）', '总收入（当前店铺）', '投资回报率 (ROI)（当前店铺）', '币种'];
  const headerRowIndex = matrix.findIndex(row => { const headers = row.map(value => String(value || '').replace(/^\uFEFF/, '').trim()); return required.every(field => headers.includes(field)); });
  if (headerRowIndex < 0) throw new Error(`缺少导入表头：${required.join('、')}`);
  const headers = matrix[headerRowIndex].map(value => String(value || '').replace(/^\uFEFF/, '').trim());
  return matrix.slice(headerRowIndex + 1).filter(row => row.some(value => String(value || '').trim())).map((row, index) => Object.assign({ _rowNumber: headerRowIndex + index + 2 }, Object.fromEntries(headers.map((header, column) => [header, String(row[column] ?? '').trim()]))));
}
function promotionImportRow(row, shop) {
  const day = promotionDate(row['按天']);
  const { skuCount, orderCount } = promotionSkuOrders(row['SKU 订单数（当前店铺）']);
  const currencyCode = String(row['币种'] || shop.currency_code || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currencyCode)) throw new Error('币种必须是三位货币代码');
  return { promotionDate: day, costAmount: promotionAmount(row['成本'], '成本'), skuCount, orderCount, revenueAmount: promotionAmount(row['总收入（当前店铺）'], '总收入'), currencyCode };
}
function promotionBatchPrefix() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)?.value).join('');
}
async function nextPromotionBatchCode() {
  const prefix = promotionBatchPrefix();
  const { rows } = await localQuery(
    `select batch_code from public.promotion_import_batches where batch_code like $1`,
    [`${prefix}-%`]
  );
  const sequence = rows.reduce((max, row) => Math.max(max, Number(String(row.batch_code).split('-')[1]) || 0), 0) + 1;
  return `${prefix}-${String(sequence).padStart(4, '0')}`;
}
async function importPromotionExpenses(request, response) {
  try {
    const actor = await requireAdministrator(request), body = await readJson(request), mode = body.mode === 'commit' ? 'commit' : 'preview';
    const shopId = String(body.shopId || ''), fileName = String(body.fileName || '店铺日推广费').slice(0, 200);
    if (!/^[0-9a-f-]{36}$/i.test(shopId)) throw new Error('请选择对应店铺');
    const localShop = localDatabaseEnabled()
      ? (await localQuery(`select id, shop_name, country_code, currency_code from public.shops where id = $1 and is_active = true`, [shopId])).rows[0]
      : null;
    const { data: remoteShop, error: shopError } = localDatabaseEnabled()
      ? { data: null, error: null }
      : await adminClient.from('shops').select('id, shop_name, country_code, currency_code').eq('id', shopId).eq('is_active', true).single();
    const shop = localShop || remoteShop;
    if (shopError || !shop) throw new Error('请选择启用中的店铺');
    const parsedRows = Array.isArray(body.rows) ? body.rows : await parsePromotionImportRows(body.fileBase64, fileName);
    if (!parsedRows.length) throw new Error('文件中没有可导入的推广费数据');
    if (parsedRows.length > 5000) throw new Error('单次最多导入 5,000 行，请拆分文件后重试');
    const rows = parsedRows;
    const validRows = [], failures = [], seenDays = new Set();
    rows.forEach(row => { try { const item = promotionImportRow(row, shop); if (seenDays.has(item.promotionDate)) throw new Error('文件内同一按天只能保留一条记录'); seenDays.add(item.promotionDate); validRows.push(item); } catch (error) { failures.push({ row: row._rowNumber || '?', reason: error.message || '数据无效' }); } });
    if (failures.length) return sendJson(response, 200, { valid: false, totalRows: rows.length, failures: failures.slice(0, 100), message: '校验未通过：请修正失败行后重新上传，系统未写入任何数据。' });
    const dates = validRows.map(item => item.promotionDate);
    const localExisting = localDatabaseEnabled()
      ? (await localQuery(`select id, promotion_date, created_by from public.promotion_expenses where shop_id = $1 and promotion_date = any($2::date[])`, [shop.id, dates])).rows
      : null;
    const { data: remoteExisting, error: existingError } = localDatabaseEnabled()
      ? { data: null, error: null }
      : await adminClient.from('promotion_expenses').select('id, promotion_date, created_by').eq('shop_id', shop.id).in('promotion_date', dates);
    const existing = localExisting || remoteExisting;
    if (existingError) throw new Error('读取已有店铺日推广费失败');
    const existingByDay = new Map((existing || []).map(item => [item.promotion_date, item]));
    const batchCode = await nextPromotionBatchCode();
    const preview = { valid: true, batchCode, shop: { id: shop.id, name: shop.shop_name, countryCode: shop.country_code }, totalRows: validRows.length, insertCount: validRows.filter(item => !existingByDay.has(item.promotionDate)).length, updateCount: validRows.filter(item => existingByDay.has(item.promotionDate)).length };
    if (mode === 'preview') return sendJson(response, 200, preview);
    let batch;
    if (localDatabaseEnabled()) {
      batch = await withLocalTransaction(async ({ query }) => {
        const created = await query(
          `insert into public.promotion_import_batches (batch_code, shop_id, file_name, total_rows, success_rows, updated_rows, skipped_rows, imported_by)
           values ($1, $2, $3, $4, 0, 0, 0, $5) returning *`,
          [batchCode, shop.id, fileName, validRows.length, actor.id]
        );
        const newBatch = created.rows[0];
        for (const item of validRows) {
          await query(
            `insert into public.promotion_expenses (shop_id, campaign_name, promotion_date, cost_amount, sku_count, order_count, revenue_amount, currency_code, import_batch_id, created_by, updated_by)
             values ($1, '店铺日推广费', $2, $3, $4, $5, $6, $7, $8, $9, $10)
             on conflict (shop_id, promotion_date) do update set campaign_name = excluded.campaign_name, cost_amount = excluded.cost_amount, sku_count = excluded.sku_count, order_count = excluded.order_count, revenue_amount = excluded.revenue_amount, currency_code = excluded.currency_code, import_batch_id = excluded.import_batch_id, updated_by = excluded.updated_by`,
            [shop.id, item.promotionDate, item.costAmount, item.skuCount, item.orderCount, item.revenueAmount, item.currencyCode, newBatch.id, existingByDay.get(item.promotionDate)?.created_by || actor.id, actor.id]
          );
        }
        await query(`update public.promotion_import_batches set success_rows = $1, updated_rows = $2 where id = $3`, [preview.insertCount + preview.updateCount, preview.updateCount, newBatch.id]);
        await query(
          `insert into public.audit_logs (actor_id, entity_type, entity_id, action, before_data, after_data) values ($1, 'promotion_import_batch', $2, 'commit_promotion_import', null, $3::jsonb)`,
          [actor.id, newBatch.id, JSON.stringify(preview)]
        );
        return newBatch;
      });
    } else {
      const { data, error: batchError } = await adminClient.from('promotion_import_batches').insert({ batch_code: batchCode, shop_id: shop.id, file_name: fileName, total_rows: validRows.length, success_rows: 0, updated_rows: 0, skipped_rows: 0, imported_by: actor.id }).select().single();
      if (batchError) throw new Error('创建推广费导入批次失败');
      batch = data;
      const payloads = validRows.map(item => ({ shop_id: shop.id, campaign_name: '店铺日推广费', promotion_date: item.promotionDate, cost_amount: item.costAmount, sku_count: item.skuCount, order_count: item.orderCount, revenue_amount: item.revenueAmount, currency_code: item.currencyCode, import_batch_id: batch.id, created_by: existingByDay.get(item.promotionDate)?.created_by || actor.id, updated_by: actor.id }));
      const { error: writeError } = await adminClient.from('promotion_expenses').upsert(payloads, { onConflict: 'shop_id,promotion_date' });
      if (writeError) throw new Error(`写入店铺日推广费失败：${writeError.message || '数据库错误'}`);
      const { error: completeError } = await adminClient.from('promotion_import_batches').update({ success_rows: preview.insertCount + preview.updateCount, updated_rows: preview.updateCount }).eq('id', batch.id);
      if (completeError) throw new Error('更新推广费导入批次失败');
    }
    await writeAudit(actor.id, 'promotion_import_batch', batch.id, 'commit_promotion_import', null, preview);
    dashboardOverviewCache.clear();
    sendJson(response, 200, { ...preview, batch, message: `导入完成：批次 ${batchCode}，新增 ${preview.insertCount} 条，更新 ${preview.updateCount} 条。` });
  } catch (error) { adminError(response, error); }
}
async function listPromotionExpenses(request, response) {
  try {
    await requireAdministrator(request);
    const requestUrl = new URL(request.url, `http://${request.headers.host}`);
    const reportCurrency = String(requestUrl.searchParams.get('currency') || 'USD').trim().toUpperCase();
    const rateType = String(requestUrl.searchParams.get('rateType') || 'settlement').trim();
    if (!QUOTE_CURRENCIES.has(reportCurrency)) throw new Error('报表币种仅支持 CNY 或 USD');
    if (!['settlement', 'reference'].includes(rateType)) throw new Error('汇率取值参数无效');
    if (localDatabaseEnabled()) {
      const [promotionsResult, shopsResult, ratesResult] = await Promise.all([
        // PostgreSQL 的 date 是“无时区日期”。显式转为文本，避免 Node 把它
        // 序列化成上一天的 UTC 时间而让浏览器显示少一天。
        localQuery(`select p.id, p.shop_id, p.campaign_name, p.promotion_date::text as promotion_date, p.cost_amount, p.sku_count, p.order_count, p.revenue_amount, p.currency_code, p.note, p.created_at, p.updated_at, json_build_object('shop_code', s.shop_code, 'shop_name', s.shop_name, 'country_code', s.country_code) as shops from public.promotion_expenses p join public.shops s on s.id = p.shop_id order by p.promotion_date desc, p.created_at desc`),
        localQuery(`select id, shop_code, shop_name, country_code, currency_code from public.shops where is_active = true order by shop_code, shop_name`),
        rateType === 'settlement' ? localQuery(`select base_currency, quote_currency, settlement_rate, effective_date from public.settlement_exchange_rates where is_active = true order by effective_date desc`) : Promise.resolve({ rows: [] })
      ]);
      const referenceRateData = rateType === 'reference' ? await refreshRates(reportCurrency) : null;
      const rateFor = (sourceCurrency, date) => sourceCurrency === reportCurrency ? 1 : rateType === 'reference'
        ? (referenceRateData?.rates?.find(item => item.pair === `${sourceCurrency}/${reportCurrency}` && item.available)?.rate || null)
        : (ratesResult.rows.find(item => item.base_currency === sourceCurrency && item.quote_currency === reportCurrency && item.effective_date <= date)?.settlement_rate || null);
      const promotions = promotionsResult.rows.map(item => { const rate = rateFor(String(item.currency_code || '').toUpperCase(), item.promotion_date); return rate === null ? { ...item, cost_amount: null, revenue_amount: null, currency_code: reportCurrency, conversion_missing: true } : { ...item, cost_amount: Number(item.cost_amount || 0) * Number(rate), revenue_amount: Number(item.revenue_amount || 0) * Number(rate), currency_code: reportCurrency, conversion_missing: false }; });
      return sendJson(response, 200, { promotions, shops: shopsResult.rows, currency: reportCurrency, rateType });
    }
    const [{ data: promotions, error: promotionsError }, { data: shops, error: shopsError }, settlementRates] = await Promise.all([
      adminClient.from('promotion_expenses').select('id, shop_id, campaign_name, promotion_date, cost_amount, sku_count, order_count, revenue_amount, currency_code, note, created_at, updated_at, shops!inner(shop_code, shop_name, country_code)').order('promotion_date', { ascending: false }).order('created_at', { ascending: false }),
      adminClient.from('shops').select('id, shop_code, shop_name, country_code, currency_code').eq('is_active', true).order('shop_code'),
      rateType === 'settlement'
        ? adminClient.from('settlement_exchange_rates').select('base_currency, quote_currency, settlement_rate, effective_date').eq('is_active', true).order('effective_date', { ascending: false })
        : Promise.resolve({ data: [], error: null })
    ]);
    if (promotionsError || shopsError || settlementRates.error) throw new Error('读取推广费用数据失败');
    const referenceRateData = rateType === 'reference' ? await refreshRates(reportCurrency) : null;
    const rateFor = (sourceCurrency, date) => {
      if (sourceCurrency === reportCurrency) return 1;
      if (rateType === 'reference') {
        const rate = referenceRateData?.rates?.find(item => item.pair === `${sourceCurrency}/${reportCurrency}` && item.available);
        return rate?.rate ? Number(rate.rate) : null;
      }
      const rate = (settlementRates.data || []).find(item => item.base_currency === sourceCurrency && item.quote_currency === reportCurrency && item.effective_date <= date);
      return rate?.settlement_rate ? Number(rate.settlement_rate) : null;
    };
    const convertedPromotions = (promotions || []).map(item => {
      const rate = rateFor(String(item.currency_code || '').toUpperCase(), item.promotion_date);
      if (rate === null) return { ...item, cost_amount: null, revenue_amount: null, currency_code: reportCurrency, conversion_missing: true };
      return { ...item, cost_amount: Number(item.cost_amount || 0) * rate, revenue_amount: Number(item.revenue_amount || 0) * rate, currency_code: reportCurrency, conversion_missing: false };
    });
    sendJson(response, 200, { promotions: convertedPromotions, shops: shops || [], currency: reportCurrency, rateType });
  } catch (error) { adminError(response, error); }
}
async function createPromotionExpense(request, response) {
  try {
    const actor = await requireAdministrator(request), payload = promotionPayload(await readJson(request));
    const shop = (await localQuery(`select id from public.shops where id = $1`, [payload.shopId])).rows[0]; if (!shop) throw new Error('所选店铺不存在');
    const record = { shop_id: payload.shopId, campaign_name: payload.campaignName, promotion_date: payload.promotionDate, cost_amount: payload.costAmount, sku_count: payload.skuCount, order_count: payload.orderCount, revenue_amount: payload.revenueAmount, currency_code: payload.currencyCode, note: payload.note, created_by: actor.id, updated_by: actor.id };
    const data = await withLocalTransaction(async ({ query }) => {
      const result = await query(`insert into public.promotion_expenses (shop_id, campaign_name, promotion_date, cost_amount, sku_count, order_count, revenue_amount, currency_code, note, created_by, updated_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`, Object.values(record));
      await query(`insert into public.audit_logs (actor_id, entity_type, entity_id, action, before_data, after_data) values ($1,'promotion_expense',$2,'create',null,$3::jsonb)`, [actor.id, result.rows[0].id, JSON.stringify(result.rows[0])]);
      return result.rows[0];
    });
    dashboardOverviewCache.clear(); return sendJson(response, 201, { promotion: data });
  } catch (error) { adminError(response, error); }
}
async function updatePromotionExpense(request, response) {
  try {
    const actor = await requireAdministrator(request), body = await readJson(request), id = String(body.id || ''), payload = promotionPayload(body); if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('推广费用参数无效');
    const before = (await localQuery(`select * from public.promotion_expenses where id = $1`, [id])).rows[0]; if (!before) throw new Error('未找到推广费用记录');
    const update = { shop_id: payload.shopId, campaign_name: payload.campaignName, promotion_date: payload.promotionDate, cost_amount: payload.costAmount, sku_count: payload.skuCount, order_count: payload.orderCount, revenue_amount: payload.revenueAmount, currency_code: payload.currencyCode, note: payload.note, updated_by: actor.id };
    const data = await withLocalTransaction(async ({ query }) => {
      const result = await query(`update public.promotion_expenses set shop_id=$1,campaign_name=$2,promotion_date=$3,cost_amount=$4,sku_count=$5,order_count=$6,revenue_amount=$7,currency_code=$8,note=$9,updated_by=$10 where id=$11 returning *`, [...Object.values(update), id]);
      await query(`insert into public.audit_logs (actor_id, entity_type, entity_id, action, before_data, after_data) values ($1,'promotion_expense',$2,'update',$3::jsonb,$4::jsonb)`, [actor.id, id, JSON.stringify(before), JSON.stringify(result.rows[0])]);
      return result.rows[0];
    });
    dashboardOverviewCache.clear(); return sendJson(response, 200, { promotion: data });
  } catch (error) { adminError(response, error); }
}
async function createWarehouse(request, response) {
  try {
    const actor = await requireAdministrator(request);
    const body = await readJson(request);
    const name = String(body.name || '').trim(); const originalWarehouseName = String(body.originalWarehouseName || '').trim() || null; const deliveryOption = String(body.deliveryOption || '').trim() || null; const shippingProviderName = String(body.shippingProviderName || '').trim() || null;
    const countryCode = String(body.countryCode || '').trim().toUpperCase() || null;
    const isActive = body.isActive !== false;
    const countryCodes = normaliseCountryCodes(body.countryCodes, countryCode);
    const amount = Number(body.amount);
    const billingUnit = body.billingUnit === '每包裹' ? 'per_package' : 'per_order';
    const effectiveDate = String(body.effectiveDate || '');
    const note = String(body.note || '').trim();
    if (!name || name.length > 80 || !Number.isFinite(amount) || amount < 0 || !/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) throw new Error('请填写有效的仓库名称、人民币代发费用和生效日期');
    const data = await withLocalTransaction(async ({ query }) => {
        let warehouse; try { warehouse=(await query(`insert into public.warehouses (name,original_warehouse_name,country_code,delivery_option,shipping_provider_name,is_active) values ($1,$2,$3,$4,$5,$6) returning *`,[name,originalWarehouseName,countryCode,deliveryOption,shippingProviderName,isActive])).rows[0]; } catch(error){if(error.code==='23505')throw new Error('该仓库名称已存在');throw error;}
        if(countryCodes.length){const valid=(await query(`select code from public.country_sites where code=any($1::text[])`,[countryCodes])).rows;if(valid.length!==countryCodes.length)throw new Error('存在无效国家站点，请刷新后重试');for(const code of countryCodes)await query(`insert into public.warehouse_country_sites (warehouse_id,country_code) values ($1,$2)`,[warehouse.id,code]);}
        await query(`insert into public.warehouse_cost_versions (warehouse_id,amount,currency_code,billing_unit,effective_date,note,created_by) values ($1,$2,'CNY',$3,$4,$5,$6)`,[warehouse.id,amount,billingUnit,effectiveDate,note,actor.id]);
        await query(`insert into public.audit_logs (actor_id,entity_type,entity_id,action,before_data,after_data) values ($1,'warehouse',$2,'create',null,$3::jsonb)`,[actor.id,warehouse.id,JSON.stringify({...warehouse,amount,currencyCode:'CNY',billingUnit,effectiveDate,note})]); return warehouse;
    });
    dashboardOverviewCache.clear(); return sendJson(response,201,{warehouse:data});
  } catch (error) { adminError(response, error); }
}
async function listWarehouseManagementData(request, response) {
  try {
    await requireAdministrator(request);
    const [warehouseResult,linkResult,shopResult,costResult,siteResult,warehouseSiteResult,orderResult] = await Promise.all([
      localQuery('select id,name,original_warehouse_name,country_code,delivery_option,shipping_provider_name,is_active,created_at,updated_at from public.warehouses order by name'),
      localQuery('select warehouse_id,shop_id from public.shop_warehouses'), localQuery('select id,shop_name,shop_code,is_active from public.shops order by shop_name'),
      localQuery('select id,warehouse_id,amount,currency_code,billing_unit,effective_date,note,created_at from public.warehouse_cost_versions order by effective_date desc,created_at desc'),
      localQuery('select code,name,default_currency from public.country_sites order by name'), localQuery('select warehouse_id,country_code from public.warehouse_country_sites'),
      localQuery(`select o.warehouse_name,o.delivery_option,o.logistics_carrier,json_build_object('name',w.name) as warehouses from public.orders o left join public.warehouses w on w.id=o.warehouse_id order by o.synced_at desc nulls last,o.id desc limit 2000`)
    ]);
    const warehouses=warehouseResult.rows, links=linkResult.rows, shops=shopResult.rows, costVersions=costResult.rows, countrySites=siteResult.rows, warehouseCountrySites=warehouseSiteResult.rows, orderWarehouseOptions=orderResult.rows;
    const mappingByName = new Map((orderWarehouseOptions || []).map(row => { const warehouseName = row.warehouse_name || row.warehouses?.name; return [warehouseName, { warehouseName, deliveryOptions: [], shippingProviders: [] }]; }).filter(([warehouseName]) => warehouseName));
    // 已保存的历史映射同样保留在候选项中，避免编辑时旧名称被无意移除。
    (warehouses || []).flatMap(warehouse => String(warehouse.original_warehouse_name || '').split(/[、,，]/).map(name => name.trim()).filter(Boolean)).forEach(warehouseName => { if (!mappingByName.has(warehouseName)) mappingByName.set(warehouseName, { warehouseName, deliveryOptions: [], shippingProviders: [] }); });
    (orderWarehouseOptions || []).forEach(row => { const warehouseName = row.warehouse_name || row.warehouses?.name; const mapping = mappingByName.get(warehouseName); if (!mapping) return; if (row.delivery_option && !mapping.deliveryOptions.includes(row.delivery_option)) mapping.deliveryOptions.push(row.delivery_option); if (row.logistics_carrier && !mapping.shippingProviders.includes(row.logistics_carrier)) mapping.shippingProviders.push(row.logistics_carrier); });
    const orderWarehouseMappings = [...mappingByName.values()].sort((left, right) => left.warehouseName.localeCompare(right.warehouseName, 'zh-CN'));
    sendJson(response, 200, { warehouses, links, shops, costVersions, countrySites, warehouseCountrySites, orderWarehouseMappings });
  } catch (error) { adminError(response, error); }
}
async function saveCountrySite(request, response) {
  try {
    await requireAdministrator(request);
    const body = await readJson(request);
    const name = String(body.name || '').trim(); const deliveryOption = String(body.deliveryOption || '').trim() || null; const shippingProviderName = String(body.shippingProviderName || '').trim() || null;
    const code = String(body.code || '').trim().toUpperCase();
    const currency = String(body.defaultCurrency || '').trim().toUpperCase();
    if (!name || name.length > 80 || !/^[A-Z]{2}$/.test(code) || !/^[A-Z]{3}$/.test(currency)) throw new Error('请填写有效的国家站点名称、两位代码和默认货币');
    let data;
    try { data=(await localQuery(`insert into public.country_sites (code,name,default_currency) values ($1,$2,$3) on conflict (code) do update set name=excluded.name,default_currency=excluded.default_currency returning code,name,default_currency`,[code,name,currency])).rows[0]; }
    catch(error) { if(error.code==='23505') throw new Error('该国家站点名称已存在'); throw error; }
    sendJson(response, 201, { countrySite: data });
  } catch (error) { adminError(response, error); }
}
async function listOrderSettlementManagementData(request, response) {
  try {
    await requireAdministrator(request);
    const { data: orders, error: ordersError, count: orderCount } = await adminClient.from('orders').select('id, order_number, order_status, order_substatus, refund_status, refund_amount, payment_amount, currency_code, tracking_number, logistics_carrier, delivery_option, warehouse_name, ordered_at, shipped_at, synced_at, source_identifier, raw_data, shops(shop_name, country_code), warehouses(name, original_warehouse_name)', { count: 'exact' }).order('ordered_at', { ascending: false }).limit(500);
    if (ordersError) throw new Error('读取订单与结算数据失败');
    const orderIds = (orders || []).map(order => order.id);
    const itemRequests = Array.from({ length: Math.ceil(orderIds.length / 50) }, (_, index) => orderIds.slice(index * 50, index * 50 + 50));
    const itemResults = [];
    for (const ids of itemRequests) itemResults.push(await adminClient.from('order_items').select('order_id, product_code, sku_id, product_name, quantity, allocated_payment, currency_code, sku_subtotal_after_discount, shipping_fee_after_discount, payment_platform_discount, raw_data').in('order_id', ids).limit(1000));
    const [{ data: settlements, error: settlementsError }, { data: products, error: productsError }, { count: orderItemCount, error: orderItemCountError }] = await Promise.all([
      adminClient.from('tiktok_bill_records').select('id, source_type, replacement_status, settlement_document_id, settlement_date, transaction_created_at, estimated_settlement_at, currency_code, transaction_type, transaction_id, related_order_id, sku_id, product_name, quantity, settlement_amount, total_income, total_fees, fee_breakdown, raw_data, import_batch_id, created_at, updated_at, shops(shop_name)').order('updated_at', { ascending: false }).limit(500),
      adminClient.from('products').select('product_code, product_name'),
      adminClient.from('order_items').select('id', { count: 'exact', head: true })
    ]);
    const itemsError = itemResults.find(result => result.error)?.error;
    const items = itemResults.flatMap(result => result.data || []);
    if (itemsError || settlementsError || productsError || orderItemCountError) throw new Error('读取订单与结算数据失败');
    const productNameByCode = new Map((products || []).map(product => [product.product_code, product.product_name]));
    const orderItems = new Map();
    items.forEach(item => { const rows = orderItems.get(item.order_id) || []; rows.push(item); orderItems.set(item.order_id, rows); });
    const formattedOrders = orders.flatMap(order => {
      const itemsForOrder = orderItems.get(order.id) || [{}];
      return itemsForOrder.map(item => {
        const paymentValues = [item.sku_subtotal_after_discount, item.shipping_fee_after_discount, item.payment_platform_discount];
        const paid = paymentValues.every(value => value === null || value === undefined) ? '—' : `${order.currency_code} ${(Number(item.sku_subtotal_after_discount || 0) + Number(item.shipping_fee_after_discount || 0) - Number(item.payment_platform_discount || 0)).toFixed(2)}`;
return { id: `${order.id}::${item.sku_id || 'no-sku'}`, orderId: order.id, number: order.order_number, shop: order.shops?.shop_name || '—', site: order.shops?.country_code || '—', warehouse: order.warehouses?.name || order.warehouse_name || '—', warehouseOriginalName: order.warehouse_name || order.warehouses?.original_warehouse_name || order.warehouses?.name || '—', code: item.product_code || '—', sku: item.sku_id || '—', name: productNameByCode.get(item.product_code) || '—', qty: item.quantity || 0, paid, status: order.order_status, refund: order.refund_status, orderSubstatus: order.order_substatus || '—', refundAmount: `${order.currency_code} ${Number(order.refund_amount).toFixed(2)}`, tracking: order.tracking_number || '—', carrier: order.logistics_carrier || '—', deliveryOption: order.delivery_option || '—', ordered: businessDatePart(order.ordered_at) || '—', shipped: businessDatePart(order.shipped_at) || '—', updated: businessDatePart(order.synced_at) || '—', source: order.source_identifier || '—', profitData: '待结算', rawData: { ...(order.raw_data || {}), ...(item.raw_data || {}) }, items: itemsForOrder.map(orderItem => ({ ...orderItem, product_name: productNameByCode.get(orderItem.product_code) || '—' })) };
      });
    });
    const formattedSettlements = settlements.map(record => ({ id: record.id, number: record.settlement_number, date: record.settlement_date, currency: record.currency_code, type: record.transaction_type, order: record.related_order_number || '—', sku: record.sku_id || '—', name: record.product_name || '—', qty: record.quantity || 0, amount: `${record.currency_code} ${Number(record.settlement_total).toFixed(2)}`, income: `${record.currency_code} ${Number(record.total_income || 0).toFixed(2)}`, fees: `${record.currency_code} ${Number(record.total_fees || 0).toFixed(2)}`, shop: record.shops?.shop_name || '—', batch: record.source_identifier || '—', importStatus: record.import_status, syncedAt: record.synced_at }));
    sendJson(response, 200, { orders: formattedOrders, settlements: formattedSettlements, orderMeta: { orderCount: orderCount || 0, orderItemCount: orderItemCount || 0, loadedOrderCount: (orders || []).length, loadedOrderItemCount: formattedOrders.length } });
  } catch (error) { adminError(response, error); }
}
function billDisplayAmount(record) {
  // 列表只读取用于展示的标准金额，完整原始字段改为用户点击“详情”时再读取。
  const value = record.settlement_amount;
  const amount = Number(String(value ?? 0).replace(/,/g, ''));
  return Number.isFinite(amount) ? amount : 0;
}
function datePart(value) {
  if (!value) return null;
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(String(value));
  if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString().slice(0, 10);
  const matched = String(value).match(/^\d{4}-\d{2}-\d{2}/);
  return matched ? matched[0] : null;
}
function chineseDatePart(value) {
  const isoDate = datePart(value);
  if (!isoDate) return null;
  const [year, month, day] = isoDate.split('-');
  return `${year}年${Number(month)}月${Number(day)}日`;
}
// 订单筛选以导入时保留的 UTC 业务日为准。PostgreSQL 返回 timestamptz 时会
// 按服务进程时区序列化，直接截取字符串会把 UTC 深夜订单显示到次日。
function businessDatePart(value) {
  if (!value) return null;
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString().slice(0, 10) : datePart(value);
}
function formatTikTokBillRecord(record) {
  return { id: record.id, sourceType: record.source_type, replacementStatus: record.replacement_status, number: record.settlement_document_id || '—', date: datePart(record.settlement_date) || datePart(record.transaction_created_at) || datePart(record.created_at) || '—', estimatedDate: datePart(record.estimated_settlement_at) || '—', currency: record.currency_code, type: record.transaction_type, order: record.transaction_id || record.related_order_id || '—', relatedOrder: record.related_order_id || '—', sku: record.sku_id || '—', name: record.product_name || '—', qty: record.quantity || 0, amount: `${record.currency_code} ${billDisplayAmount(record).toFixed(2)}`, income: `${record.currency_code} ${Number(record.total_income || 0).toFixed(2)}`, fees: `${record.currency_code} ${Number(record.total_fees || 0).toFixed(2)}`, shop: record.shops?.shop_code || record.shops?.shop_name || '—', batch: record.import_batch_id || '—', importStatus: record.source_type === 'settled' ? '已结算' : '未结算预估', syncedAt: record.updated_at, rawData: {}, feeBreakdown: {}, unsettledReason: record.unsettled_reason || '—' };
}
async function productCodesBySettlementSku(records, scopedShopIds) {
  const skuIds = [...new Set((records || []).map(record => String(record.sku_id || '').trim()).filter(Boolean))];
  if (!skuIds.length) return new Map();
  if (localDatabaseEnabled()) {
    const values = [skuIds]; let sql = 'select distinct on (i.sku_id) i.sku_id, i.product_code from public.order_items i join public.orders o on o.id = i.order_id where i.sku_id = any($1::text[])';
    if (scopedShopIds !== null) { values.push(scopedShopIds); sql += ` and o.shop_id = any($${values.length}::uuid[])`; }
    sql += ' order by i.sku_id, i.created_at desc';
    return new Map((await localQuery(sql, values)).rows.filter(row => row.sku_id && row.product_code).map(row => [String(row.sku_id).trim(), String(row.product_code).trim()]));
  }
  const codeBySku = new Map();
  const safeShopIds = scopedShopIds?.length ? scopedShopIds : ['00000000-0000-0000-0000-000000000000'];
  for (let offset = 0; offset < skuIds.length; offset += 500) {
    let query = adminClient.from('order_items').select('sku_id, product_code, orders!inner(shop_id)').in('sku_id', skuIds.slice(offset, offset + 500));
    // 业务端仅在已授权店铺范围内查找订单明细，避免同 SKU 的其他店铺数据参与匹配。
    if (scopedShopIds !== null) query = query.in('orders.shop_id', safeShopIds);
    const { data, error } = await query;
    if (error) throw new Error('读取订单商品编码失败');
    (data || []).forEach(item => {
      const sku = String(item.sku_id || '').trim();
      const code = String(item.product_code || '').trim();
      if (sku && code && !codeBySku.has(sku)) codeBySku.set(sku, code);
    });
  }
  return codeBySku;
}
async function productNamesByCode(codeBySku) {
  const codes = [...new Set([...codeBySku.values()].map(code => String(code || '').trim()).filter(Boolean))];
  if (!codes.length) return new Map();
  if (localDatabaseEnabled()) {
    const rows = (await localQuery('select distinct on (product_code) product_code, product_name from public.products where product_code = any($1::text[]) order by product_code, updated_at desc', [codes])).rows;
    return new Map(rows.filter(row => row.product_code && row.product_name).map(row => [String(row.product_code).trim(), String(row.product_name).trim()]));
  }
  const nameByCode = new Map();
  for (let offset = 0; offset < codes.length; offset += 500) {
    const { data, error } = await adminClient.from('products').select('product_code, product_name, updated_at').in('product_code', codes.slice(offset, offset + 500)).order('updated_at', { ascending: false });
    if (error) throw new Error('读取商品名称失败');
    (data || []).forEach(product => {
      const code = String(product.product_code || '').trim();
      const name = String(product.product_name || '').trim();
      if (code && name && !nameByCode.has(code)) nameByCode.set(code, name);
    });
  }
  return nameByCode;
}
async function authorizedShopFilterOptions(scopedShopIds = null) {
  // 店铺下拉不再由当前页数据推断。这样没有订单/账单的已授权店铺也能被选中查询，
  // 且业务端始终只会拿到本人被授权、并且仍启用的店铺。
  if (localDatabaseEnabled()) {
    const values = [];
    let sql = 'select id, shop_code, shop_name from public.shops where is_active = true';
    if (scopedShopIds !== null) { values.push(scopedShopIds); sql += ` and id = any($${values.length}::uuid[])`; }
    sql += ' order by shop_name asc';
    return (await localQuery(sql, values)).rows;
  }
  let shopsQuery = adminClient.from('shops').select('id, shop_code, shop_name').eq('is_active', true).order('shop_name', { ascending: true });
  if (scopedShopIds !== null) shopsQuery = shopsQuery.in('id', scopedShopIds.length ? scopedShopIds : ['00000000-0000-0000-0000-000000000000']);
  const { data: shops, error } = await shopsQuery;
  if (error) throw new Error('读取店铺筛选项失败');
  return shops || [];
}
async function listPaginatedTikTokBills(requestUrl, response, scopedShopIds = null) {
  const page = Math.max(1, Number(requestUrl.searchParams.get('page')) || 1);
  const requestedSize = Number(requestUrl.searchParams.get('pageSize')) || 20;
  const isExport = requestUrl.searchParams.get('export') === 'csv'; const pageSize = isExport ? 10000 : ([20, 50, 100].includes(requestedSize) ? requestedSize : 20);
  const tab = requestUrl.searchParams.get('settlementTab') || 'unsettled';
  const includeSuperseded = requestUrl.searchParams.get('includeSuperseded') === 'true';
  const isLight = requestUrl.searchParams.get('light') === 'true';
  const shop = requestUrl.searchParams.get('settlementShop') || '', currency = requestUrl.searchParams.get('settlementCurrency') || '', transactionType = requestUrl.searchParams.get('settlementType') || '', start = requestUrl.searchParams.get('settlementStart') || '', end = requestUrl.searchParams.get('settlementEnd') || '', orderId = requestUrl.searchParams.get('settlementOrder') || '', skuId = requestUrl.searchParams.get('settlementSku') || '';
  const listFields = isLight
    ? 'id, source_type, settlement_document_id, settlement_date, transaction_created_at, currency_code, transaction_type, transaction_id, related_order_id, sku_id, product_name, quantity, settlement_amount, shops!inner(shop_code, shop_name, country_code)'
    : 'id, source_type, replacement_status, settlement_document_id, settlement_date, transaction_created_at, estimated_settlement_at, currency_code, transaction_type, transaction_id, related_order_id, sku_id, product_name, quantity, settlement_amount, total_income, total_fees, import_batch_id, unsettled_reason, created_at, updated_at, shops!inner(shop_code, shop_name, country_code)';
  if (localDatabaseEnabled()) {
    const values = []; const where = []; const add = value => { values.push(value); return `$${values.length}`; };
    if (scopedShopIds !== null) where.push(`b.shop_id = any(${add(scopedShopIds)}::uuid[])`);
    if (tab === 'settled') { where.push(`b.source_type = 'settled'`, `b.replacement_status = 'active'`); }
    else if (tab === 'review') where.push(`b.replacement_status = 'needs_review'`);
    else { where.push(`b.source_type = 'unsettled'`); where.push(includeSuperseded ? `b.replacement_status in ('active','superseded')` : `b.replacement_status = 'active'`); }
    if (shop) where.push(`s.shop_code = ${add(shop)}`); if (currency) where.push(`b.currency_code = ${add(currency)}`); if (transactionType) where.push(`b.transaction_type = ${add(transactionType)}`);
    if (orderId) where.push(`b.transaction_id ilike ${add(`%${orderId}%`)}`); if (skuId) where.push(`b.sku_id ilike ${add(`%${skuId}%`)}`);
    const dateColumn = tab === 'settled' ? 'b.settlement_date' : tab === 'unsettled' ? 'b.transaction_created_at' : 'b.created_at';
    if (start) where.push(`${dateColumn} >= ${add(start)}`); if (end) where.push(`${dateColumn} <= ${add(tab === 'settled' ? end : `${end}T23:59:59.999+00:00`)}`);
    const clause = where.length ? `where ${where.join(' and ')}` : '';
    const countResult = await localQuery(`select count(*)::int as count from public.tiktok_bill_records b join public.shops s on s.id=b.shop_id ${clause}`, values);
    const pageValues = [...values, pageSize, (page - 1) * pageSize];
    // settlement_date 是无时区 date。显式返回文本，避免 Node 按本机时区
    // 把 2026-10-12 序列化为前一天 UTC，从而与筛选日期不一致。
    const data = (await localQuery(`select b.*, b.settlement_date::text as settlement_date, json_build_object('shop_code',s.shop_code,'shop_name',s.shop_name,'country_code',s.country_code) as shops from public.tiktok_bill_records b join public.shops s on s.id=b.shop_id ${clause} order by b.updated_at desc limit $${pageValues.length - 1} offset $${pageValues.length}`, pageValues)).rows;
    const shops = await authorizedShopFilterOptions(scopedShopIds); const count = countResult.rows[0].count;
    const codeBySku = await productCodesBySettlementSku(data, scopedShopIds); const nameByCode = await productNamesByCode(codeBySku);
    const productCodeFor = record => codeBySku.get(String(record.sku_id || '').trim()) || '—'; const productNameFor = record => nameByCode.get(productCodeFor(record)) || '—';
 if (isExport) { const csv = [['数据来源','利润状态','店铺简称','国家站点','订单创建日期','相关订单 ID','SKU ID','商品名称','数量','预计/结算金额','总收入','总费用','导入状态'], ...data.map(item => [item.source_type === 'settled' ? '已结算账单' : '未结算账单', item.replacement_status, item.shops?.shop_name || '', item.shops?.country_code || '', datePart(item.transaction_created_at) || datePart(item.settlement_date) || '', item.related_order_id || '', item.sku_id || '', productNameFor(item), item.quantity || 0, billDisplayAmount(item), item.total_income || 0, item.total_fees || 0, item.source_type])].map(row => row.map(value => `"${String(value ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n'); response.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="tiktok-bills.csv"' }); response.end(`\uFEFF${csv}`); return; }
    const settlements = data.map(record => { const formatted = formatTikTokBillRecord(record); formatted.site = record.shops?.country_code || '—'; formatted.productCode = productCodeFor(record); formatted.name = productNameFor(record); return formatted; });
    return sendJson(response, 200, { orders: [], settlements, filterOptions: { orderStatuses: [], logisticsStatuses: [], shops }, settlementMeta: { page, pageSize, totalRows: count, totalPages: Math.max(1, Math.ceil(count / pageSize)) }, orderMeta: { orderItemCount: 0, page: 1, pageSize: 20, totalPages: 1 } });
  }
  let query = adminClient.from('tiktok_bill_records').select(listFields, { count: 'exact' }).order('updated_at', { ascending: false });
  if (scopedShopIds !== null) query = query.in('shop_id', scopedShopIds.length ? scopedShopIds : ['00000000-0000-0000-0000-000000000000']);
  if (tab === 'settled') query = query.eq('source_type', 'settled').eq('replacement_status', 'active');
  else if (tab === 'review') query = query.eq('replacement_status', 'needs_review');
  else { query = query.eq('source_type', 'unsettled'); query = includeSuperseded ? query.in('replacement_status', ['active', 'superseded']) : query.eq('replacement_status', 'active'); }
  if (shop) query = query.eq('shops.shop_code', shop);
  if (currency) query = query.eq('currency_code', currency);
  if (transactionType) query = query.eq('transaction_type', transactionType);
  if (orderId) query = query.ilike('transaction_id', `%${orderId}%`);
  if (skuId) query = query.ilike('sku_id', `%${skuId}%`);
  const dateColumn = tab === 'settled' ? 'settlement_date' : tab === 'unsettled' ? 'transaction_created_at' : 'created_at';
  if (start) query = query.gte(dateColumn, start);
  if (end) query = query.lte(dateColumn, dateColumn === 'settlement_date' ? end : `${end}T23:59:59.999+00:00`);
  const [pageResult, shops] = await Promise.all([
    query.range((page - 1) * pageSize, page * pageSize - 1),
    authorizedShopFilterOptions(scopedShopIds)
  ]);
  const { data, error, count } = pageResult;
  if (error) throw new Error(`读取结算单数据失败：${error.message || '数据库查询失败'}`);
  const codeBySku = await productCodesBySettlementSku(data, scopedShopIds);
  const nameByCode = await productNamesByCode(codeBySku);
  const productCodeFor = record => codeBySku.get(String(record.sku_id || '').trim()) || '—';
  const productNameFor = record => nameByCode.get(productCodeFor(record)) || '—';
 if (isExport) { const csv = [['数据来源','利润状态','店铺简称','国家站点','订单创建日期','相关订单 ID','SKU ID','商品名称','数量','预计/结算金额','总收入','总费用','导入状态'], ...(data || []).map(item => [item.source_type === 'settled' ? '已结算账单' : '未结算账单', item.replacement_status, item.shops?.shop_name || '', item.shops?.country_code || '', datePart(item.transaction_created_at) || datePart(item.settlement_date) || '', item.related_order_id || '', item.sku_id || '', productNameFor(item), item.quantity || 0, billDisplayAmount(item), item.total_income || 0, item.total_fees || 0, item.source_type])].map(row => row.map(value => `"${String(value ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n'); response.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="tiktok-bills.csv"' }); response.end(`\uFEFF${csv}`); return; }
  if (isLight) {
    const totalRows = count || 0;
    return sendJson(response, 200, { orders: [], settlements: (data || []).map(record => { const formatted = formatTikTokBillRecord(record); formatted.site = record.shops?.country_code || '—'; formatted.productCode = productCodeFor(record); formatted.name = productNameFor(record); return formatted; }), filterOptions: { orderStatuses: [], logisticsStatuses: [], shops }, settlementMeta: { page, pageSize, totalRows, totalPages: Math.max(1, Math.ceil(totalRows / pageSize)) }, orderMeta: { orderItemCount: 0, page: 1, pageSize: 20, totalPages: 1 } });
  }
  const totalRows = count || 0;
  sendJson(response, 200, { orders: [], settlements: (data || []).map(record => { const formatted = formatTikTokBillRecord(record); formatted.site = record.shops?.country_code || '—'; formatted.productCode = productCodeFor(record); formatted.name = productNameFor(record); return formatted; }), filterOptions: { orderStatuses: [], logisticsStatuses: [], shops }, settlementMeta: { page, pageSize, totalRows, totalPages: Math.max(1, Math.ceil(totalRows / pageSize)) }, orderMeta: { orderItemCount: 0, page: 1, pageSize: 20, totalPages: Math.max(1, Math.ceil(totalRows / pageSize)) } });
}
async function listPaginatedOrderSettlementManagementData(request, response, scopedShopIds = null) {
  try {
    if (scopedShopIds === null) await requireAdministrator(request);
    const requestUrl = new URL(request.url, `http://${request.headers.host}`);
    const requestedSite = String(requestUrl.searchParams.get('site') || '').trim();
    if (requestUrl.searchParams.get('view') === 'settlements') {
      if (scopedShopIds !== null) requestUrl.searchParams.set('settlementTab', 'settled');
      return listPaginatedTikTokBills(requestUrl, response, scopedShopIds);
    }
    const page = Math.max(1, Number(requestUrl.searchParams.get('page')) || 1);
    const requestedSize = Number(requestUrl.searchParams.get('pageSize')) || 20;
    const isExport = requestUrl.searchParams.get('export') === 'csv';
    const pageSize = isExport ? 10000 : ([20, 50, 100].includes(requestedSize) ? requestedSize : 20);
    const shop = requestUrl.searchParams.get('shop') || '', warehouse = requestUrl.searchParams.get('warehouse') || '', status = requestUrl.searchParams.get('status') || '', logistics = requestUrl.searchParams.get('logistics') || '', start = requestUrl.searchParams.get('start') || '', end = requestUrl.searchParams.get('end') || '', orderId = requestUrl.searchParams.get('orderId') || '', code = requestUrl.searchParams.get('code') || '';
    const utcDayStart = date => `${date}T00:00:00+00:00`;
    const utcDayEnd = date => `${date}T23:59:59.999+00:00`;
    if (localDatabaseEnabled()) {
      const values = []; const where = []; const add = value => { values.push(value); return `$${values.length}`; };
      if (scopedShopIds !== null) where.push(`o.shop_id = any(${add(scopedShopIds)}::uuid[])`);
      if (shop) where.push(`s.shop_code = ${add(shop)}`); if (warehouse) where.push(`o.warehouse_name = any(${add(warehouse.split('|').filter(Boolean))}::text[])`);
      if (status) where.push(`o.order_status = ${add(status)}`); if (logistics) where.push(`o.order_substatus = ${add(logistics)}`);
      if (start) where.push(`o.ordered_at >= ${add(utcDayStart(start))}`); if (end) where.push(`o.ordered_at <= ${add(utcDayEnd(end))}`);
      if (orderId) where.push(`o.order_number ilike ${add(`%${orderId}%`)}`); if (code) where.push(`i.product_code ilike ${add(`%${code}%`)}`);
      const clause = where.length ? `where ${where.join(' and ')}` : '';
      const countResult = await localQuery(`select count(*)::int as count from public.order_items i join public.orders o on o.id=i.order_id join public.shops s on s.id=o.shop_id ${clause}`, values);
      const pageValues = [...values, pageSize, (page - 1) * pageSize];
      const itemRows = (await localQuery(`select i.*, row_to_json(o) as orders, json_build_object('shop_code',s.shop_code,'shop_name',s.shop_name,'country_code',s.country_code) as shop_data, json_build_object('name',w.name,'original_warehouse_name',w.original_warehouse_name) as warehouse_data from public.order_items i join public.orders o on o.id=i.order_id join public.shops s on s.id=o.shop_id left join public.warehouses w on w.id=o.warehouse_id ${clause} order by i.created_at desc limit $${pageValues.length - 1} offset $${pageValues.length}`, pageValues)).rows;
      const filterRows = (await localQuery(`select distinct o.order_status, o.order_substatus from public.orders o ${scopedShopIds !== null ? `where o.shop_id = any($1::uuid[])` : ''} limit 500`, scopedShopIds !== null ? [scopedShopIds] : [])).rows;
      const shops = await authorizedShopFilterOptions(scopedShopIds); const productCodes = [...new Set(itemRows.map(item => item.product_code).filter(Boolean))];
      const products = productCodes.length ? (await localQuery('select distinct on (product_code) product_code, product_name from public.products where product_code = any($1::text[]) order by product_code, updated_at desc', [productCodes])).rows : [];
      const productNameByCode = new Map(products.map(product => [product.product_code, product.product_name]));
const formattedOrders = itemRows.map(item => { const order = item.orders || {}; const paymentValues = [item.sku_subtotal_after_discount, item.shipping_fee_after_discount, item.payment_platform_discount]; const paid = paymentValues.every(value => value === null || value === undefined) ? '—' : `${order.currency_code || item.currency_code} ${(Number(item.sku_subtotal_after_discount || 0) + Number(item.shipping_fee_after_discount || 0) - Number(item.payment_platform_discount || 0)).toFixed(2)}`; const productName = productNameByCode.get(item.product_code) || item.product_name || '—'; return { id: `${order.id}::${item.sku_id || 'no-sku'}`, orderId: order.id, number: order.order_number || '—', shop: item.shop_data?.shop_code || item.shop_data?.shop_name || '—', site: item.shop_data?.country_code || '—', warehouse: item.warehouse_data?.name || order.warehouse_name || '—', warehouseOriginalName: order.warehouse_name || item.warehouse_data?.original_warehouse_name || item.warehouse_data?.name || '—', code: item.product_code || '—', sku: item.sku_id || '—', name: productName, qty: item.quantity || 0, paid, status: order.order_status || '—', refund: order.refund_status || '—', orderSubstatus: order.order_substatus || '—', refundAmount: `${order.currency_code || item.currency_code} ${Number(order.refund_amount || 0).toFixed(2)}`, tracking: order.tracking_number || '—', carrier: order.logistics_carrier || '—', deliveryOption: order.delivery_option || '—', ordered: businessDatePart(order.ordered_at) || '—', shipped: businessDatePart(order.shipped_at) || '—', updated: businessDatePart(order.synced_at) || '—', source: order.source_identifier || '—', profitData: '待结算', rawData: {}, items: [{ ...item, product_name: productName }] }; });
      const uniqueValues = (rows, key) => [...new Set(rows.map(row => row[key]).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b)));
      return sendJson(response, 200, { orders: formattedOrders, settlements: [], filterOptions: { orderStatuses: uniqueValues(filterRows, 'order_status'), logisticsStatuses: uniqueValues(filterRows, 'order_substatus'), shops }, orderMeta: { orderItemCount: countResult.rows[0].count, page, pageSize, totalPages: Math.max(1, Math.ceil(countResult.rows[0].count / pageSize)) } });
    }
    // 历史订单量较大时，关联筛选配合 exact 会为每次翻页执行一次全量精确计数，
    // 旧库会因此超时。planned 计数保留分页所需总量，同时不阻塞订单数据读取。
    let orderQuery = adminClient.from('order_items').select('order_id, product_code, sku_id, product_name, quantity, allocated_payment, currency_code, sku_subtotal_after_discount, shipping_fee_after_discount, payment_platform_discount, orders!inner(id, shop_id, order_number, order_status, order_substatus, refund_status, refund_amount, currency_code, tracking_number, logistics_carrier, delivery_option, warehouse_name, ordered_at, shipped_at, synced_at, source_identifier, shops!inner(shop_code, shop_name, country_code), warehouses(name, original_warehouse_name))', { count: 'planned' }).order('created_at', { ascending: false });
    if (scopedShopIds !== null) orderQuery = orderQuery.in('orders.shop_id', scopedShopIds.length ? scopedShopIds : ['00000000-0000-0000-0000-000000000000']);
    if (shop) orderQuery = orderQuery.eq('orders.shops.shop_code', shop);
    if (warehouse) orderQuery = orderQuery.in('orders.warehouse_name', warehouse.split('|').filter(Boolean));
    if (status) orderQuery = orderQuery.eq('orders.order_status', status);
    if (logistics) orderQuery = orderQuery.eq('orders.order_substatus', logistics);
    if (start) orderQuery = orderQuery.gte('orders.ordered_at', utcDayStart(start));
    if (end) orderQuery = orderQuery.lte('orders.ordered_at', utcDayEnd(end));
    if (orderId) orderQuery = orderQuery.ilike('orders.order_number', `%${orderId}%`);
    if (code) orderQuery = orderQuery.ilike('product_code', `%${code}%`);
    // 筛选器只需提供近期可用状态，不应为了下拉选项扫描全部历史订单。
    let orderFilterQuery = adminClient.from('orders').select('order_status, order_substatus').limit(500);
    if (scopedShopIds !== null) orderFilterQuery = orderFilterQuery.in('shop_id', scopedShopIds.length ? scopedShopIds : ['00000000-0000-0000-0000-000000000000']);
    if (start) orderFilterQuery = orderFilterQuery.gte('ordered_at', utcDayStart(start));
    if (end) orderFilterQuery = orderFilterQuery.lte('ordered_at', utcDayEnd(end));
    // 订单明细页不显示账单。旧逻辑即使在后台的“订单明细”视图中也会
    // 额外读取 500 条完整账单（含原始字段），账单慢或失败会误伤订单列表。
    // 结算单管理已通过 view=settlements 使用自己的分页查询，故此处绝不读取账单。
    const settlementPromise = Promise.resolve({ data: [], error: null });
    const [{ data: itemRows, error: itemsError, count: orderItemCount }, { data: settlements, error: settlementsError }, { data: orderFilterRows, error: orderFilterError }, shops] = await Promise.all([
      orderQuery.range((page - 1) * pageSize, page * pageSize - 1),
      // TikTok 已结算 / 未结算账单统一存于 tiktok_bill_records；此前仍读取旧的
      // settlement_records，导致账单导入成功后管理列表一直显示为空。
      settlementPromise,
      orderFilterQuery,
      authorizedShopFilterOptions(scopedShopIds)
    ]);
    // 订单明细是业务端的核心数据；筛选项查询失败时不应阻断订单本身展示。
    if (itemsError) {
      console.error('Order detail query failed', {
        itemsError: itemsError?.message,
        settlementsError: settlementsError?.message,
        orderFilterError: orderFilterError?.message,
        scoped: scopedShopIds !== null
      });
      throw new Error(scopedShopIds !== null ? '读取订单明细失败，请刷新后重试' : '读取订单与结算数据失败');
    }
    if (orderFilterError) console.warn('Order filter options unavailable; returning orders without optional filter values', { message: orderFilterError.message, scoped: scopedShopIds !== null });
    const productCodes = [...new Set((itemRows || []).map(item => item.product_code).filter(Boolean))];
    const { data: products, error: productsError } = productCodes.length ? await adminClient.from('products').select('product_code, product_name, updated_at').in('product_code', productCodes).order('updated_at', { ascending: false }) : { data: [], error: null };
    if (productsError) throw new Error('读取商品管理资料失败');
    const productNameByCode = new Map(); (products || []).forEach(product => { if (!productNameByCode.has(product.product_code)) productNameByCode.set(product.product_code, product.product_name); });
    const formattedOrders = (itemRows || []).map(item => {
      const order = item.orders || {}; const paymentValues = [item.sku_subtotal_after_discount, item.shipping_fee_after_discount, item.payment_platform_discount];
      const paid = paymentValues.every(value => value === null || value === undefined) ? '—' : `${order.currency_code || item.currency_code} ${(Number(item.sku_subtotal_after_discount || 0) + Number(item.shipping_fee_after_discount || 0) - Number(item.payment_platform_discount || 0)).toFixed(2)}`;
      const productName = productNameByCode.get(item.product_code) || item.product_name || '—';
return { id: `${order.id}::${item.sku_id || 'no-sku'}`, orderId: order.id, number: order.order_number || '—', shop: order.shops?.shop_code || order.shops?.shop_name || '—', site: order.shops?.country_code || '—', warehouse: order.warehouses?.name || order.warehouse_name || '—', warehouseOriginalName: order.warehouse_name || order.warehouses?.original_warehouse_name || order.warehouses?.name || '—', code: item.product_code || '—', sku: item.sku_id || '—', name: productName, qty: item.quantity || 0, paid, status: order.order_status || '—', refund: order.refund_status || '—', orderSubstatus: order.order_substatus || '—', refundAmount: `${order.currency_code || item.currency_code} ${Number(order.refund_amount || 0).toFixed(2)}`, tracking: order.tracking_number || '—', carrier: order.logistics_carrier || '—', deliveryOption: order.delivery_option || '—', ordered: businessDatePart(order.ordered_at) || '—', shipped: businessDatePart(order.shipped_at) || '—', updated: businessDatePart(order.synced_at) || '—', source: order.source_identifier || '—', profitData: '待结算', rawData: {}, items: [{ ...item, product_name: productName }] };
    });
const formattedSettlements = (settlements || []).map(record => ({ id: record.id, sourceType: record.source_type, replacementStatus: record.replacement_status, number: record.settlement_document_id || '—', date: datePart(record.settlement_date) || datePart(record.transaction_created_at) || '—', estimatedDate: datePart(record.estimated_settlement_at) || record.raw_data?.['预计结算时间'] || record.raw_data?.['Estimated Settlement Time'] || '—', currency: record.currency_code, type: record.transaction_type, order: record.transaction_id || record.related_order_id || '—', relatedOrder: record.related_order_id || '—', sku: record.sku_id || '—', name: record.product_name || '—', qty: record.quantity || 0, amount: `${record.currency_code} ${billDisplayAmount(record).toFixed(2)}`, income: `${record.currency_code} ${Number(record.total_income || 0).toFixed(2)}`, fees: `${record.currency_code} ${Number(record.total_fees || 0).toFixed(2)}`, shop: record.shops?.shop_name || '—', batch: record.import_batch_id || '—', importStatus: record.source_type === 'settled' ? '已结算' : '未结算预估', syncedAt: record.updated_at, rawData: record.raw_data || {}, feeBreakdown: record.fee_breakdown || {}, unsettledReason: record.unsettled_reason || '—' }));
    const uniqueValues = (rows, key) => [...new Set((rows || []).map(row => row[key]).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b)));
    sendJson(response, 200, { orders: formattedOrders, settlements: formattedSettlements, filterOptions: { orderStatuses: uniqueValues(orderFilterRows, 'order_status'), logisticsStatuses: uniqueValues(orderFilterRows, 'order_substatus'), shops }, orderMeta: { orderItemCount: orderItemCount || 0, page, pageSize, totalPages: Math.max(1, Math.ceil((orderItemCount || 0) / pageSize)) } });
  } catch (error) { adminError(response, error); }
}
async function getOrderSettlementDetail(request, response) {
  try {
    await requireAdministrator(request);
    const requestUrl = new URL(request.url, `http://${request.headers.host}`);
    const type = String(requestUrl.searchParams.get('type') || '');
    const id = String(requestUrl.searchParams.get('id') || '').trim();
    if (!id) throw new Error('缺少明细编号');
    if (localDatabaseEnabled()) {
      if (type === 'settlement') {
        const result = await localQuery('select raw_data, fee_breakdown from public.tiktok_bill_records where id = $1', [id]);
        const data = result.rows[0];
        if (!data) return sendJson(response, 404, { message: '未找到对应账单详情' });
        const rawData = data.raw_data || {};
        return sendJson(response, 200, { rawData, feeBreakdown: data.fee_breakdown || {}, estimatedDate: rawData['预计结算时间'] || rawData['Estimated Settlement Time'] || '—' });
      }
      if (type === 'order') {
        const result = await localQuery(`select o.raw_data as order_raw_data, i.raw_data as item_raw_data
          from public.orders o left join public.order_items i on i.order_id = o.id and i.sku_id = $2 where o.id = $1 limit 1`, [id, String(requestUrl.searchParams.get('sku') || '')]);
        const data = result.rows[0];
        if (!data) return sendJson(response, 404, { message: '未找到对应订单详情' });
        return sendJson(response, 200, { rawData: { ...(data.order_raw_data || {}), ...(data.item_raw_data || {}) } });
      }
    }
    if (type === 'settlement') {
      const { data, error } = await adminClient.from('tiktok_bill_records').select('raw_data, fee_breakdown').eq('id', id).maybeSingle();
      if (error) throw new Error(`读取账单详情失败：${error.message || '数据库查询失败'}`);
      if (!data) return sendJson(response, 404, { message: '未找到对应账单详情' });
      const rawData = data.raw_data || {};
      return sendJson(response, 200, { rawData, feeBreakdown: data.fee_breakdown || {}, estimatedDate: rawData['预计结算时间'] || rawData['Estimated Settlement Time'] || '—' });
    }
    if (type === 'order') {
      const [orderResult, itemResult] = await Promise.all([
        adminClient.from('orders').select('raw_data').eq('id', id).maybeSingle(),
        adminClient.from('order_items').select('raw_data').eq('order_id', id).eq('sku_id', String(requestUrl.searchParams.get('sku') || '')).limit(1).maybeSingle()
      ]);
      if (orderResult.error || itemResult.error) throw new Error(`读取订单详情失败：${orderResult.error?.message || itemResult.error?.message || '数据库查询失败'}`);
      if (!orderResult.data) return sendJson(response, 404, { message: '未找到对应订单详情' });
      return sendJson(response, 200, { rawData: { ...(orderResult.data.raw_data || {}), ...(itemResult.data?.raw_data || {}) } });
    }
    throw new Error('不支持的详情类型');
  } catch (error) { adminError(response, error); }
}
function importValue(row, ...keys) { for (const key of keys) { const value = row?.[key]; if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim(); } return ''; }
async function parseSpreadsheetRows(fileBase64) {
  const raw = String(fileBase64 || '').replace(/^data:[^,]+,/, '');
  if (!raw) return [];
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(Buffer.from(raw, 'base64'));
  const sheet = workbook.worksheets[0]; if (!sheet || sheet.rowCount < 2) return [];
  const headerMarkers = ['交易类型', '订单ID/调整单ID', 'SKU ID']; let headerRowNumber = 0;
  for (let rowNumber = 1; rowNumber <= Math.min(sheet.rowCount, 50); rowNumber++) {
    const cells = []; sheet.getRow(rowNumber).eachCell({ includeEmpty: true }, cell => cells.push(String(cell.text || '').replace(/^\uFEFF/, '').trim()));
    if (headerMarkers.every(marker => cells.includes(marker))) { headerRowNumber = rowNumber; break; }
  }
  if (!headerRowNumber) throw new Error('未找到账单表头：请确认文件包含“交易类型、订单ID/调整单ID、SKU ID”字段');
  const headers = []; sheet.getRow(headerRowNumber).eachCell({ includeEmpty: true }, (cell, column) => { headers[column] = String(cell.text || '').replace(/^\uFEFF/, '').trim(); });
  const rows = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => { if (rowNumber <= headerRowNumber) return; const record = {}; let hasValue = false; headers.forEach((header, column) => { if (!header) return; const value = row.getCell(column).value; const normalized = value instanceof Date ? value.toISOString() : String(row.getCell(column).text || '').trim(); record[header] = normalized; if (normalized) hasValue = true; }); if (hasValue) { Object.defineProperty(record, '__sourceRowNumber', { value: rowNumber, enumerable: false }); rows.push(record); } });
  return rows;
}
function normalizeBillDate(value, fieldName) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  return normalizeImportedDateTime(String(value), fieldName);
}
function normalizedBillKey(value) { return String(value || '').trim().toLowerCase().replace(/\s+/g, ' '); }
function billMatchKey(item) { return item.skuId ? `${normalizedBillKey(item.transactionType)}::${normalizedBillKey(item.transactionId)}::${normalizedBillKey(item.skuId)}` : ''; }
function billSourceFingerprint(item) { if (item.sourceType === 'settled') return [item.settlementDocumentId, item.relatedOrderId, item.skuId, item.settlementAmount].map(normalizedBillKey).join('::'); return billMatchKey(item) || `${normalizedBillKey(item.transactionType)}::${normalizedBillKey(item.transactionId)}::no-sku`; }
function billAmount(row, ...keys) {
  const value = importValue(row, ...keys);
  // TikTok exports use these placeholders for optional fee columns. They are
  // not amounts, so keep them absent instead of rejecting an otherwise valid bill.
  if (!value || ['—', '–', '-', '/', 'N/A', 'n/a', 'NULL', 'null'].includes(value)) return null;
  const number = Number(value.replace(/,/g, ''));
  if (!Number.isFinite(number)) throw new Error(`${keys[0]} 金额格式无效`);
  return number;
}
function dynamicBillFeeFieldNames(row, knownFields) {
  return Object.keys(row || {}).filter(field => {
    const label = String(field || '').trim();
    if (!label || knownFields.has(label) || BILL_NON_FEE_FIELD_NAMES.has(label.toLowerCase())) return false;
    // New TikTok fee headers vary by site and campaign.  Retain numeric
    // charges automatically while excluding the structural bill columns.
    return /费用|费$|佣金|税|扣费|成本|charge|fee|commission|tax|cost/i.test(label);
  });
}
function billImportRow(row, sourceType, shop) {
  const transactionType = importValue(row, '交易类型', 'Transaction Type', 'transaction_type');
  const transactionId = importValue(row, '订单ID/调整单ID', '订单 ID/调整单 ID', 'Order ID/Adjustment ID', 'transaction_id');
  const skuId = importValue(row, 'SKU ID', 'sku_id') || null;
  if (!transactionType || !transactionId) throw new Error('缺少交易类型或订单ID/调整单ID');
  const currencyCode = (importValue(row, '货币', 'Currency', 'currency_code') || shop.currency_code || '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currencyCode)) throw new Error('货币必须是三位货币代码');
  const knownFeeFields = [...new Set([...BILL_DETAIL_BREAKDOWN_FIELDS, '预计交易手续费', '预计商家运费', '预计联盟佣金'])];
  const knownFeeSet = new Set(knownFeeFields);
  const dynamicFeeFields = dynamicBillFeeFieldNames(row, knownFeeSet);
  const feeBreakdown = Object.fromEntries([...knownFeeFields, ...dynamicFeeFields].map(key => {
    try { return [key, billAmount(row, key)]; }
    // A new column may be a textual fee note instead of a numeric charge.
    // Preserve the import and ignore only that non-amount column.
    catch (error) { if (knownFeeSet.has(key)) throw error; return [key, null]; }
  }).filter(([, value]) => value !== null));
  const estimatedSettlementText = sourceType === 'unsettled' ? importValue(row, '预计结算时间', 'Estimated Settlement Time', 'estimated_settlement_at') : '';
  let estimatedSettlementAt = null;
  if (estimatedSettlementText) { try { estimatedSettlementAt = normalizeBillDate(estimatedSettlementText, '预计结算时间'); } catch { estimatedSettlementAt = null; } }
  const item = {
    sourceType, transactionType, transactionId, skuId, currencyCode,
    relatedOrderId: importValue(row, '相关订单 ID', 'Related Order ID', 'related_order_id') || null,
    productName: importValue(row, '商品名称', 'Product Name', 'product_name') || null,
    skuName: importValue(row, 'SKU 名称', 'SKU Name', 'sku_name') || null,
    quantity: (() => { const value = importValue(row, '数量', 'Quantity', 'quantity'); if (!value || ['/', '—', '-', 'N/A', 'n/a'].includes(value)) return null; const number = Number(value); if (!Number.isInteger(number)) throw new Error('数量必须为整数'); return number; })(),
    settlementDocumentId: sourceType === 'settled' ? (importValue(row, '结算单 ID', 'Settlement Statement ID', 'settlement_document_id') || null) : null,
    settlementDate: sourceType === 'settled' ? normalizeBillDate(importValue(row, '结算日期', 'Settlement Date', 'settlement_date'), '结算日期') : null,
    transactionCreatedAt: sourceType === 'unsettled' ? normalizeBillDate(importValue(row, '交易创建日期', 'Transaction Creation Date', 'transaction_created_at'), '交易创建日期') : null,
    estimatedSettlementAt,
    unsettledReason: sourceType === 'unsettled' ? (importValue(row, '未结算原因', 'Unsettled Reason', 'unsettled_reason') || null) : null,
    settlementAmount: sourceType === 'settled' ? billAmount(row, '结算总金额', 'Settlement Total Amount', 'settlement_amount') : billAmount(row, '预计结算金额', 'Estimated Settlement Amount', 'settlement_amount'),
    totalIncome: billAmount(row, '总收入', 'Total Revenue', 'total_income'), totalFees: billAmount(row, '总费用', 'Total Fees', 'total_fees'), feeBreakdown, rawData: row
  };
  if (sourceType === 'settled' && (!item.settlementDocumentId || !item.relatedOrderId || !item.skuId || !item.settlementDate || item.settlementAmount === null)) throw new Error('已结算账单缺少结算日期、结算单 ID、相关订单 ID、SKU ID 或结算总金额');
  if (sourceType === 'unsettled' && item.settlementAmount === null) throw new Error('未结算账单缺少预计结算金额');
  item.matchKey = billMatchKey(item); item.sourceFingerprint = billSourceFingerprint(item); return item;
}
function billPayload(item, shop, batchId, replacementStatus = null, localArchive = null) {
  // Original Excel is kept by the importer locally; avoid duplicating full
  // raw rows in Postgres and retain a compact, traceable batch reference.
  const archiveReference = localArchive ? { archived: false, local_archive_requested: true, import_batch_code: localArchive.batchCode, source_file_name: localArchive.fileName } : item.rawData;
  return { shop_id: shop.id, source_type: item.sourceType, source_fingerprint: item.sourceFingerprint, transaction_type: item.transactionType, transaction_id: item.transactionId, related_order_id: item.relatedOrderId, sku_id: item.skuId, product_name: item.productName, sku_name: item.skuName, quantity: item.quantity, currency_code: item.currencyCode, settlement_document_id: item.settlementDocumentId, settlement_date: item.settlementDate?.slice(0, 10) || null, transaction_created_at: item.transactionCreatedAt, estimated_settlement_at: item.estimatedSettlementAt, unsettled_reason: item.unsettledReason, settlement_amount: item.settlementAmount, total_income: item.totalIncome, total_fees: item.totalFees, fee_breakdown: item.feeBreakdown, raw_data: archiveReference, import_batch_id: batchId, replacement_status: replacementStatus || (item.matchKey ? 'active' : 'needs_review') };
}
function billChanges(existing, item) {
  const fields = [['结算金额', 'settlement_amount', item.settlementAmount], ['总收入', 'total_income', item.totalIncome], ['总费用', 'total_fees', item.totalFees], ['结算日期', 'settlement_date', item.settlementDate?.slice(0, 10) || null], ['预计结算时间', 'estimated_settlement_at', item.estimatedSettlementAt], ['未结算原因', 'unsettled_reason', item.unsettledReason]];
  const changes = fields.filter(([, key, value]) => String(existing?.[key] ?? '') !== String(value ?? '')).map(([label]) => label);
  if (JSON.stringify(existing?.fee_breakdown || {}) !== JSON.stringify(item.feeBreakdown || {})) changes.push('账单费用拆分');
  return changes;
}
async function collectBillQueryChunks(values, queryChunk, errorMessage) {
  // PostgREST encodes `in(...)` values in the URL.  Bill fingerprints can be
  // long, so a 200-row chunk may exceed a proxy URL limit for larger files.
  const uniqueValues = [...new Set(values.filter(Boolean))]; const rows = []; const chunkSize = 50; const parallel = 3;
  const chunks = Array.from({ length: Math.ceil(uniqueValues.length / chunkSize) }, (_, index) => uniqueValues.slice(index * chunkSize, (index + 1) * chunkSize));
  const readChunk = async (chunk) => {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const { data, error } = await queryChunk(chunk);
        if (!error) return data || [];
        lastError = error;
      } catch (error) { lastError = error; }
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
    }
    throw new Error(`${errorMessage}：${lastError?.message || '数据库请求失败'}`);
  };
  for (let offset = 0; offset < chunks.length; offset += parallel) {
    const chunkRows = await Promise.all(chunks.slice(offset, offset + parallel).map(readChunk));
    chunkRows.forEach(data => rows.push(...data));
  }
  return rows;
}
async function readWithRetries(read, errorMessage, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const result = await read();
      if (!result.error) return result;
      lastError = result.error;
    } catch (error) { lastError = error; }
    if (attempt < attempts - 1) await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
  }
  throw new Error(`${errorMessage}：${lastError?.message || '数据库请求失败'}`);
}
async function importTiktokBills(request, response) {
  try {
    const actor = await requireAdministrator(request); const body = await readJson(request); const sourceType = body.sourceType === 'settled' ? 'settled' : 'unsettled';
    const importedRows = Array.isArray(body.rows) ? body.rows : await parseSpreadsheetRows(body.fileBase64); const rows = importedRows; const mode = body.mode === 'commit' ? 'commit' : 'preview'; const shopId = String(body.shopId || ''); const fileName = String(body.fileName || 'TikTok账单').slice(0, 200);
    if (localDatabaseEnabled()) return importTiktokBillsLocal(actor, { sourceType, rows, mode, shopId, fileName }, response);
    if (!rows.length) throw new Error('文件中没有可导入的数据'); if (!/^[0-9a-f-]{36}$/i.test(shopId)) throw new Error('请选择有效店铺');
    const { data: shop, error: shopError } = await adminClient.from('shops').select('id, shop_code, shop_name, country_code, currency_code').eq('id', shopId).eq('is_active', true).single(); if (shopError || !shop) throw new Error('请选择启用中的店铺');
    const validRows = [], failures = [], seen = new Set();
    rows.forEach((row, index) => { try { const item = billImportRow(row, sourceType, shop); if (seen.has(item.sourceFingerprint)) throw new Error(sourceType === 'settled' ? '文件内存在重复的结算单 ID + 相关订单 ID + SKU ID + 结算总金额' : '文件内存在重复的交易类型 + 订单/调整单 ID + SKU ID'); seen.add(item.sourceFingerprint); validRows.push(item); } catch (error) { failures.push({ row: Number(row?.__sourceRowNumber) || index + 2, reason: error.message || '数据无效' }); } });
    if (failures.length) return sendJson(response, 200, { valid: false, sourceType, totalRows: rows.length, failures: failures.slice(0, 100), message: '校验未通过：请修正失败行后重新上传，系统未写入任何数据。' });
    const fingerprints = validRows.map(item => item.sourceFingerprint); const transactionIds = [...new Set(validRows.map(item => item.transactionId))];
    const [sameSource, related, batchResult] = await Promise.all([
      collectBillQueryChunks(fingerprints, chunk => adminClient.from('tiktok_bill_records').select('*').eq('shop_id', shop.id).eq('source_type', sourceType).in('source_fingerprint', chunk), '读取同来源账单记录失败'),
      collectBillQueryChunks(transactionIds, chunk => adminClient.from('tiktok_bill_records').select('*').eq('shop_id', shop.id).in('transaction_id', chunk), '读取可替代账单记录失败'),
      adminClient.from('order_import_batches').select('batch_code').like('batch_code', `${sourceType === 'settled' ? '已结算' : '未结算'}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}%`)
    ]);
    if (batchResult.error) throw new Error(`生成导入批次失败：${batchResult.error.message || '数据库查询失败'}`); const batches = batchResult.data || [];
    const sameByFingerprint = new Map((sameSource || []).map(item => [item.source_fingerprint, item])); const relatedByMatch = new Map();
    (related || []).forEach(item => { const key = item.sku_id ? `${normalizedBillKey(item.transaction_type)}::${normalizedBillKey(item.transaction_id)}::${normalizedBillKey(item.sku_id)}` : ''; if (key) relatedByMatch.set(`${item.source_type}::${key}`, item); });
    let insertCount = 0, updateCount = 0, skipCount = 0, replaceCount = 0, reviewCount = 0; const changeDetails = [];
    validRows.forEach(item => { const existing = sameByFingerprint.get(item.sourceFingerprint); const fields = billChanges(existing, item); const opposite = item.matchKey ? relatedByMatch.get(`${sourceType === 'settled' ? 'unsettled' : 'settled'}::${item.matchKey}`) : null; if (!existing) insertCount++; else if (fields.length) { updateCount++; changeDetails.push({ transactionId: item.transactionId, skuId: item.skuId || '—', fields }); } else skipCount++; if (!item.matchKey) reviewCount++; else if (opposite && opposite.replacement_status !== 'superseded') replaceCount++; });
    const prefix = `${sourceType === 'settled' ? '已结算' : '未结算'}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`; const batchCode = `${prefix}-${String((batches || []).length + 1).padStart(3, '0')}`;
    const writeBatchCount = Math.ceil((insertCount + updateCount) / BILL_IMPORT_WRITE_BATCH_SIZE);
    const preview = { valid: true, sourceType, mode, batchCode, shop: { id: shop.id, code: shop.shop_code, name: shop.shop_name, countryCode: shop.country_code, currencyCode: shop.currency_code }, totalRows: rows.length, writeBatchSize: BILL_IMPORT_WRITE_BATCH_SIZE, writeBatchCount, insertCount, updateCount, skipCount, replaceCount, reviewCount, changeDetails: changeDetails.slice(0, 50) };
    if (mode === 'preview') return sendJson(response, 200, preview);
    const { data: batch, error: batchError } = await adminClient.from('order_import_batches').insert({ batch_code: batchCode, import_type: sourceType === 'settled' ? 'settled_bills' : 'unsettled_bills', file_name: fileName, shop_id: shop.id, country_code: shop.country_code, currency_code: shop.currency_code, total_rows: rows.length, success_rows: 0, updated_rows: 0, skipped_rows: skipCount, failed_rows: 0, failure_summary: [], validation_status: 'processing', rollback_expires_at: rollbackExpiry(), imported_by: actor.id }).select().single(); if (batchError) throw new Error('创建账单导入批次失败');
    try {
      const localArchive = { batchCode: batch.batch_code, fileName };
      const changed = validRows.filter(item => { const existing = sameByFingerprint.get(item.sourceFingerprint); return !existing || billChanges(existing, item).length; });
      if (changed.length) {
        const payloads = changed.map(item => billPayload(item, shop, batch.id, null, localArchive));
        for (let offset = 0; offset < payloads.length; offset += BILL_IMPORT_WRITE_BATCH_SIZE) {
          const { error } = await adminClient.from('tiktok_bill_records').upsert(payloads.slice(offset, offset + BILL_IMPORT_WRITE_BATCH_SIZE), { onConflict: 'shop_id,source_type,source_fingerprint' });
          if (error) throw new Error(`保存账单明细失败：${error.message}`);
        }
      }
      const written = await collectBillQueryChunks(fingerprints, chunk => adminClient.from('tiktok_bill_records').select('id, source_type, source_fingerprint, transaction_type, transaction_id, sku_id, replacement_status').eq('shop_id', shop.id).in('source_fingerprint', chunk), '读取写入后的账单失败');
      const writtenBy = new Map((written || []).map(item => [`${item.source_type}::${item.source_fingerprint}`, item]));
      const rollbackChanges = validRows.map(item => { const record = writtenBy.get(`${sourceType}::${item.sourceFingerprint}`); const before = sameByFingerprint.get(item.sourceFingerprint) || null; return record ? { batch_id: batch.id, record_id: record.id, operation: before ? 'update' : 'insert', before_data: before, after_data: { ...record, import_batch_id: batch.id } } : null; }).filter(Boolean);
      for (const item of validRows) {
        const record = writtenBy.get(`${sourceType}::${item.sourceFingerprint}`); if (!record) continue;
        if (!item.matchKey) { await adminClient.from('tiktok_bill_records').update({ replacement_status: 'needs_review', replaced_by_id: null, replaces_record_id: null }).eq('id', record.id); continue; }
        const opposite = relatedByMatch.get(`${sourceType === 'settled' ? 'unsettled' : 'settled'}::${item.matchKey}`); if (!opposite) continue;
        if (sourceType === 'settled') { rollbackChanges.push({ batch_id: batch.id, record_id: opposite.id, operation: 'replacement', before_data: opposite, after_data: null }); const { error: targetError } = await adminClient.from('tiktok_bill_records').update({ replacement_status: 'superseded', replaced_by_id: record.id }).eq('id', opposite.id); if (targetError) throw targetError; const { error: sourceError } = await adminClient.from('tiktok_bill_records').update({ replacement_status: 'active', replaces_record_id: opposite.id }).eq('id', record.id); if (sourceError) throw sourceError; }
        else { rollbackChanges.push({ batch_id: batch.id, record_id: record.id, operation: 'replacement', before_data: { ...record, replacement_status: 'active', replaced_by_id: null, replaces_record_id: null }, after_data: null }); const { error: sourceError } = await adminClient.from('tiktok_bill_records').update({ replacement_status: 'superseded', replaced_by_id: opposite.id }).eq('id', record.id); if (sourceError) throw sourceError; }
      }
      // 回滚快照包含原始账单 JSON；大文件一次写入会超过数据库语句超时阈值，必须分批保存。
      for (let offset = 0; offset < rollbackChanges.length; offset += 25) {
        const { error: changesError } = await adminClient.from('tiktok_bill_import_changes').insert(rollbackChanges.slice(offset, offset + 25));
        if (changesError) throw new Error(`保存账单回滚快照失败：${changesError.message || '数据库写入失败'}`);
      }
      const { error: completeError } = await adminClient.from('order_import_batches').update({ success_rows: insertCount + updateCount, updated_rows: updateCount, skipped_rows: skipCount, validation_status: 'completed' }).eq('id', batch.id); if (completeError) throw completeError;
      const purgedRollbackSnapshots = await purgeExpiredImportRollbackSnapshots();
      preview.localArchive = { required: true, fileName, batchCode: batch.batch_code };
      preview.purgedRollbackSnapshots = purgedRollbackSnapshots;
      await writeAudit(actor.id, 'tiktok_bill_import', batch.id, 'commit_tiktok_bill_import', null, preview); dashboardOverviewCache.clear(); sendJson(response, 200, { ...preview, batch, message: `导入完成：新增 ${insertCount} 条，更新 ${updateCount} 条，跳过 ${skipCount} 条；替代预估 ${replaceCount} 条，待核对 ${reviewCount} 条。` });
    } catch (error) { await adminClient.from('order_import_batches').update({ validation_status: 'partial', failure_summary: [{ reason: error.message || '写入中断' }] }).eq('id', batch.id); throw error; }
  } catch (error) { adminError(response, error); }
}
async function importTiktokBillsLocal(actor, input, response) {
  const { sourceType, rows, mode, shopId, fileName } = input;
  if (!rows.length) throw new Error('文件中没有可导入的数据');
  if (!/^[0-9a-f-]{36}$/i.test(shopId)) throw new Error('请选择有效店铺');
  const shop = (await localQuery(`select id, shop_code, shop_name, country_code, currency_code from public.shops where id = $1 and is_active = true`, [shopId])).rows[0];
  if (!shop) throw new Error('请选择启用中的店铺');
  const validRows = [], failures = [], seen = new Set();
  rows.forEach((row, index) => { try { const item = billImportRow(row, sourceType, shop); if (seen.has(item.sourceFingerprint)) throw new Error(sourceType === 'settled' ? '文件内存在重复的结算单 ID + 相关订单 ID + SKU ID + 结算总金额' : '文件内存在重复的交易类型 + 订单/调整单 ID + SKU ID'); seen.add(item.sourceFingerprint); validRows.push(item); } catch (error) { failures.push({ row: Number(row?.__sourceRowNumber) || index + 2, reason: error.message || '数据无效' }); } });
  if (failures.length) return sendJson(response, 200, { valid: false, sourceType, totalRows: rows.length, failures: failures.slice(0, 100), message: '校验未通过：请修正失败行后重新上传，系统未写入任何数据。' });
  const fingerprints = validRows.map(item => item.sourceFingerprint), transactionIds = [...new Set(validRows.map(item => item.transactionId))];
  const [sameSourceResult, relatedResult, batchResult] = await Promise.all([
    localQuery(`select * from public.tiktok_bill_records where shop_id = $1 and source_type = $2 and source_fingerprint = any($3::text[])`, [shop.id, sourceType, fingerprints]),
    localQuery(`select * from public.tiktok_bill_records where shop_id = $1 and transaction_id = any($2::text[])`, [shop.id, transactionIds]),
    localQuery(`select batch_code from public.order_import_batches where batch_code like $1`, [`${sourceType === 'settled' ? '已结算' : '未结算'}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}%`])
  ]);
  const sameSource = sameSourceResult.rows, related = relatedResult.rows, batches = batchResult.rows;
  const sameByFingerprint = new Map(sameSource.map(item => [item.source_fingerprint, item])), relatedByMatch = new Map();
  related.forEach(item => { const key = item.sku_id ? `${normalizedBillKey(item.transaction_type)}::${normalizedBillKey(item.transaction_id)}::${normalizedBillKey(item.sku_id)}` : ''; if (key) relatedByMatch.set(`${item.source_type}::${key}`, item); });
  let insertCount = 0, updateCount = 0, skipCount = 0, replaceCount = 0, reviewCount = 0; const changeDetails = [];
  validRows.forEach(item => { const existing = sameByFingerprint.get(item.sourceFingerprint), fields = billChanges(existing, item), opposite = item.matchKey ? relatedByMatch.get(`${sourceType === 'settled' ? 'unsettled' : 'settled'}::${item.matchKey}`) : null; if (!existing) insertCount++; else if (fields.length) { updateCount++; changeDetails.push({ transactionId: item.transactionId, skuId: item.skuId || '—', fields }); } else skipCount++; if (!item.matchKey) reviewCount++; else if (opposite && opposite.replacement_status !== 'superseded') replaceCount++; });
  const prefix = `${sourceType === 'settled' ? '已结算' : '未结算'}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`, batchCode = `${prefix}-${String(batches.length + 1).padStart(3, '0')}`;
  const preview = { valid: true, sourceType, mode, batchCode, shop: { id: shop.id, code: shop.shop_code, name: shop.shop_name, countryCode: shop.country_code, currencyCode: shop.currency_code }, totalRows: rows.length, writeBatchSize: BILL_IMPORT_WRITE_BATCH_SIZE, writeBatchCount: Math.ceil((insertCount + updateCount) / BILL_IMPORT_WRITE_BATCH_SIZE), insertCount, updateCount, skipCount, replaceCount, reviewCount, changeDetails: changeDetails.slice(0, 50) };
  if (mode === 'preview') return sendJson(response, 200, preview);
  const batch = await withLocalTransaction(async ({ query }) => {
    const createdBatch = (await query(`insert into public.order_import_batches (batch_code, import_type, file_name, shop_id, country_code, currency_code, total_rows, success_rows, updated_rows, skipped_rows, failed_rows, failure_summary, validation_status, rollback_expires_at, imported_by) values ($1,$2,$3,$4,$5,$6,$7,0,0,$8,0,'[]'::jsonb,'processing',now() + interval '30 days',$9) returning *`, [batchCode, sourceType === 'settled' ? 'settled_bills' : 'unsettled_bills', fileName, shop.id, shop.country_code, shop.currency_code, rows.length, skipCount, actor.id])).rows[0];
    const localArchive = { batchCode: createdBatch.batch_code, fileName }, writtenByFingerprint = new Map(), rollbackChanges = [];
    for (const item of validRows) {
      const before = sameByFingerprint.get(item.sourceFingerprint) || null;
      if (before && !billChanges(before, item).length) { writtenByFingerprint.set(item.sourceFingerprint, before); continue; }
      const written = await localUpsert(query, 'public.tiktok_bill_records', billPayload(item, shop, createdBatch.id, null, localArchive), ['shop_id', 'source_type', 'source_fingerprint']);
      writtenByFingerprint.set(item.sourceFingerprint, written);
      rollbackChanges.push({ record_id: written.id, operation: before ? 'update' : 'insert', before_data: before, after_data: written });
    }
    for (const item of validRows) {
      const record = writtenByFingerprint.get(item.sourceFingerprint); if (!record) continue;
      if (!item.matchKey) { await query(`update public.tiktok_bill_records set replacement_status='needs_review', replaced_by_id=null, replaces_record_id=null where id=$1`, [record.id]); continue; }
      const opposite = relatedByMatch.get(`${sourceType === 'settled' ? 'unsettled' : 'settled'}::${item.matchKey}`); if (!opposite) continue;
      if (sourceType === 'settled') {
        rollbackChanges.push({ record_id: opposite.id, operation: 'replacement', before_data: opposite, after_data: null });
        await query(`update public.tiktok_bill_records set replacement_status='superseded', replaced_by_id=$1 where id=$2`, [record.id, opposite.id]);
        await query(`update public.tiktok_bill_records set replacement_status='active', replaces_record_id=$1 where id=$2`, [opposite.id, record.id]);
      } else {
        rollbackChanges.push({ record_id: record.id, operation: 'replacement', before_data: { ...record, replacement_status: 'active', replaced_by_id: null, replaces_record_id: null }, after_data: null });
        await query(`update public.tiktok_bill_records set replacement_status='superseded', replaced_by_id=$1 where id=$2`, [opposite.id, record.id]);
      }
    }
    for (const change of rollbackChanges) await query(`insert into public.tiktok_bill_import_changes (batch_id, record_id, operation, before_data, after_data) values ($1,$2,$3,$4::jsonb,$5::jsonb)`, [createdBatch.id, change.record_id, change.operation, change.before_data ? JSON.stringify(change.before_data) : null, change.after_data ? JSON.stringify(change.after_data) : null]);
    await query(`update public.order_import_batches set success_rows=$1, updated_rows=$2, skipped_rows=$3, validation_status='completed' where id=$4`, [insertCount + updateCount, updateCount, skipCount, createdBatch.id]);
    await query(`insert into public.audit_logs (actor_id, entity_type, entity_id, action, before_data, after_data) values ($1,'tiktok_bill_import',$2,'commit_tiktok_bill_import',null,$3::jsonb)`, [actor.id, createdBatch.id, JSON.stringify({ ...preview, localArchive: { required: true, fileName, batchCode } })]);
    return { ...createdBatch, validation_status: 'completed' };
  });
  dashboardOverviewCache.clear();
  return sendJson(response, 200, { ...preview, batch, message: `导入完成：新增 ${insertCount} 条，更新 ${updateCount} 条，跳过 ${skipCount} 条；替代预估 ${replaceCount} 条，待核对 ${reviewCount} 条。` });
}
async function manageBillBatch(request, response) {
  try {
    const actor = await requireAdministrator(request); const body = await readJson(request); const batchId = String(body.batchId || ''); if (!/^[0-9a-f-]{36}$/i.test(batchId)) throw new Error('导入批次参数无效');
    if (localDatabaseEnabled()) return manageBillBatchLocal(actor, body, batchId, response);
    const { data: batch, error: batchError } = await adminClient.from('order_import_batches').select('*').eq('id', batchId).in('import_type', ['settled_bills', 'unsettled_bills']).single(); if (batchError || !batch) throw new Error('未找到账单导入批次');
    if (body.action === 'delete') { if (batch.validation_status !== 'rolled_back') throw new Error('请先安全回滚该批次，才可删除导入记录'); const { data: records } = await adminClient.from('tiktok_bill_records').select('id').eq('import_batch_id', batchId).limit(1); if (records?.length) throw new Error('该批次仍有关联账单，不能删除'); const { error } = await adminClient.from('order_import_batches').delete().eq('id', batchId); if (error) throw error; return sendJson(response, 200, { message: '已删除回滚后的导入记录' }); }
    if (batch.validation_status !== 'completed') throw new Error('仅已完成的批次可回滚'); if (batch.rollback_expires_at && new Date(batch.rollback_expires_at).getTime() < Date.now()) throw new Error('该批次已超过 30 天安全回滚期，请从原始归档文件重新导入'); const { data: changes, error: changesError } = await adminClient.from('tiktok_bill_import_changes').select('*').eq('batch_id', batchId).order('created_at', { ascending: false }); if (changesError) throw changesError; if (!changes?.length) throw new Error('该历史批次没有回滚快照，无法安全回滚');
    const inserted = changes.filter(item => item.operation === 'insert').map(item => item.record_id).filter(Boolean); if (inserted.length) { const { data: current } = await adminClient.from('tiktok_bill_records').select('id, import_batch_id').in('id', inserted); if ((current || []).some(item => item.import_batch_id !== batchId)) throw new Error('该批次记录已被后续导入更新，不能安全回滚'); }
    for (const change of changes) { if (change.operation === 'insert') { const { error } = await adminClient.from('tiktok_bill_records').delete().eq('id', change.record_id).eq('import_batch_id', batchId); if (error) throw error; } else if (change.before_data) { const { id, created_at, updated_at, ...restore } = change.before_data; const { error } = await adminClient.from('tiktok_bill_records').update(restore).eq('id', change.record_id); if (error) throw error; } }
    const { error: statusError } = await adminClient.from('order_import_batches').update({ validation_status: 'rolled_back' }).eq('id', batchId); if (statusError) throw statusError; await writeAudit(actor.id, 'tiktok_bill_import', batchId, 'rollback_tiktok_bill_import', batch, null); dashboardOverviewCache.clear(); sendJson(response, 200, { message: `已安全回滚批次 ${batch.batch_code}` });
  } catch (error) { adminError(response, error); }
}
async function manageBillBatchLocal(actor, body, batchId, response) {
  const result = await withLocalTransaction(async ({ query }) => {
    const batch = (await query(`select * from public.order_import_batches where id = $1 and import_type = any($2::text[]) for update`, [batchId, ['settled_bills', 'unsettled_bills']])).rows[0];
    if (!batch) throw new Error('未找到账单导入批次');
    if (body.action === 'delete') {
      if (batch.validation_status !== 'rolled_back') throw new Error('请先安全回滚该批次，才可删除导入记录');
      const linked = (await query(`select 1 from public.tiktok_bill_records where import_batch_id = $1 limit 1`, [batchId])).rows[0];
      if (linked) throw new Error('该批次仍有关联账单，不能删除');
      await query(`delete from public.order_import_batches where id = $1`, [batchId]);
      await query(`insert into public.audit_logs (actor_id, entity_type, entity_id, action, before_data, after_data) values ($1,'tiktok_bill_import',$2,'delete_rolled_back_batch',$3::jsonb,null)`, [actor.id, batchId, JSON.stringify(batch)]);
      return { message: '已删除回滚后的导入记录' };
    }
    if (batch.validation_status !== 'completed') throw new Error('仅已完成的批次可回滚');
    if (batch.rollback_expires_at && new Date(batch.rollback_expires_at).getTime() < Date.now()) throw new Error('该批次已超过 30 天安全回滚期，请从原始归档文件重新导入');
    const changes = (await query(`select * from public.tiktok_bill_import_changes where batch_id = $1 order by created_at desc`, [batchId])).rows;
    if (!changes.length) throw new Error('该历史批次没有回滚快照，无法安全回滚');
    const inserted = changes.filter(item => item.operation === 'insert').map(item => item.record_id).filter(Boolean);
    if (inserted.length) {
      const current = (await query(`select id, import_batch_id from public.tiktok_bill_records where id = any($1::uuid[])`, [inserted])).rows;
      if (current.some(item => item.import_batch_id !== batchId)) throw new Error('该批次记录已被后续导入更新，不能安全回滚');
    }
    for (const change of changes) {
      if (change.operation === 'insert') {
        await query(`delete from public.tiktok_bill_records where id = $1 and import_batch_id = $2`, [change.record_id, batchId]);
      } else if (change.before_data) {
        const restore = { ...change.before_data }; delete restore.id; delete restore.created_at; delete restore.updated_at;
        const keys = Object.keys(restore).map(localIdentifier);
        if (keys.length) await query(`update public.tiktok_bill_records set ${keys.map((key, index) => `${key} = $${index + 1}`).join(', ')} where id = $${keys.length + 1}`, [...keys.map(key => restore[key]), change.record_id]);
      }
    }
    await query(`update public.order_import_batches set validation_status='rolled_back' where id = $1`, [batchId]);
    await query(`insert into public.audit_logs (actor_id, entity_type, entity_id, action, before_data, after_data) values ($1,'tiktok_bill_import',$2,'rollback_tiktok_bill_import',$3::jsonb,null)`, [actor.id, batchId, JSON.stringify(batch)]);
    return { message: `已安全回滚批次 ${batch.batch_code}` };
  });
  dashboardOverviewCache.clear();
  return sendJson(response, 200, result);
}
async function importOrderSettlementData(request, response) {
  try {
    const actor = await requireAdministrator(request); const body = await readJson(request); const importType = body.importType === 'settlements' ? 'settlements' : 'orders'; const rows = Array.isArray(body.rows) ? body.rows.slice(0, 2000) : []; const fileName = String(body.fileName || '导入文件.csv').slice(0, 200);
    if (!rows.length) throw new Error('文件中没有可导入的数据');
    const [{ data: shops, error: shopsError }, { data: warehouses, error: warehousesError }] = await Promise.all([adminClient.from('shops').select('id, shop_name'), adminClient.from('warehouses').select('id, name')]);
    if (shopsError || warehousesError) throw new Error('读取店铺或仓库资料失败'); const shopByName = new Map(shops.map(row => [row.shop_name, row])); const warehouseByName = new Map(warehouses.map(row => [row.name, row])); const failures=[]; let success=0, skipped=0;
    for (let index=0; index<rows.length; index++) { const row=rows[index]; try {
      const shopName=importValue(row,'店铺名称','店铺','shop_name','shop'); const shop=shopByName.get(shopName); if (!shop) throw new Error('未找到对应店铺');
      if (importType === 'orders') { const number=importValue(row,'订单ID','订单号','order_number'); const orderedAt=importValue(row,'下单日期','ordered_at'); const sku=importValue(row,'SKU ID','sku_id'); if (!number || !orderedAt || !sku) throw new Error('缺少订单ID、下单日期或SKU ID'); const payload={shop_id:shop.id,warehouse_id:warehouseByName.get(importValue(row,'仓库名称','仓库','warehouse'))?.id||null,order_number:number,order_status:importValue(row,'订单状态','order_status')||'待付款',refund_status:importValue(row,'退款状态','refund_status')||'无退款',refund_amount:Number(importValue(row,'退款金额','refund_amount')||0),payment_amount:Number(importValue(row,'支付金额','payment_amount')||0),currency_code:(importValue(row,'币种','currency_code')||'USD').toUpperCase(),tracking_number:importValue(row,'快递单号','tracking_number')||null,logistics_carrier:importValue(row,'物流承运商','logistics_carrier')||null,ordered_at:orderedAt,shipped_at:importValue(row,'发货日期','shipped_at')||null,source_identifier:fileName}; if(!Number.isFinite(payload.payment_amount)||!Number.isFinite(payload.refund_amount))throw new Error('金额格式无效'); const {data:order,error}=await adminClient.from('orders').upsert(payload,{onConflict:'shop_id,order_number'}).select('id').single(); if(error)throw new Error(error.message); const {error:itemError}=await adminClient.from('order_items').insert({order_id:order.id,product_code:importValue(row,'商品编码','product_code')||null,sku_id:sku,product_name:importValue(row,'商品名称','product_name')||null,quantity:Number(importValue(row,'商品数量','数量','quantity')||1),allocated_payment:Number(importValue(row,'分摊支付金额','allocated_payment')||payload.payment_amount),currency_code:payload.currency_code}); if(itemError)throw new Error(itemError.message); }
      else { const number=importValue(row,'结算单 ID','结算单ID','settlement_number'), date=importValue(row,'结算日期','settlement_date'), type=importValue(row,'交易类型','transaction_type'); if(!number||!date||!type)throw new Error('缺少结算单 ID、结算日期或交易类型'); const payload={shop_id:shop.id,settlement_number:number,settlement_date:date,currency_code:(importValue(row,'结算货币','币种','currency_code')||'USD').toUpperCase(),transaction_type:type,related_order_number:importValue(row,'订单 ID','订单号','related_order_number')||null,sku_id:importValue(row,'SKU ID','sku_id')||null,product_name:importValue(row,'商品名称','product_name')||null,quantity:Number(importValue(row,'数量','quantity')||0),settlement_total:Number(importValue(row,'结算总金额','settlement_total')||0),total_income:Number(importValue(row,'总收入','total_income')||0),total_fees:Number(importValue(row,'总费用','total_fees')||0),source_identifier:fileName}; if(!Number.isFinite(payload.settlement_total))throw new Error('结算总金额格式无效'); const {error}=await adminClient.from('settlement_records').upsert(payload,{onConflict:'shop_id,settlement_number,transaction_type,related_order_number,sku_id'}); if(error)throw new Error(error.message); }
      success++;
    } catch(error) { failures.push({row:index+2,reason:error.message||'数据无效'}); } }
    const { data: batch, error: batchError } = await adminClient.from('order_import_batches').insert({import_type:importType,file_name:fileName,total_rows:rows.length,success_rows:success,skipped_rows:skipped,failed_rows:failures.length,failure_summary:failures.slice(0,100),imported_by:actor.id}).select().single(); if(batchError)throw new Error('导入完成，但保存导入记录失败'); await writeAudit(actor.id,'order_import',batch.id,'import',null,{importType,fileName,totalRows:rows.length,success,failed:failures.length}); sendJson(response,200,{message:`导入完成：成功 ${success} 条，失败 ${failures.length} 条`,batch,failures});
  } catch(error){adminError(response,error)}
}
async function listOrderImportBatches(request,response){try{await requireAdministrator(request);const {rows}=await localQuery(`select id, batch_code, import_type, file_name, total_rows, success_rows, skipped_rows, failed_rows, failure_summary, created_at from public.order_import_batches order by created_at desc limit 100`);sendJson(response,200,{batches:rows})}catch(error){adminError(response,error)}}
async function listOrderImportConfiguration(request, response) {
  try {
    await requireAdministrator(request);
    const { rows: shops } = await localQuery('select id,shop_code,shop_name,country_code,currency_code from public.shops where is_active=true order by shop_name');
    sendJson(response, 200, { shops });
  } catch (error) { adminError(response, error); }
}
function normalizeImportedDateTime(value, fieldName, options = {}) {
  const raw = String(value || '').replace(/\u00a0/g, ' ').trim();
  if (!raw) return null;
  const monthNames = { jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12 };
  let normalized = raw.replace(/\s+/g, ' ');
  // 菲律宾 Seller Center 会随语言设置导出 “Oct 21, 2026 10:50 PM” 一类日期。
  const namedMonth = normalized.match(/^([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s*,?\s*(\d{4})(.*)$/i);
  if (namedMonth && monthNames[String(namedMonth[1]).toLowerCase()]) normalized = `${namedMonth[3]}-${monthNames[String(namedMonth[1]).toLowerCase()]}-${namedMonth[2]}${namedMonth[4] || ''}`;
  const match = normalized.match(/^(?:(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})|(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}))(?:[\s,T]+(\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2})(?:\.\d{1,6})?)?\s*(AM|PM)?)?(?:\s*(?:Z|UTC|GMT|[+-]\d{2}:?\d{2}))?$/i);
  if (!match) throw new Error(`${fieldName} 日期格式无效，请使用 日/月/年；菲律宾也支持 月/日/年、英文月份和 AM/PM`);
  const isYearFirst = Boolean(match[1]);
  const first = Number(match[isYearFirst ? 2 : 4]), second = Number(match[isYearFirst ? 3 : 5]);
  const preferMonthFirst = Boolean(options.preferMonthFirst);
  // PH 对 10/11 这类歧义日期优先按月/日解释；若首段大于 12，则仍安全按日/月解析。
  const monthFirst = !isYearFirst && ((preferMonthFirst && first <= 12) || (first <= 12 && second > 12));
  const year = Number(match[isYearFirst ? 1 : 6]), month = isYearFirst ? first : (monthFirst ? first : second), day = isYearFirst ? second : (monthFirst ? second : first);
  let hour = Number(match[7] || 0), minute = Number(match[8] || 0), secondValue = Number(match[9] || 0);
  const meridiem = String(match[10] || '').toUpperCase();
  if (meridiem === 'AM' && hour === 12) hour = 0;
  if (meridiem === 'PM' && hour < 12) hour += 12;
  const test = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (test.getUTCFullYear() !== year || test.getUTCMonth() !== month - 1 || test.getUTCDate() !== day || hour > 23 || minute > 59 || secondValue > 59) throw new Error(`${fieldName} 日期不存在或时间无效`);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(secondValue).padStart(2, '0')}+00:00`;
}
function orderImportRow(row, shop) {
  const orderNumber = importValue(row, 'Order ID', 'order_id', '订单ID', '订单 ID', '订单号', 'order_number');
  const skuId = importValue(row, 'SKU ID', 'sku_id');
  const dateOptions = { preferMonthFirst: String(shop.country_code || '').toUpperCase() === 'PH' };
  const orderedAt = normalizeImportedDateTime(importValue(row, 'Created Time', 'created_time', '下单日期', 'ordered_at'), 'Created Time', dateOptions);
  const amount = Number(importValue(row, 'Order Amount', 'order_amount', '支付金额', 'payment_amount') || 0);
  const refund = Number(importValue(row, 'Order Refund Amount', 'order_refund_amount', '退款金额', 'refund_amount') || 0);
  if (!orderNumber || !skuId || !orderedAt) throw new Error('缺少订单 ID、SKU ID 或下单日期');
  if (!Number.isFinite(amount) || !Number.isFinite(refund) || amount < 0 || refund < 0) throw new Error('支付金额或退款金额格式无效');
  const number = (...keys) => { const value = importValue(row, ...keys); if (!value) return null; const parsed = Number(value.replace(/,/g, '')); if (!Number.isFinite(parsed)) throw new Error(`${keys[0]} 金额格式无效`); return parsed; };
  return {
    orderNumber, skuId, orderedAt, paymentAmount: amount, refundAmount: refund,
    orderStatus: importValue(row, 'Order Status', 'order_status', '订单状态') || '待付款',
    orderSubstatus: importValue(row, 'Order Substatus', 'order_substatus') || null,
    refundStatus: importValue(row, 'Cancelation/Return Type', 'Cancellation/Return Type', 'cancellation_return_type', '退款状态') || '无退款',
    cancellationReturnType: importValue(row, 'Cancelation/Return Type', 'Cancellation/Return Type', 'cancellation_return_type', '取消/退货类型') || null,
    normalOrPreOrder: importValue(row, 'Normal or Pre-order', 'normal_or_pre_order') || null,
    sellerSku: importValue(row, 'Seller SKU', 'seller_sku') || null,
    productCode: importValue(row, 'Seller SKU', '商品编码', 'product_code') || null,
    productName: importValue(row, 'Product Name', 'product_name', '商品名称') || null,
    variation: importValue(row, 'Variation', 'variation') || null,
    quantity: Number(importValue(row, 'Quantity', 'quantity', '商品数量', '数量') || 1),
    skuQuantityOfReturn: Number(importValue(row, 'Sku Quantity of return', 'sku_quantity_of_return') || 0),
    currencyCode: (importValue(row, 'currency_code', '币种') || shop.currency_code).toUpperCase(),
    trackingNumber: importValue(row, 'Tracking ID', 'tracking_id', '快递单号', 'tracking_number') || null,
    logisticsCarrier: importValue(row, 'Shipping Provider Name', 'shipping_provider_name', '物流承运商', 'logistics_carrier') || null,
    deliveryOption: importValue(row, 'Delivery Option', 'delivery_option') || null,
    shippedAt: normalizeImportedDateTime(importValue(row, 'Shipped Time', 'shipped_time', '发货日期', 'shipped_at'), 'Shipped Time', dateOptions),
    paidAt: normalizeImportedDateTime(importValue(row, 'Paid Time', 'paid_time'), 'Paid Time', dateOptions),
    rtsAt: normalizeImportedDateTime(importValue(row, 'RTS Time', 'rts_time'), 'RTS Time', dateOptions),
    deliveredAt: normalizeImportedDateTime(importValue(row, 'Delivered Time', 'delivered_time'), 'Delivered Time', dateOptions),
    cancelledAt: normalizeImportedDateTime(importValue(row, 'Cancelled Time', 'cancelled_time'), 'Cancelled Time', dateOptions),
    sourceUpdatedAt: normalizeImportedDateTime(importValue(row, 'Updated Time', 'updated_at', '订单更新时间', '更新时间'), 'Updated Time', dateOptions),
    cancelBy: importValue(row, 'Cancel By', 'cancel_by') || null, cancelReason: importValue(row, 'Cancel Reason', 'cancel_reason') || null,
    fulfillmentType: importValue(row, 'Fulfillment Type', 'fulfillment_type') || null, warehouseName: importValue(row, 'Warehouse Name', 'warehouse_name') || null,
    buyerMessage: importValue(row, 'Buyer Message', 'buyer_message') || null, buyerUsername: importValue(row, 'Buyer Username', 'buyer_username') || null,
    recipient: importValue(row, 'Recipient', 'recipient') || null, recipientPhone: importValue(row, 'Phone #', 'recipient_phone') || null,
    destinationCountry: importValue(row, 'Country', 'country') || null, province: importValue(row, 'Province', 'province') || null, district: importValue(row, 'District', 'district') || null, commune: importValue(row, 'Commune', 'commune') || null,
    detailAddress: importValue(row, 'Detail Address', 'detail_address') || null, additionalAddressInformation: importValue(row, 'Additional address information', 'additional_address_information') || null,
    paymentMethod: importValue(row, 'Payment Method', 'payment_method') || null, packageId: importValue(row, 'Package ID', 'package_id') || null,
    sellerNote: importValue(row, 'Seller Note', 'seller_note') || null, checkedStatus: importValue(row, 'Checked Status', 'checked_status') || null, checkedMarkedBy: importValue(row, 'Checked Marked by', 'checked_marked_by') || null,
    orderChannel: importValue(row, 'Order Channel', 'order_channel') || null, creatorHandle: importValue(row, 'Creator Handle', 'creator_handle') || null,
    skuUnitOriginalPrice: number('SKU Unit Original Price', 'sku_unit_original_price'), skuSubtotalBeforeDiscount: number('SKU Subtotal Before Discount', 'sku_subtotal_before_discount'), skuPlatformDiscount: number('SKU Platform Discount', 'sku_platform_discount'), skuSellerDiscount: number('SKU Seller Discount', 'sku_seller_discount'), skuSubtotalAfterDiscount: number('SKU Subtotal After Discount', 'sku_subtotal_after_discount'), shippingFeeAfterDiscount: number('Shipping Fee After Discount', 'shipping_fee_after_discount'), originalShippingFee: number('Original Shipping Fee', 'original_shipping_fee'), shippingFeeSellerDiscount: number('Shipping Fee Seller Discount', 'shipping_fee_seller_discount'), shippingFeePlatformDiscount: number('Shipping Fee Platform Discount', 'shipping_fee_platform_discount'), paymentPlatformDiscount: number('Payment platform discount', 'payment_platform_discount'), taxes: number('Taxes', 'taxes'), weightKg: number('Weight(kg)', 'weight_kg'), productCategory: importValue(row, 'Product Category', 'product_category') || null,
    rawData: row
  };
}
function orderDuplicateDifferences(first, next) { const fields = [['支付金额','paymentAmount'],['退款金额','refundAmount'],['订单状态','orderStatus'],['物流状态','orderSubstatus'],['取消/退货类型','cancellationReturnType'],['商品编码','productCode'],['商品名称','productName'],['数量','quantity'],['下单时间','orderedAt']]; return fields.filter(([, key]) => String(first[key] ?? '') !== String(next[key] ?? '')).map(([label]) => label); }
function localOrderImportReference(batchCode, fileName) {
  return { local_archive_requested: true, import_batch_code: batchCode, source_file_name: fileName || null };
}
function orderHeaderPayload(item, shop, batchCode, fileName = null) {
  return { shop_id: shop.id, shop_code: shop.shop_code, country_code: shop.country_code, order_number: item.orderNumber, order_status: item.orderStatus, order_substatus: item.orderSubstatus, refund_status: item.refundStatus, refund_amount: item.refundAmount, payment_amount: item.paymentAmount, currency_code: item.currencyCode, tracking_number: item.trackingNumber, logistics_carrier: item.logisticsCarrier, ordered_at: item.orderedAt, paid_at: item.paidAt, rts_at: item.rtsAt, shipped_at: item.shippedAt, delivered_at: item.deliveredAt, cancelled_at: item.cancelledAt, cancel_by: item.cancelBy, cancel_reason: item.cancelReason, normal_or_pre_order: item.normalOrPreOrder, fulfillment_type: item.fulfillmentType, warehouse_name: item.warehouseName, delivery_option: item.deliveryOption, buyer_message: item.buyerMessage, buyer_username: item.buyerUsername, recipient: item.recipient, recipient_phone: item.recipientPhone, destination_country: item.destinationCountry, province: item.province, district: item.district, commune: item.commune, detail_address: item.detailAddress, additional_address_information: item.additionalAddressInformation, payment_method: item.paymentMethod, package_id: item.packageId, seller_note: item.sellerNote, checked_status: item.checkedStatus, checked_marked_by: item.checkedMarkedBy, order_channel: item.orderChannel, creator_handle: item.creatorHandle, synced_at: new Date().toISOString(), source_identifier: batchCode, raw_data: localOrderImportReference(batchCode, fileName) };
}
async function correctOrderImportDates(request, response) {
  try {
    const actor = await requireAdministrator(request); const body = await readJson(request); const batchId = String(body.batchId || ''); const mode = body.mode === 'commit' ? 'commit' : 'preview';
    if (!/^[0-9a-f-]{36}$/i.test(batchId)) throw new Error('请选择有效的订单导入批次');
    const batch = (await localQuery(`select id, batch_code, file_name, import_type from public.order_import_batches where id = $1`, [batchId])).rows[0];
    if (!batch || batch.import_type !== 'orders') throw new Error('未找到可纠错的订单导入批次');
    const sourceIdentifier = batch.batch_code || batch.file_name;
    const rows = (await localQuery(`select id, order_number, ordered_at, paid_at, rts_at, shipped_at, delivered_at, cancelled_at, raw_data from public.orders where source_identifier = $1 order by id limit 2000`, [sourceIdentifier])).rows;
    const dateFields = [['ordered_at', 'Created Time', ['Created Time', 'created_time', '下单日期', 'ordered_at']], ['paid_at', 'Paid Time', ['Paid Time', 'paid_time']], ['rts_at', 'RTS Time', ['RTS Time', 'rts_time']], ['shipped_at', 'Shipped Time', ['Shipped Time', 'shipped_time', '发货日期', 'shipped_at']], ['delivered_at', 'Delivered Time', ['Delivered Time', 'delivered_time']], ['cancelled_at', 'Cancelled Time', ['Cancelled Time', 'cancelled_time']]];
    const changes = [], failures = [];
    if (!rows.length) throw new Error('该批次没有可核对的本地订单');
    if (rows.every(order => !Object.keys(order.raw_data || {}).some(key => ['Created Time', 'created_time', '下单日期', 'ordered_at'].includes(key)))) throw new Error('该批次未保存原始 CSV 日期，无法安全纠错；请使用原 CSV 重新导入，不会覆盖现有订单。');
    rows.forEach(order => {
      const payload = {}, fields = [];
      try {
        dateFields.forEach(([column, label, keys]) => { const raw = importValue(order.raw_data || {}, ...keys); if (!raw) return; const normalized = normalizeImportedDateTime(raw, label); const current = order[column] ? new Date(order[column]).getTime() : null; if (current !== new Date(normalized).getTime()) { payload[column] = normalized; fields.push({ label, before: order[column] || '—', after: normalized }); } });
        if (fields.length) changes.push({ id: order.id, orderNumber: order.order_number, payload, fields });
      } catch (error) { failures.push({ orderNumber: order.order_number, reason: error.message || '日期格式无效' }); }
    });
    if (failures.length) return sendJson(response, 200, { valid: false, mode, batch: { id: batch.id, code: sourceIdentifier }, failures, message: '预览发现无法安全解析的原始日期，未修改任何订单。' });
    const preview = { valid: true, mode, batch: { id: batch.id, code: sourceIdentifier }, totalOrders: rows.length, changedOrders: changes.length, changedFields: changes.reduce((total, item) => total + item.fields.length, 0), changes: changes.slice(0, 50) };
    if (mode === 'preview') return sendJson(response, 200, preview);
    await withLocalTransaction(async ({ query }) => {
      for (const change of changes) await query(`update public.orders set ordered_at = coalesce($1, ordered_at), paid_at = coalesce($2, paid_at), rts_at = coalesce($3, rts_at), shipped_at = coalesce($4, shipped_at), delivered_at = coalesce($5, delivered_at), cancelled_at = coalesce($6, cancelled_at), updated_at = now() where id = $7`, [change.payload.ordered_at || null, change.payload.paid_at || null, change.payload.rts_at || null, change.payload.shipped_at || null, change.payload.delivered_at || null, change.payload.cancelled_at || null, change.id]);
    });
    await writeAudit(actor.id, 'order_import_batch', batch.id, 'correct_import_dates', null, { sourceIdentifier, changedOrders: preview.changedOrders, changedFields: preview.changedFields });
    dashboardOverviewCache.clear();
    sendJson(response, 200, { ...preview, message: changes.length ? `已修正 ${changes.length} 个订单的 ${preview.changedFields} 个日期字段。` : '该批次日期已正确，无需修改。' });
  } catch (error) { adminError(response, error); }
}
function orderItemPayload(item, orderId, batchCode = null, fileName = null) {
  return { order_id: orderId, product_code: item.productCode, sku_id: item.skuId, seller_sku: item.sellerSku, product_name: item.productName, variation: item.variation, quantity: item.quantity, sku_quantity_of_return: item.skuQuantityOfReturn, allocated_payment: item.paymentAmount, currency_code: item.currencyCode, cancellation_return_type: item.cancellationReturnType, sku_unit_original_price: item.skuUnitOriginalPrice, sku_subtotal_before_discount: item.skuSubtotalBeforeDiscount, sku_platform_discount: item.skuPlatformDiscount, sku_seller_discount: item.skuSellerDiscount, sku_subtotal_after_discount: item.skuSubtotalAfterDiscount, shipping_fee_after_discount: item.shippingFeeAfterDiscount, original_shipping_fee: item.originalShippingFee, shipping_fee_seller_discount: item.shippingFeeSellerDiscount, shipping_fee_platform_discount: item.shippingFeePlatformDiscount, payment_platform_discount: item.paymentPlatformDiscount, taxes: item.taxes, weight_kg: item.weightKg, product_category: item.productCategory, source_updated_at: item.sourceUpdatedAt, raw_data: localOrderImportReference(batchCode, fileName) };
}
function importedFieldMatches(current, next, kind) {
  if (kind === 'number') return Number(current ?? 0) === Number(next ?? 0);
  if (kind === 'time') { const currentTime = current ? new Date(current).getTime() : null; const nextTime = next ? new Date(next).getTime() : null; return currentTime === nextTime; }
  return String(current ?? '') === String(next ?? '');
}
function collectOrderImportChanges(existingOrder, existingItem, item, shop) {
  const header = orderHeaderPayload(item, shop, existingOrder.source_identifier || ''); const detail = orderItemPayload(item, existingOrder.id);
  const fields = [
    ['订单状态', 'header', 'order_status'], ['物流状态', 'header', 'order_substatus'], ['取消/退货类型', 'header', 'refund_status'], ['退款金额', 'header', 'refund_amount', 'number'], ['支付金额', 'header', 'payment_amount', 'number'], ['货币', 'header', 'currency_code'], ['快递单号', 'header', 'tracking_number'], ['物流承运商', 'header', 'logistics_carrier'], ['配送方式', 'header', 'delivery_option'], ['下单时间', 'header', 'ordered_at', 'time'], ['付款时间', 'header', 'paid_at', 'time'], ['RTS 时间', 'header', 'rts_at', 'time'], ['发货时间', 'header', 'shipped_at', 'time'], ['签收时间', 'header', 'delivered_at', 'time'], ['取消时间', 'header', 'cancelled_at', 'time'], ['取消人', 'header', 'cancel_by'], ['取消原因', 'header', 'cancel_reason'], ['预售类型', 'header', 'normal_or_pre_order'], ['履约类型', 'header', 'fulfillment_type'], ['原仓库名称', 'header', 'warehouse_name'],
    ['商品编码', 'detail', 'product_code'], ['Seller SKU', 'detail', 'seller_sku'], ['商品名称', 'detail', 'product_name'], ['规格', 'detail', 'variation'], ['数量', 'detail', 'quantity', 'number'], ['退货数量', 'detail', 'sku_quantity_of_return', 'number'], ['SKU 原价', 'detail', 'sku_unit_original_price', 'number'], ['折扣前 SKU 小计', 'detail', 'sku_subtotal_before_discount', 'number'], ['平台 SKU 折扣', 'detail', 'sku_platform_discount', 'number'], ['卖家 SKU 折扣', 'detail', 'sku_seller_discount', 'number'], ['折扣后 SKU 小计', 'detail', 'sku_subtotal_after_discount', 'number'], ['折后运费', 'detail', 'shipping_fee_after_discount', 'number'], ['原始运费', 'detail', 'original_shipping_fee', 'number'], ['卖家运费折扣', 'detail', 'shipping_fee_seller_discount', 'number'], ['平台运费折扣', 'detail', 'shipping_fee_platform_discount', 'number'], ['支付平台折扣', 'detail', 'payment_platform_discount', 'number'], ['税费', 'detail', 'taxes', 'number'], ['商品重量', 'detail', 'weight_kg', 'number'], ['商品分类', 'detail', 'product_category'], ['订单更新时间', 'detail', 'source_updated_at', 'time']
  ];
  return fields.filter(([, source, column, kind]) => !importedFieldMatches(source === 'header' ? existingOrder[column] : existingItem[column], source === 'header' ? header[column] : detail[column], kind)).map(([label]) => label);
}
async function importOrderDetailV2(request, response) {
  try {
    const actor = await requireAdministrator(request);
    const body = await readJson(request);
    const rows = Array.isArray(body.rows) ? body.rows.slice(0, 2000) : [];
    const shopId = String(body.shopId || ''); const mode = body.mode === 'commit' ? 'commit' : 'preview';
    const fileName = String(body.fileName || '订单明细.csv').slice(0, 200);
    if (!rows.length) throw new Error('文件中没有可导入的数据');
    if (!/^[0-9a-f-]{36}$/i.test(shopId)) throw new Error('请选择有效店铺简称');
    const { data: shop, error: shopError } = await adminClient.from('shops').select('id, shop_code, shop_name, country_code, currency_code').eq('id', shopId).eq('is_active', true).single();
    if (shopError || !shop) throw new Error('请选择启用中的店铺');
    const validRows = [], failures = [];
    rows.forEach((row, index) => { try { const parsed = orderImportRow(row, shop); if (!Number.isInteger(parsed.quantity) || parsed.quantity <= 0) throw new Error('商品数量必须为正整数'); validRows.push(parsed); } catch (error) { failures.push({ row: index + 2, reason: error.message || '数据无效' }); } });
    const duplicateInFile = new Set(); const seen = new Set();
    validRows.forEach((item, index) => { const key = `${item.orderNumber}::${item.skuId}`; if (seen.has(key)) duplicateInFile.add(index); seen.add(key); });
    duplicateInFile.forEach(index => failures.push({ row: index + 2, reason: '文件内存在重复的订单 ID + SKU ID' }));
    if (failures.length) return sendJson(response, 200, { valid: false, mode, totalRows: rows.length, failures, message: '校验未通过：请修正失败行后重新上传，系统未写入任何数据。' });
    const orderNumbers = [...new Set(validRows.map(item => item.orderNumber))];
    const existingOrders = await collectBillQueryChunks(orderNumbers, chunk => adminClient.from('orders').select('id, order_number').eq('shop_id', shop.id).in('order_number', chunk), '读取已有订单失败');
    const orderByNumber = new Map((existingOrders || []).map(item => [item.order_number, item]));
    const existingIds = [...orderByNumber.values()].map(item => item.id);
    const existingItems = existingIds.length ? await collectBillQueryChunks(existingIds, chunk => adminClient.from('order_items').select('id, order_id, sku_id, cancellation_return_type').in('order_id', chunk), '读取已有订单明细失败') : [];
    const itemByIdentity = new Map((existingItems || []).map(item => [`${[...orderByNumber.entries()].find(([, order]) => order.id === item.order_id)?.[0]}::${item.sku_id}`, item]));
    let insertCount = 0, updateCount = 0, skipCount = 0;
    validRows.forEach(item => { const existing = itemByIdentity.get(`${item.orderNumber}::${item.skuId}`); if (!existing) insertCount++; else if ((existing.cancellation_return_type || '') !== (item.cancellationReturnType || '')) updateCount++; else skipCount++; });
    const prefix = `IMP-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
    const { data: todayBatches } = await adminClient.from('order_import_batches').select('batch_code').like('batch_code', `${prefix}%`);
    const batchCode = `${prefix}-${String((todayBatches || []).length + 1).padStart(3, '0')}`;
    const preview = { valid: true, mode, batchCode, shop: { id: shop.id, code: shop.shop_code, name: shop.shop_name, countryCode: shop.country_code, currencyCode: shop.currency_code }, totalRows: rows.length, insertCount, updateCount, skipCount, failureCount: 0 };
    if (mode === 'preview') return sendJson(response, 200, preview);
    for (const item of validRows) {
      const identity = `${item.orderNumber}::${item.skuId}`; const existing = itemByIdentity.get(identity);
      if (existing && (existing.cancellation_return_type || '') === (item.cancellationReturnType || '')) continue;
      let order = orderByNumber.get(item.orderNumber);
      if (!order) {
        const { data, error } = await adminClient.from('orders').insert(orderHeaderPayload(item, shop, batchCode)).select('id, order_number').single();
        if (error) throw new Error(`保存订单 ${item.orderNumber} 失败`); order = data; orderByNumber.set(item.orderNumber, data);
      } else if (existing) {
        const { shop_id, order_number, ...updatePayload } = orderHeaderPayload(item, shop, batchCode);
        const { error } = await adminClient.from('orders').update(updatePayload).eq('id', order.id);
        if (error) throw new Error(`更新订单 ${item.orderNumber} 失败`);
      }
      const { error } = await adminClient.from('order_items').upsert(orderItemPayload(item, order.id), { onConflict: 'order_id,sku_id' });
      if (error) throw new Error(`保存订单 ${item.orderNumber} / ${item.skuId} 失败`);
    }
    const { data: batch, error: batchError } = await adminClient.from('order_import_batches').insert({ batch_code: batchCode, import_type: 'orders', file_name: fileName, shop_id: shop.id, country_code: shop.country_code, currency_code: shop.currency_code, total_rows: rows.length, success_rows: insertCount + updateCount, updated_rows: updateCount, skipped_rows: skipCount, failed_rows: 0, failure_summary: [], validation_status: 'completed', imported_by: actor.id }).select().single();
    if (batchError) throw new Error('订单已写入，但保存导入批次失败');
    await writeAudit(actor.id, 'order_import', batch.id, 'commit_order_import', null, { ...preview, batchCode });
    sendJson(response, 200, { ...preview, batch, message: `导入完成：新增 ${insertCount} 条，更新 ${updateCount} 条，跳过 ${skipCount} 条。` });
  } catch (error) { adminError(response, error); }
}
async function importOrderDetailV3(request, response) {
  try {
    const actor = await requireAdministrator(request);
    const body = await readJson(request, ORDER_IMPORT_MAX_PAYLOAD_BYTES); const rows = Array.isArray(body.rows) ? body.rows : [];
    if (localDatabaseEnabled()) return importOrderDetailV3Local(actor, body, rows, response);
    const shopId = String(body.shopId || ''); const mode = body.mode === 'commit' ? 'commit' : 'preview'; const fileName = String(body.fileName || '订单明细.csv').slice(0, 200);
    if (!rows.length) throw new Error('文件中没有可导入的数据'); if (rows.length > ORDER_IMPORT_MAX_ROWS) throw new Error(`单次订单导入最多支持 ${ORDER_IMPORT_MAX_ROWS.toLocaleString()} 行，请拆分文件后重试`);
    if (!/^[0-9a-f-]{36}$/i.test(shopId)) throw new Error('请选择有效店铺简称');
    const { data: shop, error: shopError } = await adminClient.from('shops').select('id, shop_code, shop_name, country_code, currency_code').eq('id', shopId).eq('is_active', true).single();
    if (shopError || !shop) throw new Error('请选择启用中的店铺');
    const validRows = [], failures = [], firstByIdentity = new Map(); let duplicateSkipped = 0;
    rows.forEach((row, index) => {
      try {
        const item = orderImportRow(row, shop); const key = `${item.orderNumber}::${item.skuId}`;
        if (!Number.isInteger(item.quantity) || item.quantity <= 0) throw new Error('Quantity 必须为正整数');
        const first = firstByIdentity.get(key); if (first) { const differences = orderDuplicateDifferences(first.item, item); if (!differences.length) { duplicateSkipped++; return; } throw new Error(`文件内存在相同 Order ID + SKU ID，但字段不一致：${differences.join('、')}`); }
        firstByIdentity.set(key, { item, row: index + 2 }); validRows.push(item);
      } catch (error) { failures.push({ row: index + 2, reason: error.message || '数据无效' }); }
    });
    if (failures.length) return sendJson(response, 200, { valid: false, mode, totalRows: rows.length, failures, message: '校验未通过：请修正失败行后重新上传，系统未写入任何数据。' });
    const numbers = [...new Set(validRows.map(item => item.orderNumber))];
    const existingOrders = await collectBillQueryChunks(numbers, chunk => adminClient.from('orders').select('*').eq('shop_id', shop.id).in('order_number', chunk), '读取已有订单失败');
    const orderByNumber = new Map((existingOrders || []).map(item => [item.order_number, item])); const numberByOrderId = new Map((existingOrders || []).map(item => [item.id, item.order_number]));
    const ids = [...numberByOrderId.keys()]; const existingItems = ids.length ? await collectBillQueryChunks(ids, chunk => adminClient.from('order_items').select('*').in('order_id', chunk), '读取已有订单明细失败') : [];
    const itemByIdentity = new Map((existingItems || []).map(item => [`${numberByOrderId.get(item.order_id)}::${item.sku_id}`, item]));
    const toWrite = [], headerByNumber = new Map(), changeDetails = []; let insertCount = 0, updateCount = 0, skipCount = 0;
    validRows.forEach(item => { const current = itemByIdentity.get(`${item.orderNumber}::${item.skuId}`); const existingOrder = orderByNumber.get(item.orderNumber); if (!current) { insertCount++; toWrite.push(item); headerByNumber.set(item.orderNumber, item); } else { const changedFields = collectOrderImportChanges(existingOrder, current, item, shop); if (changedFields.length) { updateCount++; toWrite.push(item); headerByNumber.set(item.orderNumber, item); changeDetails.push({ orderNumber: item.orderNumber, skuId: item.skuId, fields: changedFields }); } else skipCount++; } });
    const prefix = `IMP-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
    const { data: todayBatches, error: codeError } = await adminClient.from('order_import_batches').select('batch_code').like('batch_code', `${prefix}%`);
    if (codeError) throw new Error('生成导入批次失败');
    const batchCode = `${prefix}-${String((todayBatches || []).length + 1).padStart(3, '0')}`;
    const preview = { valid: true, mode, batchCode, shop: { id: shop.id, code: shop.shop_code, name: shop.shop_name, countryCode: shop.country_code, currencyCode: shop.currency_code }, totalRows: rows.length, insertCount, updateCount, skipCount: skipCount + duplicateSkipped, duplicateSkipped, failureCount: 0, changeDetails: changeDetails.slice(0, 50) };
    if (mode === 'preview') return sendJson(response, 200, preview);
    const { data: batch, error: batchError } = await adminClient.from('order_import_batches').insert({ batch_code: batchCode, import_type: 'orders', file_name: fileName, shop_id: shop.id, country_code: shop.country_code, currency_code: shop.currency_code, total_rows: rows.length, success_rows: 0, updated_rows: 0, skipped_rows: skipCount, failed_rows: 0, failure_summary: [], validation_status: 'processing', rollback_expires_at: rollbackExpiry(), imported_by: actor.id }).select().single();
    if (batchError) throw new Error('创建导入批次失败，请重新校验后再导入');
    try {
      const headers = [...headerByNumber.values()].map(item => orderHeaderPayload(item, shop, batchCode, fileName));
      const headerPayloadByNumber = new Map(headers.map(item => [item.order_number, item]));
      for (let offset = 0; offset < headers.length; offset += 200) { const { error } = await adminClient.from('orders').upsert(headers.slice(offset, offset + 200), { onConflict: 'shop_id,order_number' }); if (error) throw new Error(`保存订单失败：${error.message}`); }
      const writtenOrders = await collectBillQueryChunks([...headerByNumber.keys()], chunk => adminClient.from('orders').select('id, order_number').eq('shop_id', shop.id).in('order_number', chunk), '读取写入后的订单失败');
      const writtenByNumber = new Map((writtenOrders || []).map(item => [item.order_number, item.id]));
      if (toWrite.length) { const itemRows = toWrite.map(item => orderItemPayload(item, writtenByNumber.get(item.orderNumber), batchCode, fileName)); if (itemRows.some(item => !item.order_id)) throw new Error('订单行关联失败'); for (let offset = 0; offset < itemRows.length; offset += 200) { const { error } = await adminClient.from('order_items').upsert(itemRows.slice(offset, offset + 200), { onConflict: 'order_id,sku_id' }); if (error) throw new Error(`保存 SKU 明细失败：${error.message}`); } }
      const writtenOrderIds = [...writtenByNumber.values()];
      const writtenItems = writtenOrderIds.length ? await collectBillQueryChunks(writtenOrderIds, chunk => adminClient.from('order_items').select('*').in('order_id', chunk), '读取写入后的订单明细失败') : [];
      const writtenItemByIdentity = new Map((writtenItems || []).map(item => [`${numberByOrderId.get(item.order_id) || [...writtenByNumber.entries()].find(([, id]) => id === item.order_id)?.[0]}::${item.sku_id}`, item]));
      const compactSnapshot = record => { if (!record) return null; const { raw_data, ...data } = record; return data; };
      const rollbackChanges = toWrite.map(item => {
        const orderId = writtenByNumber.get(item.orderNumber), existingOrder = orderByNumber.get(item.orderNumber), existingItem = itemByIdentity.get(`${item.orderNumber}::${item.skuId}`), writtenItem = writtenItemByIdentity.get(`${item.orderNumber}::${item.skuId}`), header = headerPayloadByNumber.get(item.orderNumber);
        if (!orderId || !writtenItem || !header) return null;
        return { batch_id: batch.id, order_id: orderId, order_item_id: writtenItem.id, operation: existingItem ? 'update' : 'insert', before_order: compactSnapshot(existingOrder), after_order: compactSnapshot({ ...header, id: orderId }), before_item: compactSnapshot(existingItem), after_item: compactSnapshot(writtenItem) };
      }).filter(Boolean);
      for (let offset = 0; offset < rollbackChanges.length; offset += 25) { const { error } = await adminClient.from('order_import_changes').insert(rollbackChanges.slice(offset, offset + 25)); if (error) throw new Error(`保存订单回滚快照失败：${error.message || '数据库写入失败'}`); }
      const { error: completeError } = await adminClient.from('order_import_batches').update({ success_rows: insertCount + updateCount, updated_rows: updateCount, skipped_rows: skipCount, validation_status: 'completed' }).eq('id', batch.id);
      if (completeError) throw new Error('更新导入批次状态失败');
      const purgedRollbackSnapshots = await purgeExpiredImportRollbackSnapshots();
      await writeAudit(actor.id, 'order_import', batch.id, 'commit_order_import', null, { ...preview, batchCode, rollbackExpiresAt: batch.rollback_expires_at, purgedRollbackSnapshots });
      dashboardOverviewCache.clear();
      sendJson(response, 200, { ...preview, batch: { ...batch, validation_status: 'completed' }, purgedRollbackSnapshots, message: `导入完成：新增 ${insertCount} 条，更新 ${updateCount} 条，跳过 ${skipCount} 条。` });
    } catch (error) {
      await adminClient.from('order_import_batches').update({ validation_status: 'partial', failure_summary: [{ reason: error.message || '写入中断' }] }).eq('id', batch.id);
      throw error;
    }
  } catch (error) { adminError(response, error); }
}
async function importOrderDetailV3Local(actor, body, rows, response) {
  const shopId = String(body.shopId || ''), mode = body.mode === 'commit' ? 'commit' : 'preview', fileName = String(body.fileName || '订单明细.csv').slice(0, 200);
  if (!rows.length) throw new Error('文件中没有可导入的数据');
  if (rows.length > ORDER_IMPORT_MAX_ROWS) throw new Error(`单次订单导入最多支持 ${ORDER_IMPORT_MAX_ROWS.toLocaleString()} 行，请拆分文件后重试`);
  if (!/^[0-9a-f-]{36}$/i.test(shopId)) throw new Error('请选择有效店铺简称');
  const shop = (await localQuery(`select id, shop_code, shop_name, country_code, currency_code from public.shops where id = $1 and is_active = true`, [shopId])).rows[0];
  if (!shop) throw new Error('请选择启用中的店铺');
  const validRows = [], failures = [], firstByIdentity = new Map(); let duplicateSkipped = 0;
  rows.forEach((row, index) => {
    try {
      const item = orderImportRow(row, shop), key = `${item.orderNumber}::${item.skuId}`;
      if (!Number.isInteger(item.quantity) || item.quantity <= 0) throw new Error('Quantity 必须为正整数');
      const first = firstByIdentity.get(key);
      if (first) { const differences = orderDuplicateDifferences(first.item, item); if (!differences.length) { duplicateSkipped++; return; } throw new Error(`文件内存在相同 Order ID + SKU ID，但字段不一致：${differences.join('、')}`); }
      firstByIdentity.set(key, { item, row: index + 2 }); validRows.push(item);
    } catch (error) { failures.push({ row: index + 2, reason: error.message || '数据无效' }); }
  });
  if (failures.length) return sendJson(response, 200, { valid: false, mode, totalRows: rows.length, failures, message: '校验未通过：请修正失败行后重新上传，系统未写入任何数据。' });
  const numbers = [...new Set(validRows.map(item => item.orderNumber))];
  const existingOrders = (await localQuery(`select * from public.orders where shop_id = $1 and order_number = any($2::text[])`, [shop.id, numbers])).rows;
  const orderByNumber = new Map(existingOrders.map(item => [item.order_number, item])), numberByOrderId = new Map(existingOrders.map(item => [item.id, item.order_number]));
  const existingIds = [...numberByOrderId.keys()];
  const existingItems = existingIds.length ? (await localQuery(`select * from public.order_items where order_id = any($1::uuid[])`, [existingIds])).rows : [];
  const itemByIdentity = new Map(existingItems.map(item => [`${numberByOrderId.get(item.order_id)}::${item.sku_id}`, item]));
  const toWrite = [], headerByNumber = new Map(), changeDetails = []; let insertCount = 0, updateCount = 0, skipCount = 0;
  validRows.forEach(item => { const current = itemByIdentity.get(`${item.orderNumber}::${item.skuId}`), existingOrder = orderByNumber.get(item.orderNumber); if (!current) { insertCount++; toWrite.push(item); headerByNumber.set(item.orderNumber, item); } else { const changedFields = collectOrderImportChanges(existingOrder, current, item, shop); if (changedFields.length) { updateCount++; toWrite.push(item); headerByNumber.set(item.orderNumber, item); changeDetails.push({ orderNumber: item.orderNumber, skuId: item.skuId, fields: changedFields }); } else skipCount++; } });
  const prefix = `IMP-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
  const batchRows = (await localQuery(`select batch_code from public.order_import_batches where batch_code like $1`, [`${prefix}%`])).rows;
  const batchCode = `${prefix}-${String(batchRows.length + 1).padStart(3, '0')}`;
  const preview = { valid: true, mode, batchCode, shop: { id: shop.id, code: shop.shop_code, name: shop.shop_name, countryCode: shop.country_code, currencyCode: shop.currency_code }, totalRows: rows.length, insertCount, updateCount, skipCount: skipCount + duplicateSkipped, duplicateSkipped, failureCount: 0, changeDetails: changeDetails.slice(0, 50) };
  if (mode === 'preview') return sendJson(response, 200, preview);
  const batch = await withLocalTransaction(async ({ query }) => {
    const createdBatch = (await query(`insert into public.order_import_batches (batch_code, import_type, file_name, shop_id, country_code, currency_code, total_rows, success_rows, updated_rows, skipped_rows, failed_rows, failure_summary, validation_status, rollback_expires_at, imported_by) values ($1,'orders',$2,$3,$4,$5,$6,0,0,$7,0,'[]'::jsonb,'processing',now() + interval '30 days',$8) returning *`, [batchCode, fileName, shop.id, shop.country_code, shop.currency_code, rows.length, skipCount, actor.id])).rows[0];
    const writtenByNumber = new Map();
    for (const item of headerByNumber.values()) {
      const header = orderHeaderPayload(item, shop, batchCode, fileName);
      const written = await localUpsert(query, 'public.orders', header, ['shop_id', 'order_number']);
      if (!written) throw new Error(`保存订单 ${item.orderNumber} 失败`);
      writtenByNumber.set(item.orderNumber, written);
    }
    const snapshots = [];
    for (const item of toWrite) {
      const order = writtenByNumber.get(item.orderNumber) || orderByNumber.get(item.orderNumber);
      if (!order) throw new Error('订单行关联失败');
      const detail = orderItemPayload(item, order.id, batchCode, fileName);
      const writtenItem = await localUpsert(query, 'public.order_items', detail, ['order_id', 'sku_id']);
      const existingOrder = orderByNumber.get(item.orderNumber) || null, existingItem = itemByIdentity.get(`${item.orderNumber}::${item.skuId}`) || null;
      snapshots.push({ order, writtenItem, existingOrder, existingItem });
    }
    for (const row of snapshots) {
      await query(`insert into public.order_import_changes (batch_id, order_id, order_item_id, operation, before_order, after_order, before_item, after_item) values ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb)`, [createdBatch.id, row.order.id, row.writtenItem.id, row.existingItem ? 'update' : 'insert', row.existingOrder ? JSON.stringify(row.existingOrder) : null, JSON.stringify(row.order), row.existingItem ? JSON.stringify(row.existingItem) : null, JSON.stringify(row.writtenItem)]);
    }
    await query(`update public.order_import_batches set success_rows=$1, updated_rows=$2, skipped_rows=$3, validation_status='completed' where id=$4`, [insertCount + updateCount, updateCount, skipCount, createdBatch.id]);
    await query(`insert into public.audit_logs (actor_id, entity_type, entity_id, action, before_data, after_data) values ($1,'order_import',$2,'commit_order_import',null,$3::jsonb)`, [actor.id, createdBatch.id, JSON.stringify({ ...preview, rollbackExpiresAt: createdBatch.rollback_expires_at })]);
    return { ...createdBatch, validation_status: 'completed' };
  });
  dashboardOverviewCache.clear();
  return sendJson(response, 200, { ...preview, batch, message: `导入完成：新增 ${insertCount} 条，更新 ${updateCount} 条，跳过 ${skipCount} 条。` });
}
async function updateWarehouse(request, response) {
  try {
    const actor = await requireAdministrator(request);
    const body = await readJson(request);
    const warehouseId = String(body.warehouseId || '');
    const name = String(body.name || '').trim(); const originalWarehouseName = String(body.originalWarehouseName || '').trim() || null; const deliveryOption = String(body.deliveryOption || '').trim() || null; const shippingProviderName = String(body.shippingProviderName || '').trim() || null;
    const countryCode = String(body.countryCode || '').trim().toUpperCase() || null;
    const isActive = body.isActive !== false;
    const countryCodes = normaliseCountryCodes(body.countryCodes, countryCode);
    const hasCostUpdate = body.amount !== undefined && body.amount !== null && body.amount !== '';
    const amount = Number(body.amount);
    const billingUnit = body.billingUnit === '每包裹' ? 'per_package' : 'per_order';
    const effectiveDate = String(body.effectiveDate || '');
    const note = String(body.note || '').trim();
    if (!/^[0-9a-f-]{36}$/i.test(warehouseId) || !name || name.length > 80 || (hasCostUpdate && (!Number.isFinite(amount) || amount < 0 || !/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)))) throw new Error('请填写有效的仓库名称、人民币代发费用和生效日期');
    if (localDatabaseEnabled()) {
      await withLocalTransaction(async ({ query }) => {
        const before = (await query(`select id,name,country_code,is_active,original_warehouse_name,delivery_option,shipping_provider_name from public.warehouses where id=$1 for update`, [warehouseId])).rows[0];
        if (!before) throw new Error('未找到该仓库');
        if (before.is_active && !isActive) {
          const activeLink = (await query(`select 1 from public.shop_warehouses sw join public.shops s on s.id=sw.shop_id where sw.warehouse_id=$1 and s.is_active=true limit 1`, [warehouseId])).rows[0];
          if (activeLink) throw new Error('该仓库仍关联启用中的店铺，请先在店铺管理中调整关联仓库后再停用');
        }
        if (countryCodes.length) { const valid = (await query(`select code from public.country_sites where code=any($1::text[])`, [countryCodes])).rows; if (valid.length !== countryCodes.length) throw new Error('存在无效国家站点，请刷新后重试'); }
        try { await query(`update public.warehouses set name=$1,original_warehouse_name=$2,country_code=$3,delivery_option=$4,shipping_provider_name=$5,is_active=$6 where id=$7`, [name,originalWarehouseName,countryCode,deliveryOption,shippingProviderName,isActive,warehouseId]); }
        catch (error) { if (error.code === '23505') throw new Error('该仓库名称已存在'); throw error; }
        if (hasCostUpdate) await query(`insert into public.warehouse_cost_versions (warehouse_id,amount,currency_code,billing_unit,effective_date,note,created_by) values ($1,$2,'CNY',$3,$4,$5,$6)`, [warehouseId,amount,billingUnit,effectiveDate,note,actor.id]);
        if (countryCodes.length) { await query(`delete from public.warehouse_country_sites where warehouse_id=$1`, [warehouseId]); for (const code of countryCodes) await query(`insert into public.warehouse_country_sites (warehouse_id,country_code) values ($1,$2)`, [warehouseId,code]); }
        await query(`insert into public.audit_logs (actor_id,entity_type,entity_id,action,before_data,after_data) values ($1,'warehouse',$2,'update_configuration',$3::jsonb,$4::jsonb)`, [actor.id,warehouseId,JSON.stringify(before),JSON.stringify({name,countryCode,isActive,originalWarehouseName,deliveryOption,shippingProviderName,...(hasCostUpdate?{amount,currencyCode:'CNY',billingUnit,effectiveDate,note}:{})})]);
      });
      dashboardOverviewCache.clear(); return sendJson(response,200,{message:'仓库资料已保存'});
    }
    const { data: before, error: findError } = await adminClient.from('warehouses').select('id, name, country_code, is_active').eq('id', warehouseId).single();
    if (findError || !before) throw new Error('未找到该仓库');
    if (before.is_active && !isActive) {
      const { data: warehouseLinks, error: linkError } = await adminClient.from('shop_warehouses').select('shop_id').eq('warehouse_id', warehouseId);
      if (linkError) throw new Error('检查仓库关联店铺失败');
      if (warehouseLinks.length) {
        const { data: activeShops, error: activeShopsError } = await adminClient.from('shops').select('id').eq('is_active', true).in('id', warehouseLinks.map(link => link.shop_id));
        if (activeShopsError) throw new Error('检查仓库关联店铺失败');
        if (activeShops.length) throw new Error('该仓库仍关联启用中的店铺，请先在店铺管理中调整关联仓库后再停用');
      }
    }
    const { error: updateError } = hasCostUpdate
      ? await adminClient.rpc('update_warehouse_with_cost_version', { p_warehouse_id: warehouseId, p_name: name, p_country_code: countryCode, p_is_active: isActive, p_amount: amount, p_billing_unit: billingUnit, p_effective_date: effectiveDate, p_note: note, p_created_by: actor.id })
      : await adminClient.from('warehouses').update({ name, original_warehouse_name: originalWarehouseName, country_code: countryCode, delivery_option: deliveryOption, shipping_provider_name: shippingProviderName, is_active: isActive }).eq('id', warehouseId);
    if (updateError) throw new Error(updateError.code === '23505' ? '该仓库名称已存在' : '保存仓库及费用版本失败');
    if (hasCostUpdate) { const { error: deliveryError } = await adminClient.from('warehouses').update({ original_warehouse_name: originalWarehouseName, delivery_option: deliveryOption, shipping_provider_name: shippingProviderName }).eq('id', warehouseId); if (deliveryError) throw new Error('保存仓库映射字段失败'); }
    if (countryCodes.length) await replaceWarehouseCountrySites(warehouseId, countryCodes);
    await writeAudit(actor.id, 'warehouse', warehouseId, 'update_configuration', before, { name, countryCode, isActive, ...(hasCostUpdate ? { amount, currencyCode: 'CNY', billingUnit, effectiveDate, note } : {}) });
    dashboardOverviewCache.clear();
    sendJson(response, 200, { message: '仓库资料已保存' });
  } catch (error) { adminError(response, error); }
}
async function listProductManagementData(request, response) {
  try {
    await requireAdministrator(request);
    const [productResult, warehouseResult, costVersionResult] = await Promise.all([
      localQuery(`select id, warehouse_id, product_code, product_name, image_url, sale_price, currency_code, status, created_at, updated_at from public.products order by updated_at desc`),
      localQuery(`select id, name, country_code, is_active from public.warehouses order by name`),
      localQuery(`select id, product_id, effective_date, created_at from public.product_cost_versions order by effective_date desc, created_at desc`)
    ]);
    const products = productResult.rows, warehouses = warehouseResult.rows, costVersions = costVersionResult.rows;
    const latestCostVersionByProduct = new Map();
    costVersions.forEach(version => { if (!latestCostVersionByProduct.has(version.product_id)) latestCostVersionByProduct.set(version.product_id, version); });
    sendJson(response, 200, { products: products.map(product => ({ ...product, effective_date: latestCostVersionByProduct.get(product.id)?.effective_date || null })), warehouses });
  } catch (error) { adminError(response, error); }
}
function productCostEffectiveDate(value) {
  const date = String(value || '').trim();
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('商品成本生效日期格式无效');
  return date || '2026-08-01';
}
async function appendProductCostVersion(product, effectiveDate, actorId) {
  const { error } = await adminClient.from('product_cost_versions').insert({
    product_id: product.id,
    warehouse_id: product.warehouse_id,
    product_code: product.product_code,
    amount: product.sale_price,
    currency_code: product.currency_code,
    effective_date: effectiveDate,
    created_by: actorId
  });
  if (error) throw new Error('保存商品成本版本失败');
}
async function createProduct(request, response) {
  try {
    const actor = await requireAdministrator(request);
    const body = await readJson(request);
    const warehouseId = String(body.warehouseId || '');
    const productCode = String(body.productCode || '').trim();
    const productName = String(body.productName || '').trim();
    const salePrice = Number(body.salePrice);
    const currencyCode = String(body.currencyCode || '').trim().toUpperCase();
    const status = String(body.status || 'pending_review');
    const effectiveDate = productCostEffectiveDate(body.effectiveDate);
    const imageUrl = normaliseImageUrl(body.imageUrl);
    if (!/^[0-9a-f-]{36}$/i.test(warehouseId) || !productCode || productCode.length > 100 || !productName || productName.length > 200 || !Number.isFinite(salePrice) || salePrice < 0 || currencyCode !== 'CNY' || !['pending_review', 'approved', 'rejected', 'disabled'].includes(status)) throw new Error('请完整填写商品编码、名称、人民币单价、仓库和状态');
    if (localDatabaseEnabled()) {
      const warehouse = (await localQuery(`select id from public.warehouses where id = $1 and is_active = true`, [warehouseId])).rows[0];
      if (!warehouse) throw new Error('请选择启用中的仓库');
      const reviewData = ['approved', 'rejected'].includes(status) ? { reviewed_by: actor.id, reviewed_at: new Date().toISOString() } : { reviewed_by: null, reviewed_at: null };
      const data = await withLocalTransaction(async ({ query }) => {
        let product;
        try {
          product = (await query(
            `insert into public.products (warehouse_id, product_code, product_name, image_url, sale_price, currency_code, status, created_by, reviewed_by, reviewed_at)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
            [warehouseId, productCode, productName, imageUrl, salePrice, currencyCode, status, actor.id, reviewData.reviewed_by, reviewData.reviewed_at]
          )).rows[0];
        } catch (error) {
          if (error.code === '23505') throw new Error('该仓库中已存在相同商品编码');
          throw error;
        }
        await query(`insert into public.product_cost_versions (product_id, warehouse_id, product_code, amount, currency_code, effective_date, created_by) values ($1,$2,$3,$4,$5,$6,$7)`, [product.id, product.warehouse_id, product.product_code, product.sale_price, product.currency_code, effectiveDate, actor.id]);
        await query(`insert into public.audit_logs (actor_id, entity_type, entity_id, action, before_data, after_data) values ($1,'product',$2,'create',null,$3::jsonb)`, [actor.id, product.id, JSON.stringify(product)]);
        return product;
      });
      dashboardOverviewCache.clear(); return sendJson(response, 201, { product: data });
    }
    const { data: warehouse, error: warehouseError } = await adminClient.from('warehouses').select('id').eq('id', warehouseId).eq('is_active', true).maybeSingle();
    if (warehouseError || !warehouse) throw new Error('请选择启用中的仓库');
    const reviewData = ['approved', 'rejected'].includes(status) ? { reviewed_by: actor.id, reviewed_at: new Date().toISOString() } : {};
    const { data, error } = await adminClient.from('products').insert({ warehouse_id: warehouseId, product_code: productCode, product_name: productName, image_url: imageUrl, sale_price: salePrice, currency_code: currencyCode, status, created_by: actor.id, ...reviewData }).select().single();
    if (error) throw new Error(error.code === '23505' ? '该仓库中已存在相同商品编码' : '新增商品失败');
    await appendProductCostVersion(data, effectiveDate, actor.id);
    await writeAudit(actor.id, 'product', data.id, 'create', null, data);
    dashboardOverviewCache.clear();
    sendJson(response, 201, { product: data });
  } catch (error) { adminError(response, error); }
}
function parseCsvRows(text) {
  const records = []; let row = [], cell = '', quoted = false;
  const pushCell = () => { row.push(cell); cell = ''; };
  const pushRow = () => { if (row.some(value => String(value).trim())) records.push(row.map(value => String(value).trim())); row = []; };
  for (let index = 0; index < String(text || '').length; index++) {
    const char = text[index], next = text[index + 1];
    if (char === '"' && quoted && next === '"') { cell += '"'; index++; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (char === ',' && !quoted) { pushCell(); continue; }
    if ((char === '\n' || char === '\r') && !quoted) { if (char === '\r' && next === '\n') index++; pushCell(); pushRow(); continue; }
    cell += char;
  }
  pushCell(); pushRow();
  if (quoted) throw new Error('CSV 引号未闭合，请检查文件格式');
  return records;
}
async function parseProductImportRows(fileBase64, fileName) {
  const raw = String(fileBase64 || '').replace(/^data:[^,]+,/, '');
  if (!raw) return [];
  const isExcel = /\.xlsx$/i.test(String(fileName || ''));
  let matrix = [];
  if (isExcel) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(raw, 'base64'));
    const sheet = workbook.worksheets[0];
    if (!sheet) throw new Error('Excel 文件中没有工作表');
    sheet.eachRow({ includeEmpty: false }, row => matrix.push(row.values.slice(1).map(value => String(value ?? '').trim())));
  } else {
    const bytes = Buffer.from(raw, 'base64');
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { text = new TextDecoder('gbk').decode(bytes); }
    matrix = parseCsvRows(text);
  }
  if (matrix.length < 2) return [];
  const required = ['product_code', 'product_name', 'sale_price'];
  const headerRowIndex = matrix.findIndex(row => {
    const headers = row.map(value => String(value || '').replace(/^\uFEFF/, '').trim());
    return required.every(field => headers.includes(field));
  });
  if (headerRowIndex < 0) throw new Error(`缺少英文表头：${required.join('、')}`);
  const headers = matrix[headerRowIndex].map(value => String(value || '').replace(/^\uFEFF/, '').trim());
  return matrix.slice(headerRowIndex + 1).filter(row => row.some(value => String(value || '').trim())).map((row, index) => Object.assign({ _rowNumber: headerRowIndex + index + 2 }, Object.fromEntries(headers.map((header, column) => [header, String(row[column] ?? '').trim()]))));
}
function productImportStatus(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return ({ '': 'pending_review', active: 'approved', approved: 'approved', available: 'approved', enabled: 'approved', normal: 'approved', '可用': 'approved', '启用': 'approved', '已启用': 'approved', '正常': 'approved', '上架': 'approved', '已上架': 'approved', '在售': 'approved', inactive: 'disabled', disabled: 'disabled', off: 'disabled', '已停用': 'disabled', '停用': 'disabled', '禁用': 'disabled', '已禁用': 'disabled', '下架': 'disabled', pending: 'pending_review', pending_review: 'pending_review', '待审核': 'pending_review', '待审': 'pending_review', '待处理': 'pending_review', rejected: 'rejected', '已驳回': 'rejected' })[normalized] || null;
}
function productImportPrice(value) {
  const source = String(value ?? '').trim();
  if (!source) return Number.NaN;
  const normalized = source.replace(/,/g, '').replace(/^(?:CNY|RMB)\s*/i, '').replace(/^[¥￥$]\s*/, '').replace(/\s*(?:元|CNY|RMB)$/i, '').trim();
  return Number(normalized);
}
async function importProducts(request, response) {
  try {
    const actor = await requireAdministrator(request); const body = await readJson(request);
    const parsedRows = Array.isArray(body.rows) ? body.rows : await parseProductImportRows(body.fileBase64, body.fileName);
    const rows = parsedRows.slice(0, 5000); const mode = body.mode === 'commit' ? 'commit' : 'preview';
    if (!rows.length) throw new Error('文件中没有商品数据');
    if (parsedRows.length > 5000) throw new Error('单次商品导入最多支持 5,000 行，请拆分文件后重试');
    const warehouseId = String(body.warehouseId || '');
    if (!/^[0-9a-f-]{36}$/i.test(warehouseId)) throw new Error('请选择启用中的仓库');
    const localWarehouse = localDatabaseEnabled() ? (await localQuery(`select id, name from public.warehouses where id = $1 and is_active = true`, [warehouseId])).rows[0] : null;
    const { data: remoteWarehouse, error: warehouseError } = localDatabaseEnabled()
      ? { data: null, error: null }
      : await adminClient.from('warehouses').select('id,name').eq('id', warehouseId).eq('is_active', true).maybeSingle();
    const warehouse = localWarehouse || remoteWarehouse;
    if (warehouseError || !warehouse) throw new Error('请选择启用中的仓库');
    const payloads = [], failures = [], duplicateRows = [], payloadIndexByIdentity = new Map();
    rows.forEach((row, index) => {
      const code = String(row.product_code || '').trim();
      const name = String(row.product_name || '').trim(); const price = productImportPrice(row.sale_price);
      const status = productImportStatus(row.status); const identity = `${warehouse.id}::${code}`;
      const rowNumber = row._rowNumber || index + 2;
      let effectiveDate = ''; let effectiveDateError = '';
      try { effectiveDate = productCostEffectiveDate(row.effective_date || row.effectiveDate); } catch (error) { effectiveDateError = error.message; }
      if (!code || !name || code.length > 100 || name.length > 200 || !Number.isFinite(price) || price < 0 || !status || effectiveDateError) {
        const invalidFields = [];
        if (!code || code.length > 100) invalidFields.push('product_code');
        if (!name || name.length > 200) invalidFields.push('product_name');
        if (!Number.isFinite(price) || price < 0) invalidFields.push('sale_price（仅支持数字或 CNY/¥ 金额）');
        if (!status) invalidFields.push('status（可留空，或填写可用/待审核/已驳回/已停用）');
        if (effectiveDateError) invalidFields.push('effective_date（格式为 YYYY-MM-DD）');
        failures.push({ row: rowNumber, reason: `请填写有效 ${invalidFields.join('、')}` });
      }
      else {
        const payload = { warehouse_id: warehouse.id, product_code: code, product_name: name, sale_price: price, currency_code: 'CNY', image_url: String(row.image_url || '').trim() || null, status, effective_date: effectiveDate };
        const previousIndex = payloadIndexByIdentity.get(identity);
        if (previousIndex !== undefined) {
          // 文件内相同编码按最后一条数据为准，保留审计信息供预览提示。
          duplicateRows.push({ productCode: code, replacedRow: payloads[previousIndex]._rowNumber, keptRow: rowNumber });
          payloads[previousIndex] = { ...payload, _rowNumber: rowNumber };
        } else {
          payloadIndexByIdentity.set(identity, payloads.length);
          payloads.push({ ...payload, _rowNumber: rowNumber });
        }
      }
    });
    if (failures.length) return sendJson(response, 200, { valid: false, failures: failures.slice(0, 100), message: '校验失败，未写入数据' });
    const localCurrent = localDatabaseEnabled()
      ? (await localQuery(`select id, warehouse_id, product_code, sale_price, currency_code from public.products where warehouse_id = $1`, [warehouse.id])).rows
      : null;
    const { data: remoteCurrent, error: currentError } = localDatabaseEnabled()
      ? { data: null, error: null }
      : await adminClient.from('products').select('id,warehouse_id,product_code,sale_price,currency_code').in('warehouse_id', [...new Set(payloads.map(item => item.warehouse_id))]);
    const current = localCurrent || remoteCurrent;
    if (currentError) throw currentError;
    const currentByIdentity = new Map((current || []).map(item => [`${item.warehouse_id}::${item.product_code}`, item]));
    const currentProductIds = (current || []).map(item => item.id);
    const localCurrentVersions = localDatabaseEnabled() && currentProductIds.length
      ? (await localQuery(`select id, product_id, effective_date, created_at from public.product_cost_versions where product_id = any($1::uuid[]) order by effective_date desc, created_at desc`, [currentProductIds])).rows
      : (localDatabaseEnabled() ? [] : null);
    const { data: remoteCurrentVersions, error: currentVersionsError } = localDatabaseEnabled()
      ? { data: null, error: null }
      : (currentProductIds.length
        ? await adminClient.from('product_cost_versions').select('id,product_id,effective_date,created_at').in('product_id', currentProductIds).order('effective_date', { ascending: false }).order('created_at', { ascending: false })
        : { data: [], error: null });
    const currentVersions = localCurrentVersions || remoteCurrentVersions;
    if (currentVersionsError) throw new Error('读取现有商品成本版本失败');
    const latestVersionByProduct = new Map();
    (currentVersions || []).forEach(version => { if (!latestVersionByProduct.has(version.product_id)) latestVersionByProduct.set(version.product_id, version); });
    const inserts = payloads.filter(item => !currentByIdentity.has(`${item.warehouse_id}::${item.product_code}`));
    const updates = payloads.filter(item => currentByIdentity.has(`${item.warehouse_id}::${item.product_code}`));
    const costChangedUpdates = updates.filter(item => {
      const currentProduct = currentByIdentity.get(`${item.warehouse_id}::${item.product_code}`);
      return Number(currentProduct?.sale_price) !== Number(item.sale_price) || currentProduct?.currency_code !== item.currency_code;
    });
    const effectiveDateOnlyUpdates = updates.filter(item => {
      const currentProduct = currentByIdentity.get(`${item.warehouse_id}::${item.product_code}`);
      const latestVersion = latestVersionByProduct.get(currentProduct?.id);
      return !costChangedUpdates.includes(item) && latestVersion && latestVersion.effective_date !== item.effective_date;
    });
    const missingVersionUpdates = updates.filter(item => !latestVersionByProduct.has(currentByIdentity.get(`${item.warehouse_id}::${item.product_code}`)?.id));
    const summary = { valid: true, sourceRows: rows.length, totalRows: payloads.length, duplicateCount: duplicateRows.length, duplicateRows: duplicateRows.slice(0, 20), insertCount: inserts.length, updateCount: updates.length, effectiveDateUpdateCount: effectiveDateOnlyUpdates.length };
    if (mode === 'preview') return sendJson(response, 200, summary);
    if (localDatabaseEnabled()) {
      await withLocalTransaction(async ({ query }) => {
        for (const item of inserts) {
          await query(`insert into public.products (warehouse_id, product_code, product_name, sale_price, currency_code, image_url, status, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8)`, [item.warehouse_id, item.product_code, item.product_name, item.sale_price, item.currency_code, item.image_url, item.status, actor.id]);
        }
        for (const item of updates) {
          const id = currentByIdentity.get(`${item.warehouse_id}::${item.product_code}`).id;
          await query(`update public.products set product_name=$1,sale_price=$2,currency_code=$3,image_url=$4,status=$5 where id=$6`, [item.product_name, item.sale_price, item.currency_code, item.image_url, item.status, id]);
        }
        for (const item of effectiveDateOnlyUpdates) {
          const currentProduct = currentByIdentity.get(`${item.warehouse_id}::${item.product_code}`); const version = latestVersionByProduct.get(currentProduct?.id);
          await query(`update public.product_cost_versions set effective_date = $1 where id = $2`, [item.effective_date, version.id]);
        }
        const costVersionCodes = [...new Set([...inserts, ...costChangedUpdates, ...missingVersionUpdates].map(item => item.product_code))];
        if (costVersionCodes.length) {
          const { rows: versionedProducts } = await query(`select id, warehouse_id, product_code, sale_price, currency_code from public.products where warehouse_id = $1 and product_code = any($2::text[])`, [warehouse.id, costVersionCodes]);
          const importByIdentity = new Map(payloads.map(item => [`${item.warehouse_id}::${item.product_code}`, item]));
          for (const product of versionedProducts) {
            await query(`insert into public.product_cost_versions (product_id, warehouse_id, product_code, amount, currency_code, effective_date, created_by) values ($1,$2,$3,$4,$5,$6,$7)`, [product.id, product.warehouse_id, product.product_code, product.sale_price, product.currency_code, importByIdentity.get(`${product.warehouse_id}::${product.product_code}`)?.effective_date || '2026-08-01', actor.id]);
          }
        }
        await query(`insert into public.audit_logs (actor_id, entity_type, entity_id, action, before_data, after_data) values ($1,'product_import',null,'commit_product_import',null,$2::jsonb)`, [actor.id, JSON.stringify(summary)]);
      });
      dashboardOverviewCache.clear();
      return sendJson(response, 200, { ...summary, message: '商品批量导入完成' });
    }
    for (let index = 0; index < inserts.length; index += 200) { const { error } = await adminClient.from('products').insert(inserts.slice(index, index + 200).map(({ _rowNumber, effective_date, ...item }) => ({ ...item, created_by: actor.id }))); if (error) throw error; }
    for (let index = 0; index < updates.length; index += 100) await Promise.all(updates.slice(index, index + 100).map(({ _rowNumber, effective_date, ...item }) => adminClient.from('products').update(item).eq('id', currentByIdentity.get(`${item.warehouse_id}::${item.product_code}`).id).then(({ error }) => { if (error) throw error; })));
    for (let index = 0; index < effectiveDateOnlyUpdates.length; index += 100) await Promise.all(effectiveDateOnlyUpdates.slice(index, index + 100).map(item => {
      const currentProduct = currentByIdentity.get(`${item.warehouse_id}::${item.product_code}`); const version = latestVersionByProduct.get(currentProduct?.id);
      return adminClient.from('product_cost_versions').update({ effective_date: item.effective_date }).eq('id', version.id).then(({ error }) => { if (error) throw error; });
    }));
    const costVersionCodes = [...new Set([...inserts, ...costChangedUpdates, ...missingVersionUpdates].map(item => item.product_code))];
    if (costVersionCodes.length) {
      const { data: versionedProducts, error: versionedProductsError } = await adminClient.from('products').select('id,warehouse_id,product_code,sale_price,currency_code').eq('warehouse_id', warehouse.id).in('product_code', costVersionCodes);
      if (versionedProductsError) throw new Error('读取导入后的商品成本资料失败');
      const importByIdentity = new Map(payloads.map(item => [`${item.warehouse_id}::${item.product_code}`, item]));
      const { error: versionError } = await adminClient.from('product_cost_versions').insert((versionedProducts || []).map(product => ({ product_id: product.id, warehouse_id: product.warehouse_id, product_code: product.product_code, amount: product.sale_price, currency_code: product.currency_code, effective_date: importByIdentity.get(`${product.warehouse_id}::${product.product_code}`)?.effective_date || '2026-08-01', created_by: actor.id })));
      if (versionError) throw new Error('保存导入商品成本版本失败');
    }
    dashboardOverviewCache.clear();
    sendJson(response, 200, { ...summary, message: '商品批量导入完成' });
  } catch (error) { adminError(response, error); }
}
async function updateProduct(request, response) {
  try {
    const actor = await requireAdministrator(request);
    const body = await readJson(request);
    const productId = String(body.productId || '');
    const warehouseId = String(body.warehouseId || '');
    const productCode = String(body.productCode || '').trim();
    const productName = String(body.productName || '').trim();
    const salePrice = Number(body.salePrice);
    const currencyCode = String(body.currencyCode || '').trim().toUpperCase();
    const status = String(body.status || 'pending_review');
    const effectiveDate = productCostEffectiveDate(body.effectiveDate);
    const imageUrl = normaliseImageUrl(body.imageUrl);
    if (!/^[0-9a-f-]{36}$/i.test(productId) || !/^[0-9a-f-]{36}$/i.test(warehouseId) || !productCode || productCode.length > 100 || !productName || productName.length > 200 || !Number.isFinite(salePrice) || salePrice < 0 || currencyCode !== 'CNY' || !['pending_review', 'approved', 'rejected', 'disabled'].includes(status)) throw new Error('请完整填写商品编码、名称、人民币单价、仓库和状态');
    if (localDatabaseEnabled()) {
      const [beforeResult, warehouseResult, versionResult] = await Promise.all([
        localQuery(`select id, warehouse_id, product_code, product_name, sale_price, currency_code, status from public.products where id = $1`, [productId]),
        localQuery(`select id from public.warehouses where id = $1 and is_active = true`, [warehouseId]),
        localQuery(`select id, effective_date from public.product_cost_versions where product_id = $1 order by effective_date desc, created_at desc limit 1`, [productId])
      ]);
      const before = beforeResult.rows[0], warehouse = warehouseResult.rows[0], latestVersion = versionResult.rows[0];
      if (!before) throw new Error('未找到该商品');
      if (!warehouse) throw new Error('请选择启用中的仓库');
      const reviewData = ['approved', 'rejected'].includes(status) ? { reviewed_by: actor.id, reviewed_at: new Date().toISOString() } : { reviewed_by: null, reviewed_at: null };
      const data = await withLocalTransaction(async ({ query }) => {
        let product;
        try {
          product = (await query(`update public.products set warehouse_id=$1,product_code=$2,product_name=$3,image_url=$4,sale_price=$5,currency_code=$6,status=$7,reviewed_by=$8,reviewed_at=$9 where id=$10 returning *`, [warehouseId, productCode, productName, imageUrl, salePrice, currencyCode, status, reviewData.reviewed_by, reviewData.reviewed_at, productId])).rows[0];
        } catch (error) {
          if (error.code === '23505') throw new Error('该仓库中已存在相同商品编码');
          throw error;
        }
        const costIdentityChanged = before.warehouse_id !== warehouseId || before.product_code !== productCode || Number(before.sale_price) !== salePrice || before.currency_code !== currencyCode;
        if (costIdentityChanged || !latestVersion) {
          await query(`insert into public.product_cost_versions (product_id, warehouse_id, product_code, amount, currency_code, effective_date, created_by) values ($1,$2,$3,$4,$5,$6,$7)`, [product.id, product.warehouse_id, product.product_code, product.sale_price, product.currency_code, effectiveDate, actor.id]);
        } else if (String(latestVersion.effective_date) !== effectiveDate) {
          await query(`update public.product_cost_versions set effective_date = $1 where id = $2`, [effectiveDate, latestVersion.id]);
        }
        await query(`insert into public.audit_logs (actor_id, entity_type, entity_id, action, before_data, after_data) values ($1,'product',$2,'update',$3::jsonb,$4::jsonb)`, [actor.id, productId, JSON.stringify(before), JSON.stringify(product)]);
        return product;
      });
      dashboardOverviewCache.clear(); return sendJson(response, 200, { product: data });
    }
    const [{ data: before, error: findError }, { data: warehouse, error: warehouseError }, { data: latestVersion, error: latestVersionError }] = await Promise.all([
      adminClient.from('products').select('id, warehouse_id, product_code, product_name, sale_price, currency_code, status').eq('id', productId).single(),
      adminClient.from('warehouses').select('id').eq('id', warehouseId).eq('is_active', true).maybeSingle(),
      adminClient.from('product_cost_versions').select('id,effective_date').eq('product_id', productId).order('effective_date', { ascending: false }).order('created_at', { ascending: false }).limit(1).maybeSingle()
    ]);
    if (findError || !before) throw new Error('未找到该商品');
    if (warehouseError || !warehouse) throw new Error('请选择启用中的仓库');
    if (latestVersionError) throw new Error('读取商品成本版本失败');
    const reviewData = ['approved', 'rejected'].includes(status) ? { reviewed_by: actor.id, reviewed_at: new Date().toISOString() } : { reviewed_by: null, reviewed_at: null };
    const { data, error } = await adminClient.from('products').update({ warehouse_id: warehouseId, product_code: productCode, product_name: productName, image_url: imageUrl, sale_price: salePrice, currency_code: currencyCode, status, ...reviewData }).eq('id', productId).select().single();
    if (error) throw new Error(error.code === '23505' ? '该仓库中已存在相同商品编码' : '保存商品失败');
    const costIdentityChanged = before.warehouse_id !== warehouseId || before.product_code !== productCode || Number(before.sale_price) !== salePrice || before.currency_code !== currencyCode;
    if (costIdentityChanged || !latestVersion) await appendProductCostVersion(data, effectiveDate, actor.id);
    else if (latestVersion.effective_date !== effectiveDate) {
      const { error: effectiveDateError } = await adminClient.from('product_cost_versions').update({ effective_date: effectiveDate }).eq('id', latestVersion.id);
      if (effectiveDateError) throw new Error('修改商品成本生效日期失败');
    }
    await writeAudit(actor.id, 'product', productId, 'update', before, data);
    dashboardOverviewCache.clear();
    sendJson(response, 200, { product: data });
  } catch (error) { adminError(response, error); }
}
async function deleteProduct(request, response) {
  try {
    const actor = await requireAdministrator(request);
    const { productId } = await readJson(request);
    if (!/^[0-9a-f-]{36}$/i.test(String(productId || ''))) throw new Error('商品参数无效');
    if (localDatabaseEnabled()) {
      const before = (await localQuery(`select id, product_code, product_name from public.products where id = $1`, [productId])).rows[0];
      if (!before) throw new Error('未找到该商品');
      const versionCount = (await localQuery(`select count(*)::int as count from public.product_cost_versions where product_id = $1`, [productId])).rows[0].count;
      await withLocalTransaction(async ({ query }) => {
        if (Number(versionCount) > 0) {
          await query(`update public.products set status = 'disabled' where id = $1`, [productId]);
          await query(`insert into public.audit_logs (actor_id, entity_type, entity_id, action, before_data, after_data) values ($1,'product',$2,'disable_with_cost_history',$3::jsonb,$4::jsonb)`, [actor.id, productId, JSON.stringify(before), JSON.stringify({ status: 'disabled', reason: '保留商品成本历史' })]);
        } else {
          await query(`delete from public.products where id = $1`, [productId]);
          await query(`insert into public.audit_logs (actor_id, entity_type, entity_id, action, before_data, after_data) values ($1,'product',$2,'delete',$3::jsonb,null)`, [actor.id, productId, JSON.stringify(before)]);
        }
      });
      dashboardOverviewCache.clear();
      return sendJson(response, 200, Number(versionCount) > 0 ? { message: '该商品已有成本历史，已停用并保留历史记录' } : { message: '商品已删除' });
    }
    const { data: before, error: findError } = await adminClient.from('products').select('id, product_code, product_name').eq('id', productId).single();
    if (findError || !before) throw new Error('未找到该商品');
    const { count: versionCount, error: versionCountError } = await adminClient.from('product_cost_versions').select('id', { count: 'exact', head: true }).eq('product_id', productId);
    if (versionCountError) throw new Error('读取商品成本历史失败');
    if (Number(versionCount || 0) > 0) {
      const { error: disableError } = await adminClient.from('products').update({ status: 'disabled' }).eq('id', productId);
      if (disableError) throw new Error('停用商品失败');
      await writeAudit(actor.id, 'product', productId, 'disable_with_cost_history', before, { status: 'disabled', reason: '保留商品成本历史' });
      dashboardOverviewCache.clear();
      return sendJson(response, 200, { message: '该商品已有成本历史，已停用并保留历史记录' });
    }
    const { error } = await adminClient.from('products').delete().eq('id', productId);
    if (error) throw new Error('删除商品失败');
    await writeAudit(actor.id, 'product', productId, 'delete', before, null);
    dashboardOverviewCache.clear();
    sendJson(response, 200, { message: '商品已删除' });
  } catch (error) { adminError(response, error); }
}
async function createMember(request, response) {
  try {
    const actor = await requireAdministrator(request);
    const body = await readJson(request);
    const displayName = String(body.displayName || '').trim();
    const email = String(body.email || '').trim();
    const password = String(body.password || '');
    const role = String(body.role || 'business_user');
    const shopIds = normaliseIds(body.shopIds);
    if (!displayName) throw new Error('请输入成员名称');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('请输入有效的成员邮箱');
    if (password.length < 8) throw new Error('初始密码至少需要 8 位');
    if (!['business_user', 'finance', 'admin'].includes(role)) throw new Error('角色无效');
    if (role === 'business_user' && !shopIds.length) throw new Error('请选择至少一个可访问店铺');
    if (localDatabaseEnabled()) {
      await withLocalTransaction(async ({ query }) => {
        if(shopIds.length){const valid=(await query(`select id from public.shops where id=any($1::uuid[])`,[shopIds])).rows;if(valid.length!==shopIds.length)throw new Error('存在无效店铺，请刷新后重试');}
        let user;try{user=(await query(`insert into auth.users (id,email,password_hash) values (gen_random_uuid(),$1,$2) returning id,email`,[email,passwordHash(password)])).rows[0];}catch(error){if(error.code==='23505')throw new Error('该邮箱已存在');throw error;}
        const profileUpdate = await query(`update public.profiles set display_name=$1,is_active=true where id=$2`,[displayName,user.id]); if(!profileUpdate.rowCount) throw new Error('创建成员资料失败'); await query(`insert into public.user_roles (user_id,role,assigned_by) values ($1,$2,$3)`,[user.id,role,actor.id]);
        for(const shopId of shopIds)await query(`insert into public.user_shop_permissions (user_id,shop_id,granted_by) values ($1,$2,$3)`,[user.id,shopId,actor.id]);
        await query(`insert into public.audit_logs (actor_id,entity_type,entity_id,action,before_data,after_data) values ($1,'member',$2,'create',null,$3::jsonb)`,[actor.id,user.id,JSON.stringify({displayName,email,role,shopIds})]);
      });
      return sendJson(response,201,{message:'成员账号已创建，可以使用初始密码登录'});
    }
    if (shopIds.length) {
      const { data: validShops, error: shopsError } = await adminClient.from('shops').select('id').in('id', shopIds);
      if (shopsError || validShops.length !== shopIds.length) throw new Error('存在无效店铺，请刷新后重试');
    }
    const { data, error } = await adminClient.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !data.user) throw new Error(error?.message?.includes('already') ? '该邮箱已存在' : '创建成员失败');
    const userId = data.user.id;
    const [{ error: profileError }, { error: roleError }, permissionResult] = await Promise.all([
      adminClient.from('profiles').update({ display_name: displayName }).eq('id', userId),
      adminClient.from('user_roles').insert({ user_id: userId, role }),
      shopIds.length ? adminClient.from('user_shop_permissions').insert(shopIds.map(shopId => ({ user_id: userId, shop_id: shopId }))) : Promise.resolve({ error: null })
    ]);
    if (profileError || roleError || permissionResult.error) throw new Error('账号已创建，但资料或授权保存失败，请在成员列表重新设置授权');
    await writeAudit(actor.id, 'member', userId, 'create', null, { displayName, email, role, shopIds });
    sendJson(response, 201, { message: '成员账号已创建，可以使用初始密码登录' });
  } catch (error) { adminError(response, error); }
}
async function updateMemberAccess(request, response) {
  try {
    const actor = await requireAdministrator(request);
    const body = await readJson(request);
    const userId = String(body.userId || '');
    const role = String(body.role || '');
    const shopIds = normaliseIds(body.shopIds);
    if (!userId || !['business_user', 'finance', 'admin', 'super_admin'].includes(role)) throw new Error('授权参数无效');
    if (userId === actor.id && role !== 'super_admin') throw new Error('不能降低当前超级管理员自身权限');
    if (localDatabaseEnabled()) {
      await withLocalTransaction(async ({ query }) => {
        const user=(await query(`select id from public.profiles where id=$1`,[userId])).rows[0];if(!user)throw new Error('未找到该成员');
        if(shopIds.length){const valid=(await query(`select id from public.shops where id=any($1::uuid[])`,[shopIds])).rows;if(valid.length!==shopIds.length)throw new Error('存在无效店铺，请刷新后重试');}
        await query(`delete from public.user_roles where user_id=$1`,[userId]);await query(`insert into public.user_roles (user_id,role,assigned_by) values ($1,$2,$3)`,[userId,role,actor.id]);await query(`delete from public.user_shop_permissions where user_id=$1`,[userId]);for(const shopId of shopIds)await query(`insert into public.user_shop_permissions (user_id,shop_id,granted_by) values ($1,$2,$3)`,[userId,shopId,actor.id]);
        await query(`insert into public.audit_logs (actor_id,entity_type,entity_id,action,before_data,after_data) values ($1,'member',$2,'update_access',null,$3::jsonb)`,[actor.id,userId,JSON.stringify({role,shopIds})]);
      });
      return sendJson(response,200,{message:'成员权限已更新'});
    }
    if (shopIds.length) {
      const { data: validShops, error: shopsError } = await adminClient.from('shops').select('id').in('id', shopIds);
      if (shopsError || validShops.length !== shopIds.length) throw new Error('存在无效店铺，请刷新后重试');
    }
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
    await writeAudit(actor.id, 'member', userId, 'update_access', null, { role, shopIds });
    sendJson(response, 200, { message: '成员权限已更新' });
  } catch (error) { adminError(response, error); }
}
async function listMemberManagementData(request, response) {
  try {
    await requireAdministrator(request);
    if(localDatabaseEnabled()){
      const [profiles,roles,permissions,shops,users]=await Promise.all([localQuery(`select id,display_name,phone,is_active,created_at,updated_at from public.profiles order by created_at desc`),localQuery(`select user_id,role from public.user_roles`),localQuery(`select user_id,shop_id from public.user_shop_permissions`),localQuery(`select id,shop_name,shop_code,is_active from public.shops order by shop_name`),localQuery(`select id,email,phone,created_at,updated_at from auth.users`)]);const authById=new Map(users.rows.map(row=>[row.id,row]));return sendJson(response,200,{users:profiles.rows.map(profile=>{const auth=authById.get(profile.id);return{id:profile.id,displayName:profile.display_name||'',email:auth?.email||'',phone:profile.phone||auth?.phone||'',isActive:profile.is_active,confirmed:true,lastSignInAt:null,createdAt:profile.created_at,updatedAt:profile.updated_at,roles:roles.rows.filter(row=>row.user_id===profile.id).map(row=>row.role),shopIds:permissions.rows.filter(row=>row.user_id===profile.id).map(row=>row.shop_id)}}),shops:shops.rows});}
    const [{ data: profiles, error: profilesError }, { data: roles, error: rolesError }, { data: permissions, error: permissionsError }, { data: shops, error: shopsError }, usersResult] = await Promise.all([
      adminClient.from('profiles').select('id, display_name, phone, is_active, created_at, updated_at').order('created_at', { ascending: false }),
      adminClient.from('user_roles').select('user_id, role'),
      adminClient.from('user_shop_permissions').select('user_id, shop_id'),
      adminClient.from('shops').select('id, shop_name, shop_code, is_active').order('shop_name'),
      adminClient.auth.admin.listUsers({ page: 1, perPage: 500 })
    ]);
    if (profilesError || rolesError || permissionsError || shopsError || usersResult.error) throw new Error('读取成员数据失败');
    const authById = new Map(usersResult.data.users.map(user => [user.id, user]));
    const users = profiles.map(profile => {
      const auth = authById.get(profile.id);
      return { id: profile.id, displayName: profile.display_name || '', email: auth?.email || '', phone: profile.phone || auth?.phone || '', isActive: profile.is_active, confirmed: Boolean(auth?.email_confirmed_at || auth?.phone_confirmed_at), lastSignInAt: auth?.last_sign_in_at || null, createdAt: profile.created_at, updatedAt: profile.updated_at, roles: roles.filter(row => row.user_id === profile.id).map(row => row.role), shopIds: permissions.filter(row => row.user_id === profile.id).map(row => row.shop_id) };
    });
    sendJson(response, 200, { users, shops });
  } catch (error) { adminError(response, error); }
}
async function ensureNotLastActiveSuperAdmin(userId, willRemainActiveSuperAdmin) {
  if (willRemainActiveSuperAdmin) return;
  const [{ data: superRoles, error: rolesError }, { data: profiles, error: profilesError }] = await Promise.all([
    adminClient.from('user_roles').select('user_id').eq('role', 'super_admin'),
    adminClient.from('profiles').select('id, is_active')
  ]);
  if (rolesError || profilesError) throw new Error('检查超级管理员状态失败');
  const activeSuperIds = superRoles.map(row => row.user_id).filter(id => profiles.some(profile => profile.id === id && profile.is_active));
  if (activeSuperIds.length <= 1 && activeSuperIds.includes(userId)) throw new Error('不能停用或降级最后一名超级管理员');
}
async function updateMemberConfiguration(request, response) {
  try {
    const actor = await requireAdministrator(request);
    const body = await readJson(request);
    const userId = String(body.userId || '');
    const displayName = String(body.displayName || '').trim();
    const role = String(body.role || '');
    const password = String(body.password || '');
    const shopIds = normaliseIds(body.shopIds);
    if (!/^[0-9a-f-]{36}$/i.test(userId) || !displayName || !['business_user', 'finance', 'admin', 'super_admin'].includes(role)) throw new Error('请完整填写成员名称和角色');
    if (password && password.length < 8) throw new Error('新密码至少需要 8 位');
    if (localDatabaseEnabled()) {
      const [profileResult, rolesResult, actorRolesResult, permissionsResult] = await Promise.all([
        localQuery(`select id,display_name,is_active from public.profiles where id=$1`,[userId]), localQuery(`select role from public.user_roles where user_id=$1`,[userId]), localQuery(`select role from public.user_roles where user_id=$1`,[actor.id]), localQuery(`select shop_id from public.user_shop_permissions where user_id=$1`,[userId])
      ]);
      const beforeProfile=profileResult.rows[0], beforeRoles=rolesResult.rows, actorRoles=actorRolesResult.rows, beforePermissions=permissionsResult.rows;
      if(!beforeProfile) throw new Error('未找到该成员');
      const previousRole=beforeRoles[0]?.role||'', actorIsSuperAdmin=actorRoles.some(row=>row.role==='super_admin');
      if((previousRole==='super_admin'||role==='super_admin')&&!actorIsSuperAdmin)throw new Error('只有超级管理员可以修改超级管理员账号');
      if(userId===actor.id&&previousRole!==role)throw new Error('不能修改当前登录管理员自己的角色');
      if(previousRole==='super_admin' && role!=='super_admin'){const count=(await localQuery(`select count(*)::int as count from public.user_roles r join public.profiles p on p.id=r.user_id where r.role='super_admin' and p.is_active=true`,[])).rows[0].count;if(count<=1)throw new Error('不能停用或降级最后一名超级管理员');}
      if(role==='business_user'&&!shopIds.length)throw new Error('业务员至少需要授权一个店铺'); const effectiveShopIds=role==='business_user'?shopIds:[];
      if(effectiveShopIds.length){const valid=(await localQuery(`select id from public.shops where is_active=true and id=any($1::uuid[])`,[effectiveShopIds])).rows;if(valid.length!==effectiveShopIds.length)throw new Error('只能授权启用中的店铺');}
      await withLocalTransaction(async({query})=>{
        await query(`update public.profiles set display_name=$1 where id=$2`,[displayName,userId]);
        if(password){await query(`update auth.users set password_hash=$1 where id=$2`,[passwordHash(password),userId]);await query(`update public.local_sessions set revoked_at=now() where user_id=$1 and revoked_at is null`,[userId]);}
        await query(`delete from public.user_roles where user_id=$1`,[userId]);await query(`insert into public.user_roles (user_id,role,assigned_by) values($1,$2,$3)`,[userId,role,actor.id]);await query(`delete from public.user_shop_permissions where user_id=$1`,[userId]);for(const shopId of effectiveShopIds)await query(`insert into public.user_shop_permissions (user_id,shop_id,granted_by) values($1,$2,$3)`,[userId,shopId,actor.id]);
        await query(`insert into public.audit_logs(actor_id,entity_type,entity_id,action,before_data,after_data) values($1,'member',$2,'update_configuration',$3::jsonb,$4::jsonb)`,[actor.id,userId,JSON.stringify({displayName:beforeProfile.display_name,role:previousRole,shopIds:beforePermissions.map(row=>row.shop_id)}),JSON.stringify({displayName,role,shopIds:effectiveShopIds,passwordReset:Boolean(password)})]);
      });
      return sendJson(response,200,{message:'成员资料与授权已保存'});
    }
    const [{ data: beforeProfile, error: profileError }, { data: beforeRoles, error: rolesError }, { data: actorRoles, error: actorRolesError }] = await Promise.all([
      adminClient.from('profiles').select('id, display_name, is_active').eq('id', userId).single(),
      adminClient.from('user_roles').select('role').eq('user_id', userId),
      adminClient.from('user_roles').select('role').eq('user_id', actor.id)
    ]);
    if (profileError || !beforeProfile || rolesError || actorRolesError) throw new Error('未找到该成员');
    const previousRole = beforeRoles.map(row => row.role)[0] || '';
    const actorIsSuperAdmin = actorRoles.some(row => row.role === 'super_admin');
    if ((previousRole === 'super_admin' || role === 'super_admin') && !actorIsSuperAdmin) throw new Error('只有超级管理员可以修改超级管理员账号');
    if (userId === actor.id && previousRole !== role) throw new Error('不能修改当前登录管理员自己的角色');
    if (previousRole === 'super_admin') await ensureNotLastActiveSuperAdmin(userId, role === 'super_admin' && beforeProfile.is_active);
    if (role === 'business_user' && !shopIds.length) throw new Error('业务员至少需要授权一个店铺');
    const effectiveShopIds = role === 'business_user' ? shopIds : [];
    if (effectiveShopIds.length) {
      const { data: validShops, error: shopsError } = await adminClient.from('shops').select('id').eq('is_active', true).in('id', effectiveShopIds);
      if (shopsError || validShops.length !== effectiveShopIds.length) throw new Error('只能授权启用中的店铺');
    }
    const { data: beforePermissions, error: permissionsError } = await adminClient.from('user_shop_permissions').select('shop_id').eq('user_id', userId);
    if (permissionsError) throw new Error('读取店铺授权失败');
    const { error: profileUpdateError } = await adminClient.from('profiles').update({ display_name: displayName }).eq('id', userId);
    if (profileUpdateError) throw new Error('更新成员名称失败');
    if (password) {
      const { error: passwordError } = await adminClient.auth.admin.updateUserById(userId, { password });
      if (passwordError) throw new Error('重置密码失败');
    }
    const { error: deleteRolesError } = await adminClient.from('user_roles').delete().eq('user_id', userId);
    if (deleteRolesError) throw new Error('更新角色失败');
    const { error: insertRoleError } = await adminClient.from('user_roles').insert({ user_id: userId, role, assigned_by: actor.id });
    if (insertRoleError) throw new Error('更新角色失败');
    const { error: deletePermissionsError } = await adminClient.from('user_shop_permissions').delete().eq('user_id', userId);
    if (deletePermissionsError) throw new Error('更新店铺授权失败');
    if (effectiveShopIds.length) {
      const { error: insertPermissionsError } = await adminClient.from('user_shop_permissions').insert(effectiveShopIds.map(shopId => ({ user_id: userId, shop_id: shopId, granted_by: actor.id })));
      if (insertPermissionsError) throw new Error('更新店铺授权失败');
    }
    await writeAudit(actor.id, 'member', userId, 'update_configuration', { displayName: beforeProfile.display_name, role: previousRole, shopIds: beforePermissions.map(row => row.shop_id) }, { displayName, role, shopIds: effectiveShopIds, passwordReset: Boolean(password) });
    sendJson(response, 200, { message: '成员资料与授权已保存' });
  } catch (error) { adminError(response, error); }
}
async function setMemberActive(request, response) {
  try {
    const actor = await requireAdministrator(request);
    const { userId, isActive } = await readJson(request);
    if (!/^[0-9a-f-]{36}$/i.test(String(userId || '')) || typeof isActive !== 'boolean') throw new Error('成员状态参数无效');
    if (userId === actor.id && !isActive) throw new Error('不能停用当前登录管理员');
    if(localDatabaseEnabled()){
      const [profileResult,rolesResult,actorRolesResult]=await Promise.all([localQuery(`select id,display_name,is_active from public.profiles where id=$1`,[userId]),localQuery(`select role from public.user_roles where user_id=$1`,[userId]),localQuery(`select role from public.user_roles where user_id=$1`,[actor.id])]);const profile=profileResult.rows[0],roles=rolesResult.rows,actorRoles=actorRolesResult.rows;if(!profile)throw new Error('未找到该成员');
      if(roles.some(row=>row.role==='super_admin')&&!actorRoles.some(row=>row.role==='super_admin'))throw new Error('只有超级管理员可以停用或启用超级管理员账号');if(profile.is_active===isActive)return sendJson(response,200,{message:isActive?'该成员已启用':'该成员已停用'});
      if(roles.some(row=>row.role==='super_admin')&&!isActive){const count=(await localQuery(`select count(*)::int as count from public.user_roles r join public.profiles p on p.id=r.user_id where r.role='super_admin' and p.is_active=true`,[])).rows[0].count;if(count<=1)throw new Error('不能停用或降级最后一名超级管理员');}
      await withLocalTransaction(async({query})=>{await query(`update public.profiles set is_active=$1 where id=$2`,[isActive,userId]);if(!isActive)await query(`update public.local_sessions set revoked_at=now() where user_id=$1 and revoked_at is null`,[userId]);await query(`insert into public.audit_logs(actor_id,entity_type,entity_id,action,before_data,after_data) values($1,'member',$2,$3,$4::jsonb,$5::jsonb)`,[actor.id,userId,isActive?'enable':'disable',JSON.stringify({isActive:profile.is_active}),JSON.stringify({isActive})]);});
      return sendJson(response,200,{message:isActive?'成员已启用，请通知其重新登录':'成员已停用，现有业务访问已被阻断'});
    }
    const [{ data: profile, error: profileError }, { data: roles, error: rolesError }, { data: actorRoles, error: actorRolesError }] = await Promise.all([
      adminClient.from('profiles').select('id, display_name, is_active').eq('id', userId).single(),
      adminClient.from('user_roles').select('role').eq('user_id', userId),
      adminClient.from('user_roles').select('role').eq('user_id', actor.id)
    ]);
    if (profileError || !profile || rolesError || actorRolesError) throw new Error('未找到该成员');
    if (roles.some(row => row.role === 'super_admin') && !actorRoles.some(row => row.role === 'super_admin')) throw new Error('只有超级管理员可以停用或启用超级管理员账号');
    if (profile.is_active === isActive) return sendJson(response, 200, { message: isActive ? '该成员已启用' : '该成员已停用' });
    if (roles.some(row => row.role === 'super_admin')) await ensureNotLastActiveSuperAdmin(userId, isActive);
    const { error: authError } = await adminClient.auth.admin.updateUserById(userId, { ban_duration: isActive ? 'none' : '876000h' });
    if (authError) throw new Error(isActive ? '启用认证账号失败' : '停用认证账号失败');
    const { error: updateError } = await adminClient.from('profiles').update({ is_active: isActive }).eq('id', userId);
    if (updateError) throw new Error('更新成员状态失败');
    await writeAudit(actor.id, 'member', userId, isActive ? 'enable' : 'disable', { isActive: profile.is_active }, { isActive });
    sendJson(response, 200, { message: isActive ? '成员已启用，请通知其重新登录' : '成员已停用，现有业务访问已被阻断' });
  } catch (error) { adminError(response, error); }
}
async function listBusinessShops(request, response) {
  try {
    const accessToken = bearerToken(request);
    if (!accessToken) throw new Error('UNAUTHORIZED');
    const identity = await getAuthenticatedProfile(accessToken);
    const userId = identity.profile.id;
    const isPrivileged = identity.roles.some(role => ['finance', 'admin', 'super_admin'].includes(role));
    if (localDatabaseEnabled()) {
      const permissionRows = isPrivileged ? [] : (await localQuery(`select shop_id from public.user_shop_permissions where user_id=$1`, [userId])).rows;
      const permittedIds = permissionRows.map(row => row.shop_id);
      const shops = (await localQuery(`select id,shop_code,shop_name,country_code,currency_code,timezone,is_active,updated_at from public.shops where is_active=true ${isPrivileged ? '' : 'and id = any($1::uuid[])'} order by shop_name`, isPrivileged ? [] : [permittedIds])).rows;
      const ids=shops.map(shop=>shop.id), links=ids.length?(await localQuery(`select sw.shop_id,json_build_object('id',w.id,'name',w.name,'country_code',w.country_code,'is_active',w.is_active) as warehouse from public.shop_warehouses sw join public.warehouses w on w.id=sw.warehouse_id where sw.shop_id=any($1::uuid[])`,[ids])).rows:[];
      const warehousesByShop=new Map();links.forEach(link=>{const rows=warehousesByShop.get(link.shop_id)||[];if(link.warehouse?.is_active)rows.push(link.warehouse);warehousesByShop.set(link.shop_id,rows)});
      return sendJson(response,200,{shops:shops.map(shop=>({...shop,warehouses:warehousesByShop.get(shop.id)||[]}))});
    }
    const permissionQuery = adminClient.from('user_shop_permissions').select('shop_id').eq('user_id', userId);
    const { data: permissions, error: permissionsError } = await permissionQuery;
    if (permissionsError) throw new Error('读取店铺授权失败');
    const shopIds = permissions.map(row => row.shop_id);
    // 业务端只展示仍可使用的店铺。停用店铺仍会保留在管理端的数据列表中，
    // 方便管理员追溯历史，但不会继续出现在任何业务员的“我的店铺”视图。
    let query = adminClient.from('shops').select('id, shop_code, shop_name, country_code, currency_code, timezone, is_active, updated_at').eq('is_active', true).order('shop_name');
    if (!isPrivileged) query = shopIds.length ? query.in('id', shopIds) : query.in('id', ['00000000-0000-0000-0000-000000000000']);
    const { data: shops, error: shopsError } = await query;
    if (shopsError) throw new Error('读取店铺数据失败');
    const visibleShopIds = shops.map(shop => shop.id);
    const { data: links, error: linksError } = await adminClient.from('shop_warehouses').select('shop_id, warehouses(id, name, country_code, is_active)').in('shop_id', visibleShopIds.length ? visibleShopIds : ['00000000-0000-0000-0000-000000000000']);
    if (linksError) throw new Error('读取关联仓库失败');
    const warehousesByShop = new Map();
    links.forEach(link => {
      const rows = warehousesByShop.get(link.shop_id) || [];
      if (link.warehouses?.is_active) rows.push(link.warehouses);
      warehousesByShop.set(link.shop_id, rows);
    });
    sendJson(response, 200, { shops: shops.map(shop => ({ ...shop, warehouses: warehousesByShop.get(shop.id) || [] })) });
  } catch (error) { adminError(response, error); }
}
async function listBusinessDashboardOverview(request, response) {
  try {
    const accessToken = bearerToken(request);
    if (!accessToken) throw new Error('UNAUTHORIZED');
    const identity = await getAuthenticatedProfile(accessToken);
    const isPrivileged = identity.roles.some(role => ['finance', 'admin', 'super_admin'].includes(role));
    const requestUrl = new URL(request.url, `http://${request.headers.host}`);
    const reportCurrency = String(requestUrl.searchParams.get('currency') || 'CNY').toUpperCase();
    const rateType = String(requestUrl.searchParams.get('rateType') || 'settlement');
    const requestedSite = String(requestUrl.searchParams.get('site') || '').trim();
    if (!QUOTE_CURRENCIES.has(reportCurrency)) throw new Error('报表币种仅支持 CNY 或 USD');
    if (!['settlement', 'reference'].includes(rateType)) throw new Error('汇率取值参数无效');
    const today = new Date().toISOString().slice(0, 10);
    const endDate = new Date(`${today}T00:00:00Z`); endDate.setUTCDate(endDate.getUTCDate() - 1);
    const defaultEnd = endDate.toISOString().slice(0, 10);
    const defaultStartDate = new Date(`${defaultEnd}T00:00:00Z`); defaultStartDate.setUTCDate(defaultStartDate.getUTCDate() - 6);
    const start = /^\d{4}-\d{2}-\d{2}$/.test(String(requestUrl.searchParams.get('start') || '')) ? String(requestUrl.searchParams.get('start')) : defaultStartDate.toISOString().slice(0, 10);
    const end = /^\d{4}-\d{2}-\d{2}$/.test(String(requestUrl.searchParams.get('end') || '')) ? String(requestUrl.searchParams.get('end')) : defaultEnd;
    if (start > end) throw new Error('开始日期不能晚于结束日期');
    if (end >= today) throw new Error('数据看板仅统计截至昨日的完整自然日数据');
    if ((new Date(`${end}T00:00:00Z`) - new Date(`${start}T00:00:00Z`)) / 86400000 + 1 > 90) throw new Error('自定义时间范围最多 90 天，超过请使用导出报表');
    // 所有订单相关页面以 UTC 自然日作为筛选、分组和展示口径。
    const reportStartAt = `${start}T00:00:00+00:00`;
    const reportEndAt = `${end}T23:59:59.999+00:00`;
    const reportDatePart = businessDatePart;
    const forceRefresh = requestUrl.searchParams.get('refresh') === 'true';
    const lightweightDashboard = requestUrl.searchParams.get('view') === 'dashboard';
    // 数据看板的“快速利润预览”需复用利润明细的成本核算口径，
    // 但保留看板读取结算账单失败时不阻塞其他指标的容错行为。
    const includeProfitPreview = requestUrl.searchParams.get('profitPreview') === 'true';
    const exportProductCostMissing = requestUrl.searchParams.get('export') === 'product_cost_missing';
    const exportProductWarehouseCostMissing = requestUrl.searchParams.get('export') === 'product_warehouse_cost_missing';
    const exportSettlementUnmatched = requestUrl.searchParams.get('export') === 'settlement_unmatched';
    const requestedShopIds = [...new Set(String(requestUrl.searchParams.get('shopId') || '').split(',').map(value => value.trim()).filter(Boolean))];
    const cacheKey = `${identity.profile.id}:${requestedShopIds.join(',') || 'all'}:${requestedSite || 'all'}:${start}:${end}:${reportCurrency}:${rateType}:${lightweightDashboard ? 'dashboard' : 'detail'}:${includeProfitPreview ? 'profit-preview' : 'standard'}`;
    const cached = dashboardOverviewCache.get(cacheKey);
    if (!exportProductCostMissing && !exportProductWarehouseCostMissing && !exportSettlementUnmatched && !forceRefresh && cached && Date.now() - cached.createdAt < DASHBOARD_OVERVIEW_CACHE_TTL) return sendJson(response, 200, cached.data);
    const localMode = localDatabaseEnabled();
    const [{ data: permissions, error: permissionsError }, { data: rates, error: ratesError }] = localMode
      ? await Promise.all([
        localQuery('select shop_id from public.user_shop_permissions where user_id=$1', [identity.profile.id]).then(result => ({ data: result.rows, error: null })),
        rateType === 'settlement'
          ? localQuery('select base_currency, quote_currency, settlement_rate, effective_date::text as effective_date from public.settlement_exchange_rates where is_active=true and effective_date <= $1::date order by effective_date desc', [end]).then(result => ({ data: result.rows, error: null }))
          : Promise.resolve({ data: [], error: null })
      ])
      : await Promise.all([
        adminClient.from('user_shop_permissions').select('shop_id').eq('user_id', identity.profile.id),
        rateType === 'settlement'
          ? adminClient.from('settlement_exchange_rates').select('base_currency, quote_currency, settlement_rate, effective_date').eq('is_active', true).lte('effective_date', end).order('effective_date', { ascending: false })
          : Promise.resolve({ data: [], error: null })
      ]);
    if (permissionsError || ratesError) throw new Error('读取店铺授权或报表结算汇率失败');
    const referenceRateData = rateType === 'reference' ? await refreshRates(reportCurrency) : null;
    const permittedIds = (permissions || []).map(row => row.shop_id);
    let shops, shopsError;
    if (localMode) {
      const result = await localQuery(`select id, shop_code, shop_name, country_code from public.shops where is_active=true ${isPrivileged ? '' : 'and id=any($1::uuid[])'} order by shop_name`, isPrivileged ? [] : [permittedIds]);
      shops = result.rows;
    } else {
      let shopsQuery = adminClient.from('shops').select('id, shop_code, shop_name, country_code').eq('is_active', true);
      if (!isPrivileged) shopsQuery = shopsQuery.in('id', permittedIds.length ? permittedIds : ['00000000-0000-0000-0000-000000000000']);
      const result = await shopsQuery; shops = result.data; shopsError = result.error;
    }
    if (shopsError) throw new Error('读取业务端可见店铺失败');
    const visibleShopIds = (shops || []).map(shop => shop.id);
    if (requestedShopIds.some(shopId => !visibleShopIds.includes(shopId))) throw new Error('无权查看该店铺数据');
    const scopedShopIds = (requestedShopIds.length ? requestedShopIds : visibleShopIds).filter(shopId => !requestedSite || (shops || []).some(shop => shop.id === shopId && shop.country_code === requestedSite));
    const safeShopIds = scopedShopIds.length ? scopedShopIds : ['00000000-0000-0000-0000-000000000000'];
    const items = [];
    const pageSize = 1000;
    for (let offset = 0; ; offset += pageSize) {
      // 批量导入时多条明细会拥有相同 created_at；必须以唯一 id 作为次排序，
      // 才能避免 offset 分页在边界处重复或遗漏记录。
      const page = localMode
        ? await localQuery(`select i.id, i.product_code, i.seller_sku, i.sku_id, i.product_name, i.quantity, i.cancellation_return_type, i.currency_code, i.sku_subtotal_after_discount, i.shipping_fee_after_discount, i.payment_platform_discount,
          json_build_object('id',o.id,'shop_id',o.shop_id,'order_number',o.order_number,'currency_code',o.currency_code,'order_status',o.order_status,'order_substatus',o.order_substatus,'refund_status',o.refund_status,'refund_amount',o.refund_amount,'tracking_number',o.tracking_number,'logistics_carrier',o.logistics_carrier,'delivery_option',o.delivery_option,'warehouse_name',o.warehouse_name,'ordered_at',o.ordered_at,'shops',json_build_object('shop_code',s.shop_code,'shop_name',s.shop_name,'country_code',s.country_code)) as orders
          from public.order_items i join public.orders o on o.id=i.order_id join public.shops s on s.id=o.shop_id
          where o.shop_id=any($1::uuid[]) and o.ordered_at >= $2::timestamptz and o.ordered_at <= $3::timestamptz
          order by i.created_at desc, i.id desc limit $4 offset $5`, [safeShopIds, reportStartAt, reportEndAt, pageSize, offset]).then(result => ({ data: result.rows, error: null }))
        : await readWithRetries(() => adminClient.from('order_items').select('id, product_code, seller_sku, sku_id, product_name, quantity, cancellation_return_type, currency_code, sku_subtotal_after_discount, shipping_fee_after_discount, payment_platform_discount, orders!inner(id, shop_id, order_number, currency_code, order_status, order_substatus, refund_status, refund_amount, tracking_number, logistics_carrier, delivery_option, warehouse_name, ordered_at, shops!inner(shop_code, shop_name, country_code))').in('orders.shop_id', safeShopIds).gte('orders.ordered_at', reportStartAt).lte('orders.ordered_at', reportEndAt).order('created_at', { ascending: false }).order('id', { ascending: false }).range(offset, offset + pageSize - 1), '读取订单支付金额失败');
      if (page.error) throw new Error('读取订单支付金额失败');
      items.push(...(page.data || []));
      if ((page.data || []).length < pageSize) break;
    }
    let fulfillmentWarehouses = [], fulfillmentCostVersions = [], fulfillmentProducts = [], productCostVersions = [], warehouseShopIds = new Map();
    if (!lightweightDashboard || includeProfitPreview) {
      const { data: warehouseLinks, error: warehouseLinksError } = localMode
        ? await localQuery('select shop_id, warehouse_id from public.shop_warehouses where shop_id=any($1::uuid[])', [safeShopIds]).then(result => ({ data: result.rows, error: null }))
        : await adminClient.from('shop_warehouses').select('shop_id, warehouse_id').in('shop_id', safeShopIds);
      if (warehouseLinksError) throw new Error('读取店铺关联仓库失败');
      const allowedWarehouseIds = [...new Set((warehouseLinks || []).map(link => link.warehouse_id).filter(Boolean))];
      (warehouseLinks || []).forEach(link => {
        const shopIds = warehouseShopIds.get(link.warehouse_id) || new Set();
        shopIds.add(link.shop_id);
        warehouseShopIds.set(link.warehouse_id, shopIds);
      });
      const warehouseResult = allowedWarehouseIds.length
        ? (localMode
          ? await localQuery('select id,name,original_warehouse_name,delivery_option,shipping_provider_name from public.warehouses where is_active=true and id=any($1::uuid[])', [allowedWarehouseIds]).then(result => ({ data: result.rows, error: null }))
          : await adminClient.from('warehouses').select('id, name, original_warehouse_name, delivery_option, shipping_provider_name').eq('is_active', true).in('id', allowedWarehouseIds))
        : { data: [], error: null };
      if (warehouseResult.error) throw new Error('读取仓库代发成本匹配资料失败');
      fulfillmentWarehouses = warehouseResult.data || [];
      const fulfillmentWarehouseIds = fulfillmentWarehouses.map(row => row.id);
      const costVersionsResult = fulfillmentWarehouseIds.length
        ? (localMode
          ? await localQuery('select id,warehouse_id,amount,currency_code,billing_unit,effective_date::text as effective_date,created_at from public.warehouse_cost_versions where warehouse_id=any($1::uuid[]) order by effective_date desc,created_at desc', [fulfillmentWarehouseIds]).then(result => ({ data: result.rows, error: null }))
          : await adminClient.from('warehouse_cost_versions').select('id, warehouse_id, amount, currency_code, billing_unit, effective_date, created_at').in('warehouse_id', fulfillmentWarehouseIds).order('effective_date', { ascending: false }).order('created_at', { ascending: false }))
        : { data: [], error: null };
      if (costVersionsResult.error) throw new Error('读取仓库代发费用版本失败');
      fulfillmentCostVersions = costVersionsResult.data || [];
      const productsResult = fulfillmentWarehouseIds.length
        ? (localMode
          ? await localQuery('select id,warehouse_id,product_code,product_name,sale_price,currency_code from public.products where warehouse_id=any($1::uuid[])', [fulfillmentWarehouseIds]).then(result => ({ data: result.rows, error: null }))
          : await adminClient.from('products').select('id, warehouse_id, product_code, product_name, sale_price, currency_code').in('warehouse_id', fulfillmentWarehouseIds))
        : { data: [], error: null };
      if (productsResult.error) throw new Error('读取商品成本匹配资料失败');
      fulfillmentProducts = productsResult.data || [];
      const productCostVersionsResult = fulfillmentWarehouseIds.length
        ? (localMode
          ? await localQuery('select id,product_id,warehouse_id,product_code,amount,currency_code,effective_date::text as effective_date,created_at from public.product_cost_versions where warehouse_id=any($1::uuid[]) order by effective_date desc,created_at desc', [fulfillmentWarehouseIds]).then(result => ({ data: result.rows, error: null }))
          : await adminClient.from('product_cost_versions').select('id, product_id, warehouse_id, product_code, amount, currency_code, effective_date, created_at').in('warehouse_id', fulfillmentWarehouseIds).order('effective_date', { ascending: false }).order('created_at', { ascending: false }))
        : { data: [], error: null };
      if (productCostVersionsResult.error) throw new Error('读取商品成本版本失败');
      productCostVersions = productCostVersionsResult.data || [];
    }
    const rateFor = (baseCurrency, date) => {
      if (baseCurrency === reportCurrency) return { settlement_rate: 1 };
      if (rateType === 'reference') {
        const rate = referenceRateData?.rates?.find(item => item.pair === `${baseCurrency}/${reportCurrency}` && item.available);
        return rate?.rate ? { settlement_rate: rate.rate } : null;
      }
      const historicalRates = rates || [];
      const directRate = historicalRates.find(rate => rate.base_currency === baseCurrency && rate.quote_currency === reportCurrency && rate.effective_date <= date);
      if (directRate) return directRate;
      // 结算汇率统一以 CNY 为基准维护。缺少直连币对时，使用订单币种→CNY
      // 与报表币种→CNY 的各自最新历史版本交叉换算，避免历史订单因显示币种切换而丢失金额。
      const sourceToCny = historicalRates.find(rate => rate.base_currency === baseCurrency && rate.quote_currency === 'CNY' && rate.effective_date <= date);
      const reportToCny = historicalRates.find(rate => rate.base_currency === reportCurrency && rate.quote_currency === 'CNY' && rate.effective_date <= date);
      if (baseCurrency === 'CNY' && reportToCny && Number(reportToCny.settlement_rate) > 0) return { settlement_rate: 1 / Number(reportToCny.settlement_rate) };
      if (reportCurrency === 'CNY' && sourceToCny && Number(sourceToCny.settlement_rate) > 0) return sourceToCny;
      if (sourceToCny && reportToCny) {
        const sourceRate = Number(sourceToCny.settlement_rate);
        const reportRate = Number(reportToCny.settlement_rate);
        if (Number.isFinite(sourceRate) && Number.isFinite(reportRate) && sourceRate > 0 && reportRate > 0) return { settlement_rate: sourceRate / reportRate };
      }
      return null;
    };
    const convertAmount = (amount, sourceCurrency, orderDate) => {
      if (sourceCurrency === reportCurrency) return Number(amount);
      const rate = rateFor(sourceCurrency, orderDate);
      return rate ? Number(amount) * Number(rate.settlement_rate || 0) : null;
    };
    const ordersByNumber = new Map();
    const salesByDate = new Map();
    const refundOrdersByKey = new Map();
    const refundsByDate = new Map();
    const salesByShop = new Map((shops || []).filter(shop => scopedShopIds.includes(shop.id)).map(shop => [shop.id, { shopId: shop.id, shopCode: shop.shop_code, shopName: shop.shop_name, countryCode: shop.country_code, amount: 0, convertedItemCount: 0, missingRateItemCount: 0 }]));
    for (let cursor = new Date(`${start}T00:00:00Z`), last = new Date(`${end}T00:00:00Z`); cursor <= last; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
      const date = cursor.toISOString().slice(0, 10);
      salesByDate.set(date, 0);
      refundsByDate.set(date, { date, orders: 0, refunds: 0 });
    }
    let salesAmount = 0, convertedItemCount = 0, missingRateItemCount = 0;
    for (const item of items) {
      const order = item.orders || {};
      const amount = Number(item.sku_subtotal_after_discount || 0) + Number(item.shipping_fee_after_discount || 0) - Number(item.payment_platform_discount || 0);
      const sourceCurrency = order.currency_code || item.currency_code;
      // 看板趋势、退款趋势与利润汇总统一按 UTC 自然日归属订单。
      const orderDate = reportDatePart(order.ordered_at);
      if (order.order_number) ordersByNumber.set(String(order.order_number), { date: orderDate, currency: sourceCurrency, signed: /已签收|已送达|delivered|signed/i.test(`${order.order_status || ''} ${order.order_substatus || ''}`) });
      const refundOrderKey = `${order.shop_id || ''}:${order.order_number || order.id || ''}`;
      if (refundOrderKey !== ':' && refundsByDate.has(orderDate)) {
        const refundOrder = refundOrdersByKey.get(refundOrderKey) || { date: orderDate, refunded: false };
        refundOrder.refunded ||= Boolean(String(item.cancellation_return_type || '').trim());
        refundOrdersByKey.set(refundOrderKey, refundOrder);
      }
      if (!Number.isFinite(amount) || !sourceCurrency || !orderDate) continue;
      const converted = convertAmount(amount, sourceCurrency, orderDate);
      const shopSales = salesByShop.get(order.shop_id);
      if (converted === null) { missingRateItemCount += 1; if (shopSales) shopSales.missingRateItemCount += 1; continue; }
      salesAmount += converted;
      salesByDate.set(orderDate, Number((salesByDate.get(orderDate) || 0) + converted));
      convertedItemCount += 1;
      if (shopSales) { shopSales.amount += converted; shopSales.convertedItemCount += 1; }
    }
    refundOrdersByKey.forEach(order => {
      const bucket = refundsByDate.get(order.date);
      if (!bucket) return;
      bucket.orders += 1;
      if (order.refunded) bucket.refunds += 1;
    });
    // 只读取当前筛选订单对应的账单，避免首页扫描店铺全部历史账单。
    const orderNumbers = [...ordersByNumber.keys()];
    const billChunks = [];
    for (let index = 0; index < orderNumbers.length; index += 500) billChunks.push(orderNumbers.slice(index, index + 500));
    const bills = []; let settlementReadFailed = false;
    for (let index = 0; index < billChunks.length; index += 5) {
      // 汇总只使用标准化金额与费用拆分；raw_data 是完整原始账单，体积大且此处不参与计算。
      const batch = await Promise.all(billChunks.slice(index, index + 5).map(chunk => localMode
        ? localQuery('select id,shop_id,source_type,related_order_id,sku_id,settlement_amount,total_income,total_fees,fee_breakdown,currency_code from public.tiktok_bill_records where shop_id=any($1::uuid[]) and related_order_id=any($2::text[]) and source_type in (\'settled\',\'unsettled\') and replacement_status=\'active\'', [safeShopIds, chunk]).then(result => ({ data: result.rows, error: null }))
        : adminClient.from('tiktok_bill_records').select('id, shop_id, source_type, related_order_id, sku_id, settlement_amount, total_income, total_fees, fee_breakdown, currency_code').in('shop_id', safeShopIds).in('related_order_id', chunk).in('source_type', ['settled', 'unsettled']).eq('replacement_status', 'active')));
      batch.forEach(page => { if (page.error) { if (lightweightDashboard) { settlementReadFailed = true; return; } throw new Error('读取结算账单失败'); } bills.push(...(page.data || [])); });
    }
    const settledByOrder = new Map(), unsettledByOrder = new Map();
    for (const bill of bills) {
      const orderNumber = String(bill.related_order_id || '').trim();
      if (!ordersByNumber.has(orderNumber)) continue;
      const amount = billDisplayAmount(bill);
      if (!Number.isFinite(amount)) continue;
      const bucket = bill.source_type === 'settled' ? settledByOrder : unsettledByOrder;
      const current = bucket.get(orderNumber) || { amount: 0, currency: bill.currency_code };
      current.amount += amount;
      bucket.set(orderNumber, current);
    }
    let settlementExpectedAmount = 0, settledOrderCount = 0, estimatedOrderCount = 0, missingBillRateOrderCount = 0;
    ordersByNumber.forEach((order, orderNumber) => {
      const bill = settledByOrder.get(orderNumber) || unsettledByOrder.get(orderNumber);
      if (!bill) return;
      const converted = convertAmount(bill.amount, bill.currency || order.currency, order.date);
      if (converted === null) { missingBillRateOrderCount += 1; return; }
      settlementExpectedAmount += converted;
      if (settledByOrder.has(orderNumber)) settledOrderCount += 1;
      else estimatedOrderCount += 1;
    });
    const { data: promotionRows, error: promotionRowsError } = localMode
      ? await localQuery('select shop_id,promotion_date::text as promotion_date,cost_amount,currency_code from public.promotion_expenses where shop_id=any($1::uuid[]) and promotion_date >= $2::date and promotion_date <= $3::date', [safeShopIds, start, end]).then(result => ({ data: result.rows, error: null }))
      : await adminClient.from('promotion_expenses').select('shop_id, promotion_date, cost_amount, currency_code').in('shop_id', safeShopIds).gte('promotion_date', start).lte('promotion_date', end);
    if (promotionRowsError) throw new Error('读取推广费用数据失败');
    let promotionExpense = 0, promotionExpenseRecordCount = 0, missingPromotionRateCount = 0;
    // 先按“店铺 + 日期”归集，同一天多次导入的费用会相加。
    const promotionByShopDate = new Map();
    (promotionRows || []).forEach(row => {
      const converted = convertAmount(Number(row.cost_amount || 0), String(row.currency_code || '').toUpperCase(), row.promotion_date);
      if (converted === null) { missingPromotionRateCount += 1; return; }
      promotionExpense += converted; promotionExpenseRecordCount += 1;
      const shopDateKey = `${row.shop_id}::${row.promotion_date}`;
      promotionByShopDate.set(shopDateKey, (promotionByShopDate.get(shopDateKey) || 0) + converted);
    });
    const promotionByShop = new Map();
    promotionByShopDate.forEach((amount, shopDateKey) => {
      const shopId = shopDateKey.split('::')[0];
      promotionByShop.set(shopId, (promotionByShop.get(shopId) || 0) + amount);
    });
    const buildDashboardData = profitReport => {
      const signedOrderCount = [...ordersByNumber.values()].filter(order => order.signed).length;
      const netProfitByDate = new Map((profitReport?.dates || []).map(row => [row.date, Number(row.netProfit || 0)]));
      const salesSeries = [...salesByDate.entries()].map(([date, amount]) => ({ date, amount: Number(amount.toFixed(2)), netProfit: Number((netProfitByDate.get(date) || 0).toFixed(2)) }));
      const refundSeries = [...refundsByDate.values()].map(item => ({ ...item, refundRate: item.orders ? Number((item.refunds / item.orders * 100).toFixed(2)) : 0 }));
      const storeSales = [...salesByShop.values()].map(shop => ({ ...shop, amount: Number(shop.amount.toFixed(2)) })).sort((left, right) => right.amount - left.amount || String(left.shopCode || left.shopName).localeCompare(String(right.shopCode || right.shopName), 'zh-CN'));
      return { salesAmount: Number(salesAmount.toFixed(2)), settlementExpectedAmount: Number(settlementExpectedAmount.toFixed(2)), promotionExpense: Number(promotionExpense.toFixed(2)), promotionExpenseRecordCount, missingPromotionRateCount, settlementReadFailed, currency: reportCurrency, rateType, referenceRateUpdatedAt: referenceRateData?.updatedAt || null, start, end, salesSeries, refundSeries, storeSales, profitReport, orderItemCount: items.length, validOrderCount: ordersByNumber.size, signedOrderCount, signedRate: ordersByNumber.size ? Number((signedOrderCount / ordersByNumber.size * 100).toFixed(2)) : 0, convertedItemCount, missingRateItemCount, settledOrderCount, estimatedOrderCount, missingBillRateOrderCount };
    };
    if (lightweightDashboard && !includeProfitPreview) {
      const data = buildDashboardData({ stores: [], products: [] });
      dashboardOverviewCache.set(cacheKey, { createdAt: Date.now(), data });
      return sendJson(response, 200, data);
    }
    // 利润明细：只汇总已有真实来源的订单与账单字段；尚未接入的成本保持为空。
    // 商品利润名称以订单商品编码为准，统一从商品管理资料读取，不使用导入订单中的名称。
    const productCodeReferences = new Map();
    items.forEach(item => {
      const code = String(item.seller_sku || item.product_code || '').trim();
      if (code) productCodeReferences.set(code, code);
    });
    const productNameByCode = await productNamesByCode(productCodeReferences);
    const profitOrders = new Map(), profitProducts = new Map();
    for (const item of items) {
      const order = item.orders || {}; const number = String(order.order_number || '').trim(); if (!order.shop_id || !number) continue;
      const key = `${order.shop_id}::${number}`, date = reportDatePart(order.ordered_at), currency = order.currency_code || item.currency_code;
      const rawSales = Number(item.sku_subtotal_after_discount || 0) + Number(item.shipping_fee_after_discount || 0) - Number(item.payment_platform_discount || 0);
      const sales = Number.isFinite(rawSales) ? convertAmount(rawSales, currency, date) : null;
      // 利润汇总中的店铺展示与店铺管理表单一致，优先使用“店铺简称 / 编码”。
      const entry = profitOrders.get(key) || { shopId: order.shop_id, shop: order.shops?.shop_code || order.shops?.shop_name || '—', site: order.shops?.country_code || '—', number, orderStatus: order.order_status || '', date, currency, trackingNumber: order.tracking_number || '', warehouseName: order.warehouse_name || '', deliveryOption: order.delivery_option || '', shippingProviderName: order.logistics_carrier || '', sales: 0, refund: 0, refundLoaded: false, refunded: false, warehouseCost: 0, warehouseCostCharged: false, warehouseCostStatus: '', items: [], missingRate: false };
      if (sales === null) entry.missingRate = true; else entry.sales += sales;
      if (!entry.refundLoaded) { const convertedRefund = convertAmount(Number(order.refund_amount || 0), currency, date); if (convertedRefund === null) entry.missingRate = true; else entry.refund = convertedRefund; entry.refundLoaded = true; }
      entry.refunded ||= Boolean(String(item.cancellation_return_type || order.refund_status || '').trim() && !/^(无退款|none|n\/a|—|-|0)$/i.test(String(item.cancellation_return_type || order.refund_status || '').trim()));
      entry.items.push(item); profitOrders.set(key, entry);
    }
    const mappingValues = value => String(value || '').split(/[、,，]/).map(item => item.trim()).filter(Boolean);
    const matchingWarehouses = order => {
      const orderCarrier = String(order.shippingProviderName || '').trim();
      return (fulfillmentWarehouses || []).filter(warehouse => {
        const configuredCarriers = mappingValues(warehouse.shipping_provider_name);
        // 订单和仓库配置的承运商都为空时允许匹配；订单有承运商时必须精确匹配，
        // 避免把不同承运商的订单错误计入同一仓库费用。
        const carrierMatches = orderCarrier
          ? configuredCarriers.includes(orderCarrier)
          : configuredCarriers.length === 0;
        return warehouseShopIds.get(warehouse.id)?.has(order.shopId) &&
          mappingValues(warehouse.original_warehouse_name).includes(String(order.warehouseName || '').trim()) &&
          mappingValues(warehouse.delivery_option).includes(String(order.deliveryOption || '').trim()) &&
          carrierMatches;
      });
    };
    const matchingCostVersion = (warehouseId, orderDate) => (fulfillmentCostVersions || []).find(version => version.warehouse_id === warehouseId && version.effective_date <= orderDate);
    const productByWarehouseAndCode = new Map((fulfillmentProducts || []).map(product => [`${product.warehouse_id}::${String(product.product_code || '').trim()}`, product]));
    const matchingProductCostVersion = (warehouseId, productCode, orderDate) => (productCostVersions || []).find(version => version.warehouse_id === warehouseId && String(version.product_code || '').trim() === productCode && version.effective_date <= orderDate);
    const processedChargeKeys = new Set();
    [...profitOrders.values()].sort((left, right) => left.date.localeCompare(right.date) || left.number.localeCompare(right.number)).forEach(order => {
      const trackingNumber = String(order.trackingNumber || '').trim();
      const pendingShipment = /待发货|to\s*ship|awaiting\s*shipment|ready\s*to\s*ship/i.test(String(order.orderStatus || '').trim());
      const cancelled = /取消|cancel/i.test(String(order.orderStatus || '').trim());
      // 优先级 1：Tracking ID 非空的订单参与计费；优先级 2：无 Tracking ID 时，仅待发货订单参与计费。
      // 已取消且无 Tracking ID 属于正常不计费，其他无单号非待发货订单同样不进入异常待补。
      if (!trackingNumber && cancelled) { order.warehouseCostStatus = 'cancelled'; order.productCostEligibility = 'cancelled'; return; }
      if (!trackingNumber && !pendingShipment) { order.warehouseCostStatus = 'not_eligible'; order.productCostEligibility = 'not_eligible'; return; }
      const warehouses = matchingWarehouses(order);
      if (!warehouses.length) { order.warehouseCostStatus = 'warehouse_unmatched'; order.productCostEligibility = 'warehouse_unmatched'; return; }
      if (warehouses.length > 1) { order.warehouseCostStatus = 'warehouse_ambiguous'; order.productCostEligibility = 'warehouse_ambiguous'; return; }
      const warehouse = warehouses[0];
      order.matchedWarehouseId = warehouse.id;
      order.productCostEligibility = trackingNumber ? 'eligible' : (pendingShipment ? 'eligible' : (cancelled ? 'cancelled' : 'not_eligible'));
      const version = matchingCostVersion(warehouse.id, order.date);
      if (!version) { order.warehouseCostStatus = 'version_missing'; return; }
      // 同一 Tracking ID 仅计一次；无单号待发货订单按店铺 + 订单 ID 作为临时唯一键。
      const trackingKey = trackingNumber ? `tracking:${trackingNumber}` : `pending:${order.shopId}:${order.number}`;
      if (processedChargeKeys.has(trackingKey)) { order.warehouseCostStatus = 'duplicate'; return; }
      processedChargeKeys.add(trackingKey);
      const converted = convertAmount(Number(version.amount || 0), version.currency_code || 'CNY', order.date);
      if (converted === null) { order.missingRate = true; order.warehouseCostStatus = 'rate_missing'; return; }
      order.warehouseCost = converted; order.warehouseCostCharged = true; order.warehouseCostStatus = 'charged';
    });
    const profitBills = new Map();
    for (const bill of bills) {
      const key = `${bill.shop_id}::${String(bill.related_order_id || '').trim()}`;
      if (!profitOrders.has(key)) continue;
      const bucket = profitBills.get(key) || { settled: [], unsettled: [] };
      bucket[bill.source_type === 'settled' ? 'settled' : 'unsettled'].push(bill);
      profitBills.set(key, bucket);
    }
    const selectedBillsByOrder = new Map();
    const productBillIndex = new Map();
    profitOrders.forEach((order, orderKey) => {
      const bucket = profitBills.get(orderKey);
      const selectedBills = bucket?.settled?.length ? bucket.settled : (bucket?.unsettled || []);
      selectedBillsByOrder.set(orderKey, selectedBills);
      selectedBills.forEach(bill => {
        const sku = String(bill.sku_id || '').trim();
        if (!sku) return;
        const productBillKey = `${orderKey}::${sku}`;
        const indexedBills = productBillIndex.get(productBillKey) || [];
        indexedBills.push(bill);
        productBillIndex.set(productBillKey, indexedBills);
      });
    });
    const billTotals = (records, order) => records.reduce((total, bill) => {
      const currency = bill.currency_code || order.currency;
      const amount = convertAmount(billDisplayAmount(bill), currency, order.date);
      const fee = convertAmount(Number(bill.total_fees || 0), currency, order.date);
      const income = convertAmount(Number(bill.total_income || 0), currency, order.date);
      const promotionRaw = Object.entries(bill.fee_breakdown || {}).filter(([name]) => /广告|推广|gmv max|promotion|advert/i.test(name)).reduce((sum, [, value]) => sum + Math.abs(Number(value || 0)), 0);
      const promotion = convertAmount(promotionRaw, currency, order.date);
      if (amount === null || fee === null || income === null || promotion === null) total.missingRate = true;
      else {
        total.settlement += amount;
        total.platform += Math.abs(fee);
        total.totalIncome += income;
        total.totalFees += Math.abs(fee);
        total.promotion += Math.abs(promotion);
        Object.entries(bill.fee_breakdown || {}).forEach(([name, value]) => {
          const converted = convertAmount(Number(value || 0), currency, order.date);
          if (converted === null) { total.missingRate = true; return; }
          total.feeBreakdown[name] = Number(total.feeBreakdown[name] || 0) + converted;
        });
      }
      return total;
    }, { settlement: 0, platform: 0, promotion: 0, totalIncome: 0, totalFees: 0, feeBreakdown: {}, missingRate: false });
    const warehouseStatusField = {
      charged: 'chargedWarehouseCostCount',
      duplicate: 'duplicateWarehouseCostCount',
      cancelled: 'cancelledWarehouseCostCount',
      not_eligible: 'nonEligibleWarehouseCostCount',
      warehouse_unmatched: 'warehouseConfigUnmatched',
      warehouse_ambiguous: 'warehouseConfigAmbiguous',
      version_missing: 'warehouseCostVersionMissing',
      rate_missing: 'warehouseCostRateMissing'
    };
    const markWarehouseStatus = (target, order, orderKey) => {
      const status = order.warehouseCostStatus || 'not_eligible';
      const field = warehouseStatusField[status];
      if (!field) return;
      const seen = target.warehouseStatusOrderKeys || new Set();
      target.warehouseStatusOrderKeys = seen;
      const marker = `${status}:${orderKey}`;
      if (seen.has(marker)) return;
      seen.add(marker);
      target[field] = Number(target[field] || 0) + 1;
    };
    const productCostStatusField = {
      warehouse_unmatched: 'productWarehouseUnmatched', warehouse_ambiguous: 'productWarehouseAmbiguous', sku_missing: 'productSkuMissing',
      product_missing: 'productCostMissing', quantity_invalid: 'productQuantityInvalid', version_missing: 'productCostVersionMissing',
      rate_missing: 'productCostRateMissing', not_eligible: 'productCostNonEligible'
    };
    const markProductCostStatus = (target, result, lineKey) => {
      const field = productCostStatusField[result.status];
      if (!field) return;
      const seen = target.productCostStatusLineKeys || new Set();
      target.productCostStatusLineKeys = seen;
      const marker = `${result.status}:${lineKey}`;
      if (seen.has(marker)) return;
      seen.add(marker);
      target[field] = Number(target[field] || 0) + 1;
    };
    const warehouseAllocationsFor = order => {
      if (!order.warehouseCostCharged || !Number(order.warehouseCost || 0) || !order.items.length) return order.items.map(() => 0);
      const lines = order.items.map(item => {
        const raw = Number(item.sku_subtotal_after_discount || 0) + Number(item.shipping_fee_after_discount || 0) - Number(item.payment_platform_discount || 0);
        const sales = convertAmount(raw, order.currency, order.date);
        return { sales: sales === null ? 0 : Math.max(0, Number(sales || 0)), qty: Math.max(0, Number(item.quantity || 0)) };
      });
      const salesTotal = lines.reduce((sum, line) => sum + line.sales, 0);
      const qtyTotal = lines.reduce((sum, line) => sum + line.qty, 0);
      const divisor = salesTotal || qtyTotal || lines.length;
      let allocated = 0;
      return lines.map((line, index) => {
        if (index === lines.length - 1) return Number((Number(order.warehouseCost) - allocated).toFixed(2));
        const weight = salesTotal ? line.sales : (qtyTotal ? line.qty : 1);
        const amount = Number((Number(order.warehouseCost) * weight / divisor).toFixed(2));
        allocated += amount;
        return amount;
      });
    };
    // 退款金额记录在订单层级。商品利润按商品行销售额分摊；若销售额为 0，
    // 则按数量分摊，保证同一订单的退款不会在多个 SKU 上重复计算。
    const refundAllocationsFor = order => {
      if (!Number(order.refund || 0) || !order.items.length) return order.items.map(() => 0);
      const lines = order.items.map(item => {
        const raw = Number(item.sku_subtotal_after_discount || 0) + Number(item.shipping_fee_after_discount || 0) - Number(item.payment_platform_discount || 0);
        const sales = convertAmount(raw, order.currency, order.date);
        return { sales: sales === null ? 0 : Math.max(0, Number(sales || 0)), qty: Math.max(0, Number(item.quantity || 0)) };
      });
      const salesTotal = lines.reduce((sum, line) => sum + line.sales, 0);
      const qtyTotal = lines.reduce((sum, line) => sum + line.qty, 0);
      const divisor = salesTotal || qtyTotal || lines.length;
      let allocated = 0;
      return lines.map((line, index) => {
        if (index === lines.length - 1) return Number((Number(order.refund) - allocated).toFixed(2));
        const weight = salesTotal ? line.sales : (qtyTotal ? line.qty : 1);
        const amount = Number((Number(order.refund) * weight / divisor).toFixed(2));
        allocated += amount;
        return amount;
      });
    };
    // 商品成本按订单明细行计算。运单去重只适用于仓库代发费用；同一运单中的
    // 多个 SKU 都必须各自按数量计商品成本。
    const productCostFor = (order, item) => {
      const eligibility = order.productCostEligibility || 'not_eligible';
      if (eligibility === 'cancelled') return { amount: 0, status: 'cancelled' };
      if (eligibility === 'not_eligible') return { amount: 0, status: 'not_eligible' };
      if (eligibility === 'warehouse_unmatched' || eligibility === 'warehouse_ambiguous') return { amount: null, status: eligibility };
      const productCode = String(item.seller_sku || item.product_code || '').trim();
      if (!productCode) return { amount: null, status: 'sku_missing' };
      const product = productByWarehouseAndCode.get(`${order.matchedWarehouseId || ''}::${productCode}`);
      if (!product) return { amount: null, status: 'product_missing' };
      const quantity = Number(item.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0) return { amount: null, status: 'quantity_invalid', product, productCode };
      const version = matchingProductCostVersion(order.matchedWarehouseId, productCode, order.date);
      if (!version) return { amount: null, status: 'version_missing', product, productCode };
      const converted = convertAmount(Number(version.amount || 0) * quantity, version.currency_code || product.currency_code || 'CNY', order.date);
      if (converted === null) return { amount: null, status: 'rate_missing', product, productCode };
      return { amount: Number(converted), status: 'charged', product, productCode, version };
    };
    const storeProfitMap = new Map();
    // 日期视图与店铺视图使用同一批订单、账单、成本与汇率口径，仅聚合维度不同。
    const dateProfitMap = new Map();
    const productCostMissingExports = [];
    const productWarehouseCostMissingExports = [];
    const settlementUnmatchedExports = [];
    profitOrders.forEach((order, key) => {
      const chosenBills = selectedBillsByOrder.get(key) || [];
      const totals = billTotals(chosenBills, order);
      const store = storeProfitMap.get(order.shopId) || { shopId: order.shopId, shop: order.shop, site: order.site, validOrders: 0, refundOrderCount: 0, sales: 0, refund: 0, platform: 0, settlement: 0, promotion: 0, productCost: 0, billTotalIncome: 0, billTotalFees: 0, billFeeBreakdown: {}, missingSettlement: 0, missingRate: 0 };
      const dateRow = dateProfitMap.get(order.date) || { shopId: `date:${order.date}`, shop: order.date, site: '全部店铺', date: order.date, validOrders: 0, refundOrderCount: 0, sales: 0, refund: 0, platform: 0, settlement: 0, promotion: 0, productCost: 0, billTotalIncome: 0, billTotalFees: 0, billFeeBreakdown: {}, missingSettlement: 0, missingRate: 0 };
      store.validOrders += 1;
      dateRow.validOrders += 1;
      if (order.refunded) store.refundOrderCount += 1;
      if (order.refunded) dateRow.refundOrderCount += 1;
      store.sales += order.sales;
      dateRow.sales += order.sales;
      store.refund += order.refund;
      dateRow.refund += order.refund;
      store.platform += totals.platform;
      dateRow.platform += totals.platform;
      store.settlement += totals.settlement;
      dateRow.settlement += totals.settlement;
      store.billTotalIncome += totals.totalIncome;
      dateRow.billTotalIncome += totals.totalIncome;
      store.billTotalFees += totals.totalFees;
      dateRow.billTotalFees += totals.totalFees;
      Object.entries(totals.feeBreakdown).forEach(([name, amount]) => { store.billFeeBreakdown[name] = Number(store.billFeeBreakdown[name] || 0) + Number(amount || 0); });
      Object.entries(totals.feeBreakdown).forEach(([name, amount]) => { dateRow.billFeeBreakdown[name] = Number(dateRow.billFeeBreakdown[name] || 0) + Number(amount || 0); });
      // 店铺推广费以推广管理按“店铺 + 日期”归集的费用为唯一口径，避免重复扣减账单明细费用。
      if (!chosenBills.length) {
        if (/取消|cancel/i.test(String(order.orderStatus || ''))) store.cancelledUnsettledOrderCount = Number(store.cancelledUnsettledOrderCount || 0) + 1;
        if (/取消|cancel/i.test(String(order.orderStatus || ''))) dateRow.cancelledUnsettledOrderCount = Number(dateRow.cancelledUnsettledOrderCount || 0) + 1;
        else {
          store.missingSettlement += 1;
          dateRow.missingSettlement += 1;
          settlementUnmatchedExports.push({
            shop: order.shop,
            site: order.site,
            orderedAt: order.date,
            orderNumber: order.number,
            trackingNumber: order.trackingNumber,
            orderStatus: order.orderStatus,
            skuIds: [...new Set(order.items.map(item => String(item.sku_id || '').trim()).filter(Boolean))].join(' | '),
            productCodes: [...new Set(order.items.map(item => String(item.seller_sku || item.product_code || '').trim()).filter(Boolean))].join(' | '),
            productNames: [...new Set(order.items.map(item => String(item.product_name || '').trim()).filter(Boolean))].join(' | '),
            warehouseName: order.warehouseName,
            deliveryOption: order.deliveryOption,
            shippingProviderName: order.shippingProviderName,
            reason: '未找到对应订单 ID 的有效已结算或未结算账单'
          });
        }
      }
      if (order.missingRate || totals.missingRate) store.missingRate += 1;
      if (order.missingRate || totals.missingRate) dateRow.missingRate += 1;
      storeProfitMap.set(order.shopId, store);
      dateProfitMap.set(order.date, dateRow);
      const warehouseAllocations = warehouseAllocationsFor(order);
      const refundAllocations = refundAllocationsFor(order);
      order.items.forEach((item, itemIndex) => {
        const lineKey = String(item.id || `${key}:${itemIndex}`);
        const productCostResult = productCostFor(order, item);
        const productCode = String(productCostResult.productCode || item.seller_sku || item.product_code || '').trim();
        if (productCostResult.status === 'warehouse_unmatched') {
          productWarehouseCostMissingExports.push({
            shop: order.shop,
            site: order.site,
            orderedAt: order.date,
            orderNumber: order.number,
            trackingNumber: order.trackingNumber,
            orderStatus: order.orderStatus,
            skuId: item.sku_id || '',
            productCode,
            productName: item.product_name || '',
            quantity: item.quantity || '',
            warehouseName: order.warehouseName,
            deliveryOption: order.deliveryOption,
            shippingProviderName: order.shippingProviderName,
            reason: '店铺已授权仓库中，未找到同时匹配 Warehouse Name、Delivery Option、Shipping Provider Name 的仓库配置'
          });
        }
        if (productCostResult.status === 'product_missing') {
          const matchedWarehouse = fulfillmentWarehouses.find(warehouse => warehouse.id === order.matchedWarehouseId);
          productCostMissingExports.push({
            shop: order.shop,
            site: order.site,
            orderedAt: order.date,
            orderNumber: order.number,
            trackingNumber: order.trackingNumber,
            orderStatus: order.orderStatus,
            skuId: item.sku_id || '',
            productCode,
            productName: item.product_name || '',
            quantity: item.quantity || '',
            warehouseName: order.warehouseName,
            deliveryOption: order.deliveryOption,
            shippingProviderName: order.shippingProviderName,
            matchedWarehouse: matchedWarehouse?.name || '',
            reason: '商品管理中未找到“匹配仓库 + 商品编码”的可用商品成本'
          });
        }
        const sku = String(item.sku_id || productCode || item.product_name || 'no-sku');
        const productKey = `${order.shopId}::${sku}`;
        const product = profitProducts.get(productKey) || { shopId: order.shopId, shop: order.shop, site: order.site, code: productCode || '—', sku: item.sku_id || '—', name: productCostResult.product?.product_name || productNameByCode.get(productCode) || '—', linkNames: new Set(), qty: 0, orderKeys: new Set(), refunds: new Set(), appliedBillIds: new Set(), missingSettlementOrderKeys: new Set(), cancelledUnsettledOrderKeys: new Set(), sales: 0, refund: 0, settlement: 0, platform: 0, promotion: 0, productCost: 0, warehouseCost: 0, billTotalIncome: 0, billTotalFees: 0, billFeeBreakdown: {}, missingRate: false };
        const linkName = String(item.product_name || '').trim();
        if (linkName) product.linkNames.add(linkName);
        product.qty += Number(item.quantity || 0);
        product.orderKeys.add(key);
        if (order.refunded) product.refunds.add(key);
        const itemSales = Number(item.sku_subtotal_after_discount || 0) + Number(item.shipping_fee_after_discount || 0) - Number(item.payment_platform_discount || 0);
        const convertedItemSales = convertAmount(itemSales, order.currency, order.date);
        if (convertedItemSales === null) product.missingRate = true; else product.sales += convertedItemSales;
        product.refund += Number(refundAllocations[itemIndex] || 0);
        const indexedBills = productBillIndex.get(`${key}::${String(item.sku_id || '').trim()}`) || [];
        const productBills = indexedBills.filter(bill => !product.appliedBillIds.has(bill.id));
        productBills.forEach(bill => product.appliedBillIds.add(bill.id));
        const productTotals = billTotals(productBills, order);
        product.settlement += productTotals.settlement;
        product.platform += productTotals.platform;
        product.promotion += productTotals.promotion;
        product.billTotalIncome += productTotals.totalIncome;
        product.billTotalFees += productTotals.totalFees;
        Object.entries(productTotals.feeBreakdown || {}).forEach(([name, amount]) => {
          product.billFeeBreakdown[name] = Number(product.billFeeBreakdown[name] || 0) + Number(amount || 0);
        });
        if (productCostResult.amount !== null) {
          product.productCost += productCostResult.amount;
          store.productCost += productCostResult.amount;
          dateRow.productCost += productCostResult.amount;
        }
        markProductCostStatus(product, productCostResult, lineKey);
        markProductCostStatus(store, productCostResult, lineKey);
        markProductCostStatus(dateRow, productCostResult, `${order.date}:${lineKey}`);
        product.warehouseCost += Number(warehouseAllocations[itemIndex] || 0);
        markWarehouseStatus(product, order, key);
        product.missingRate ||= productTotals.missingRate;
        // 用原始 SKU 账单匹配结果判断缺失，不能因为同订单的重复明细已分摊账单而误报。
        if (!indexedBills.length) {
          if (/取消|cancel/i.test(String(order.orderStatus || ''))) product.cancelledUnsettledOrderKeys.add(key);
          else product.missingSettlementOrderKeys.add(key);
        }
        profitProducts.set(productKey, product);
      });
    });
    profitOrders.forEach(order => {
      const store = storeProfitMap.get(order.shopId);
      const dateRow = dateProfitMap.get(order.date);
      if (!store) return;
      store.warehouse = Number(store.warehouse || 0) + Number(order.warehouseCost || 0);
      markWarehouseStatus(store, order, `${order.shopId}::${order.number}`);
      if (dateRow) {
        dateRow.warehouse = Number(dateRow.warehouse || 0) + Number(order.warehouseCost || 0);
        markWarehouseStatus(dateRow, order, `${order.date}::${order.shopId}::${order.number}`);
      }
    });
    const statusItemsFor = row => {
      const items = [];
      if (row.missingSettlement) items.push({ code: '结算未匹配', label: `结算未匹配 ${row.missingSettlement} 笔` });
      if (row.cancelledUnsettledOrderCount) items.push({ code: '已取消未结算', label: `已取消未结算 ${row.cancelledUnsettledOrderCount} 笔` });
      if (row.warehouseConfigUnmatched) items.push({ code: '仓库配置未匹配', label: `仓库配置未匹配 ${row.warehouseConfigUnmatched} 笔` });
      if (row.warehouseConfigAmbiguous) items.push({ code: '仓库配置重复', label: `仓库配置重复 ${row.warehouseConfigAmbiguous} 笔` });
      if (row.warehouseCostVersionMissing) items.push({ code: '代发费用版本缺失', label: `代发费用版本缺失 ${row.warehouseCostVersionMissing} 笔` });
      if (row.warehouseCostRateMissing) items.push({ code: '代发费用汇率缺失', label: `代发费用汇率缺失 ${row.warehouseCostRateMissing} 笔` });
      if (row.productWarehouseUnmatched) items.push({ code: '商品仓库成本未匹配', label: `商品仓库成本未匹配 ${row.productWarehouseUnmatched} 条` });
      if (row.productWarehouseAmbiguous) items.push({ code: '商品仓库成本匹配重复', label: `商品仓库成本匹配重复 ${row.productWarehouseAmbiguous} 条` });
      if (row.productSkuMissing) items.push({ code: '商品编码缺失', label: `商品编码缺失 ${row.productSkuMissing} 条` });
      if (row.productCostMissing) items.push({ code: '商品成本待补', label: `商品成本待补 ${row.productCostMissing} 条` });
      if (row.productQuantityInvalid) items.push({ code: '商品数量异常', label: `商品数量异常 ${row.productQuantityInvalid} 条` });
      if (row.productCostVersionMissing) items.push({ code: '商品成本版本缺失', label: `商品成本版本缺失 ${row.productCostVersionMissing} 条` });
      if (row.productCostRateMissing) items.push({ code: '商品成本汇率缺失', label: `商品成本汇率缺失 ${row.productCostRateMissing} 条` });
      if (row.productCostNonEligible) items.push({ code: '商品成本非计费状态', label: `商品成本非计费状态 ${row.productCostNonEligible} 条` });
      if (row.missingRate) items.push({ code: '汇率缺失', label: `汇率缺失 ${row.missingRate} 笔` });
      return items;
    };
    storeProfitMap.forEach((store, shopId) => {
      store.promotion = Number((promotionByShop.get(shopId) || 0).toFixed(2));
    });
    promotionByShopDate.forEach((amount, shopDateKey) => {
      const date = shopDateKey.split('::').slice(1).join('::');
      const dateRow = dateProfitMap.get(date);
      if (dateRow) dateRow.promotion = Number((Number(dateRow.promotion || 0) + Number(amount || 0)).toFixed(2));
    });

    const normalizeStore = row => {
      const statusItems = statusItemsFor(row);
      const warehouseCostMissingOrderCount = Number(row.warehouseConfigUnmatched || 0) + Number(row.warehouseConfigAmbiguous || 0) + Number(row.warehouseCostVersionMissing || 0) + Number(row.warehouseCostRateMissing || 0);
      const { warehouseStatusOrderKeys, productCostStatusLineKeys, ...store } = row;
      const settlement = Number(row.settlement || 0), productCost = Number(row.productCost || 0), warehouseCost = Number(row.warehouse || 0), promotion = Number(row.promotion || 0);
      const totalCost = productCost + warehouseCost + promotion;
      const netProfit = settlement - totalCost;
      const netMargin = Number(row.sales || 0) ? netProfit / Number(row.sales || 0) * 100 : null;
      const billFeeBreakdown = Object.fromEntries(Object.entries(row.billFeeBreakdown || {}).map(([name, amount]) => [name, Number(Number(amount || 0).toFixed(2))]));
      return { ...store, productCost, warehouseCost, totalCost: Number(totalCost.toFixed(2)), billTotalIncome: Number(Number(row.billTotalIncome || 0).toFixed(2)), billTotalFees: Number(Number(row.billTotalFees || 0).toFixed(2)), billFeeBreakdown, warehouseCostMatchedOrderCount: Number(row.chargedWarehouseCostCount || 0), warehouseCostDuplicateOrderCount: Number(row.duplicateWarehouseCostCount || 0), warehouseCostCancelledOrderCount: Number(row.cancelledWarehouseCostCount || 0), warehouseCostNonEligibleOrderCount: Number(row.nonEligibleWarehouseCostCount || 0), warehouseCostMissingOrderCount, netProfit: Number(netProfit.toFixed(2)), netMargin: netMargin === null ? null : Number(netMargin.toFixed(2)), refundRate: row.validOrders ? Number((row.refundOrderCount / row.validOrders * 100).toFixed(2)) : 0, statusItems, dataState: statusItems.length ? statusItems.map(item => item.label).join('｜') : '正常' };
    };
    const normalizeProduct = row => {
      const validOrders = row.orderKeys.size;
      const missingSettlement = row.missingSettlementOrderKeys?.size || 0;
      const cancelledUnsettledOrderCount = row.cancelledUnsettledOrderKeys?.size || 0;
      const statusItems = statusItemsFor({ ...row, missingSettlement, cancelledUnsettledOrderCount, missingRate: row.missingRate ? validOrders : 0 });
      const { warehouseStatusOrderKeys, productCostStatusLineKeys, missingSettlementOrderKeys, cancelledUnsettledOrderKeys, linkNames, ...product } = row;
      const settlement = Number(row.settlement || 0), productCost = Number(row.productCost || 0), warehouseCost = Number(row.warehouseCost || 0), promotion = Number(row.promotion || 0);
      const totalCost = productCost + warehouseCost + promotion;
      const netProfit = settlement - totalCost;
      const netMargin = Number(row.sales || 0) ? netProfit / Number(row.sales || 0) * 100 : null;
      const billFeeBreakdown = Object.fromEntries(Object.entries(row.billFeeBreakdown || {}).map(([name, amount]) => [name, Number(Number(amount || 0).toFixed(2))]));
      return { ...product, linkName: [...(linkNames || [])].join('｜') || '—', validOrders, refundCount: row.refunds.size, missingSettlement, cancelledUnsettledOrderCount, refund: Number(Number(row.refund || 0).toFixed(2)), productCost, warehouseCost, totalCost: Number(totalCost.toFixed(2)), billTotalIncome: Number(Number(row.billTotalIncome || 0).toFixed(2)), billTotalFees: Number(Number(row.billTotalFees || 0).toFixed(2)), billFeeBreakdown, warehouseCostMatchedOrderCount: Number(row.chargedWarehouseCostCount || 0), warehouseCostDuplicateOrderCount: Number(row.duplicateWarehouseCostCount || 0), warehouseCostCancelledOrderCount: Number(row.cancelledWarehouseCostCount || 0), warehouseCostNonEligibleOrderCount: Number(row.nonEligibleWarehouseCostCount || 0), warehouseCostMissingOrderCount: Number(row.warehouseConfigUnmatched || 0) + Number(row.warehouseConfigAmbiguous || 0) + Number(row.warehouseCostVersionMissing || 0) + Number(row.warehouseCostRateMissing || 0), netProfit: Number(netProfit.toFixed(2)), netMargin: netMargin === null ? null : Number(netMargin.toFixed(2)), refundRate: validOrders ? Number((row.refunds.size / validOrders * 100).toFixed(2)) : 0, statusItems, dataState: statusItems.length ? statusItems.map(item => item.label).join('｜') : '正常' };
    };
    const profitReport = {
      stores: [...storeProfitMap.values()].map(normalizeStore).sort((a, b) => b.sales - a.sales),
      dates: [...dateProfitMap.values()].map(normalizeStore).sort((a, b) => String(a.date).localeCompare(String(b.date))),
      products: [...profitProducts.values()].map(normalizeProduct).sort((a, b) => b.sales - a.sales)
    };
    const data = buildDashboardData(profitReport);
    dashboardOverviewCache.set(cacheKey, { createdAt: Date.now(), data });
    if (exportProductCostMissing) {
      const header = ['店铺', '国家站点', '下单日期', '订单 ID', 'Tracking ID', '订单状态', 'SKU ID', '商品编码', '订单商品名称', '数量', '订单 Warehouse Name', '订单 Delivery Option', '订单 Shipping Provider Name', '已匹配仓库', '待补原因'];
      const rows = productCostMissingExports.map(item => [item.shop, item.site, item.orderedAt, item.orderNumber, item.trackingNumber, item.orderStatus, item.skuId, item.productCode, item.productName, item.quantity, item.warehouseName, item.deliveryOption, item.shippingProviderName, item.matchedWarehouse, item.reason]);
      const csv = [header, ...rows].map(row => row.map(value => `"${String(value ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
      response.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="product-cost-missing_${start}_to_${end}.csv"`, 'Cache-Control': 'no-store, max-age=0' });
      response.end(`\uFEFF${csv}`);
      return;
    }
    if (exportProductWarehouseCostMissing) {
      const header = ['店铺', '国家站点', '下单日期', '订单 ID', 'Tracking ID', '订单状态', 'SKU ID', '商品编码', '订单商品名称', '数量', '订单 Warehouse Name', '订单 Delivery Option', '订单 Shipping Provider Name', '待补原因'];
      const rows = productWarehouseCostMissingExports.map(item => [item.shop, item.site, item.orderedAt, item.orderNumber, item.trackingNumber, item.orderStatus, item.skuId, item.productCode, item.productName, item.quantity, item.warehouseName, item.deliveryOption, item.shippingProviderName, item.reason]);
      const csv = [header, ...rows].map(row => row.map(value => `"${String(value ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
      response.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="product-warehouse-cost-missing_${start}_to_${end}.csv"`, 'Cache-Control': 'no-store, max-age=0' });
      response.end(`\uFEFF${csv}`);
      return;
    }
    if (exportSettlementUnmatched) {
      const header = ['店铺', '国家站点', '下单日期', '订单 ID', 'Tracking ID', '订单状态', 'SKU ID', '商品编码', '订单商品名称', '订单 Warehouse Name', '订单 Delivery Option', '订单 Shipping Provider Name', '待补原因'];
      const rows = settlementUnmatchedExports.map(item => [item.shop, item.site, item.orderedAt, item.orderNumber, item.trackingNumber, item.orderStatus, item.skuIds, item.productCodes, item.productNames, item.warehouseName, item.deliveryOption, item.shippingProviderName, item.reason]);
      const csv = [header, ...rows].map(row => row.map(value => `"${String(value ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
      response.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="settlement-unmatched_${start}_to_${end}.csv"`, 'Cache-Control': 'no-store, max-age=0' });
      response.end(`\uFEFF${csv}`);
      return;
    }
    sendJson(response, 200, data);
  } catch (error) { adminError(response, error); }
}
async function listBusinessDashboardAlerts(request, response) {
  try {
    const accessToken = bearerToken(request);
    if (!accessToken) throw new Error('UNAUTHORIZED');
    const identity = await getAuthenticatedProfile(accessToken);
    const isPrivileged = identity.roles.some(role => ['finance', 'admin', 'super_admin'].includes(role));
    const requestUrl = new URL(request.url, `http://${request.headers.host}`);
    const reportCurrency = String(requestUrl.searchParams.get('currency') || 'CNY').toUpperCase();
    const rateType = String(requestUrl.searchParams.get('rateType') || 'settlement');
    if (!QUOTE_CURRENCIES.has(reportCurrency)) throw new Error('报表币种仅支持 CNY 或 USD');
    if (!['settlement', 'reference'].includes(rateType)) throw new Error('汇率取值参数无效');
    const today = new Date().toISOString().slice(0, 10);
    const yesterdayDate = new Date(`${today}T00:00:00Z`); yesterdayDate.setUTCDate(yesterdayDate.getUTCDate() - 1);
    const defaultEnd = yesterdayDate.toISOString().slice(0, 10);
    const defaultStartDate = new Date(`${defaultEnd}T00:00:00Z`); defaultStartDate.setUTCDate(defaultStartDate.getUTCDate() - 6);
    const start = /^\d{4}-\d{2}-\d{2}$/.test(String(requestUrl.searchParams.get('start') || '')) ? String(requestUrl.searchParams.get('start')) : defaultStartDate.toISOString().slice(0, 10);
    const end = /^\d{4}-\d{2}-\d{2}$/.test(String(requestUrl.searchParams.get('end') || '')) ? String(requestUrl.searchParams.get('end')) : defaultEnd;
    if (start > end) throw new Error('开始日期不能晚于结束日期');
    if (end >= today) throw new Error('检测预警仅统计截至昨日的完整自然日数据');
    const requestedShopIds = [...new Set(String(requestUrl.searchParams.get('shopId') || '').split(',').map(value => value.trim()).filter(Boolean))];
    const requestedSite = String(requestUrl.searchParams.get('site') || '').trim();
    const cacheKey = `${identity.profile.id}:${requestedShopIds.join(',') || 'all'}:${requestedSite || 'all'}:${start}:${end}:${reportCurrency}:${rateType}`;
    const cached = dashboardAlertsCache.get(cacheKey);
    if (cached && Date.now() - cached.createdAt < DASHBOARD_ALERTS_CACHE_TTL) return sendJson(response, 200, cached.data);
    if (localDatabaseEnabled()) {
      const shops = await localBusinessVisibleShops(identity);
      const visibleShopIds = shops.map(shop => shop.id);
      if (requestedShopIds.some(shopId => !visibleShopIds.includes(shopId))) throw new Error('无权查看该店铺数据');
      const scopedShopIds = (requestedShopIds.length ? requestedShopIds : visibleShopIds).filter(shopId => !requestedSite || shops.some(shop => shop.id === shopId && shop.country_code === requestedSite));
      const itemRows = scopedShopIds.length ? (await localQuery(`select i.product_code, o.shop_id, o.order_number, o.currency_code, to_char(o.ordered_at at time zone 'UTC', 'YYYY-MM-DD') as ordered_day from public.order_items i join public.orders o on o.id=i.order_id where o.shop_id = any($1::uuid[]) and o.ordered_at >= $2::timestamptz and o.ordered_at <= $3::timestamptz`, [scopedShopIds, `${start}T00:00:00+00:00`, `${end}T23:59:59.999+00:00`])).rows : [];
      const ordersByNumber = new Map(), productCodes = new Set();
      itemRows.forEach(item => { const number = String(item.order_number || '').trim(); if (number) ordersByNumber.set(number, { shopId: item.shop_id, date: item.ordered_day, currency: item.currency_code }); if (item.product_code) productCodes.add(String(item.product_code).trim()); });
      const orderDatesByShop = new Map();
      ordersByNumber.forEach(order => {
        if (!order.shopId || !order.date) return;
        const dates = orderDatesByShop.get(order.shopId) || new Set();
        dates.add(order.date);
        orderDatesByShop.set(order.shopId, dates);
      });
      const suspectedOrderGapDays = [];
      for (const shopId of scopedShopIds) {
        const recordedDates = orderDatesByShop.get(shopId) || new Set();
        const allDates = [];
        for (let cursor = new Date(`${start}T00:00:00Z`), last = new Date(`${end}T00:00:00Z`); cursor <= last; cursor.setUTCDate(cursor.getUTCDate() + 1)) allDates.push(cursor.toISOString().slice(0, 10));
        const firstIndex = allDates.findIndex(date => recordedDates.has(date));
        const lastIndex = allDates.length - 1 - [...allDates].reverse().findIndex(date => recordedDates.has(date));
        if (firstIndex < 0 || lastIndex <= firstIndex) continue;
        allDates.slice(firstIndex + 1, lastIndex).forEach(date => { if (!recordedDates.has(date)) suspectedOrderGapDays.push({ shopId, date }); });
      }
      const productCodeList = [...productCodes].filter(Boolean), orderNumbers = [...ordersByNumber.keys()];
      const [productsResult, batchResult, billResult, ratesResult] = await Promise.all([
        productCodeList.length ? localQuery(`select distinct product_code from public.products where product_code = any($1::text[])`, [productCodeList]) : Promise.resolve({ rows: [] }),
        scopedShopIds.length ? localQuery(`select shop_id, import_type, validation_status, failed_rows, created_at from public.order_import_batches where shop_id = any($1::uuid[]) and created_at >= $2::timestamptz and (validation_status = 'partial' or failed_rows > 0) order by created_at desc limit 200`, [scopedShopIds, `${start}T00:00:00+00:00`]) : Promise.resolve({ rows: [] }),
        orderNumbers.length ? localQuery(`select distinct related_order_id from public.tiktok_bill_records where shop_id = any($1::uuid[]) and related_order_id = any($2::text[]) and source_type = any($3::text[]) and replacement_status = 'active'`, [scopedShopIds, orderNumbers, ['settled', 'unsettled']]) : Promise.resolve({ rows: [] }),
        rateType === 'settlement' ? localQuery(`select base_currency, quote_currency, settlement_rate, effective_date::text as effective_date from public.settlement_exchange_rates where is_active = true and effective_date <= $1::date order by effective_date desc`, [end]) : Promise.resolve({ rows: [] })
      ]);
      const knownCodes = new Set(productsResult.rows.map(row => String(row.product_code || '').trim()));
      const matchedNumbers = new Set(billResult.rows.map(row => String(row.related_order_id || '').trim()));
      const referenceRateData = rateType === 'reference' ? await refreshRates(reportCurrency) : null;
      const rateFor = (baseCurrency, date) => {
        if (baseCurrency === reportCurrency) return true;
        if (rateType === 'reference') return Boolean(referenceRateData?.rates?.find(rate => rate.pair === `${baseCurrency}/${reportCurrency}` && rate.available)?.rate);
        const historicalRates = ratesResult.rows || [];
        if (historicalRates.some(rate => rate.base_currency === baseCurrency && rate.quote_currency === reportCurrency && rate.effective_date <= date)) return true;
        const sourceToCny = historicalRates.find(rate => rate.base_currency === baseCurrency && rate.quote_currency === 'CNY' && rate.effective_date <= date);
        const reportToCny = historicalRates.find(rate => rate.base_currency === reportCurrency && rate.quote_currency === 'CNY' && rate.effective_date <= date);
        if (baseCurrency === 'CNY') return Number(reportToCny?.settlement_rate) > 0;
        if (reportCurrency === 'CNY') return Number(sourceToCny?.settlement_rate) > 0;
        return Number(sourceToCny?.settlement_rate) > 0 && Number(reportToCny?.settlement_rate) > 0;
      };
      const missingProductCodes = productCodeList.filter(code => !knownCodes.has(code)), unmatchedOrderNumbers = orderNumbers.filter(number => !matchedNumbers.has(number));
      const missingRateOrderNumbers = orderNumbers.filter(number => { const order = ordersByNumber.get(number); return order?.currency && !rateFor(order.currency, order.date); });
      const failedByShop = new Map(); batchResult.rows.forEach(batch => failedByShop.set(batch.shop_id, true));
      const shopNameById = new Map(shops.map(shop => [shop.id, shop.shop_code || shop.shop_name || '未知店铺'])); const syncShopIds = [...failedByShop.keys()];
      const detailsForShops = ids => [...new Set(ids)].map(id => shopNameById.get(id) || '未知店铺').slice(0, 3).join('、'); const alerts = [];
      if (syncShopIds.length) alerts.push({ id: 'sync-failed', level: 'high', title: '店铺数据同步失败', count: syncShopIds.length, detail: `${detailsForShops(syncShopIds)}${syncShopIds.length > 3 ? '等' : ''} · 存在导入失败或部分完成批次`, suggestion: '请检查导入记录中的失败原因并重新导入。', scope: '导入批次状态为部分完成，或存在失败行。' });
      if (suspectedOrderGapDays.length) alerts.push({ id: 'order-date-gap', level: 'high', title: '订单数据疑似缺失', count: suspectedOrderGapDays.length, detail: `${suspectedOrderGapDays.slice(0, 6).map(item => `${shopNameById.get(item.shopId) || '未知店铺'} ${item.date}`).join('、')}${suspectedOrderGapDays.length > 6 ? ' 等' : ''} · 前后日期均有订单，当天没有任何订单明细`, suggestion: '请在同步助手按该日期重新同步订单并确认导入成功；未补齐前，该店铺利润可能偏高或偏低。', scope: '仅识别筛选范围内部、同店铺前后均有订单但中间日期完全为空的 UTC 日期；自然零订单日会标为“疑似”，需人工核实。', affected: suspectedOrderGapDays });
      if (missingProductCodes.length) alerts.push({ id: 'missing-cost', level: 'medium', title: '商品成本缺失', count: missingProductCodes.length, detail: `${missingProductCodes.length} 个商品编码未匹配商品资料，无法核算商品成本`, suggestion: '请在商品管理中补充对应商品资料和成本后重新核算。', scope: '按当前筛选订单的商品编码，与商品管理资料匹配。' });
      if (unmatchedOrderNumbers.length) alerts.push({ id: 'settlement-unmatched', level: 'medium', title: '结算账单未匹配', count: unmatchedOrderNumbers.length, detail: `${unmatchedOrderNumbers.length} 笔订单尚未匹配已结算或未结算账单`, suggestion: '请核对账单中的“相关订单 ID”并补充导入相应账单。', scope: '订单 ID 未匹配有效的已结算或未结算账单。' });
      if (missingRateOrderNumbers.length) alerts.push({ id: 'missing-rate', level: 'medium', title: `${rateType === 'reference' ? '实时参考汇率' : '报表结算汇率'}缺失`, count: missingRateOrderNumbers.length, detail: `${missingRateOrderNumbers.length} 笔订单缺少换算为 ${reportCurrency} 的汇率`, suggestion: '请在汇率中心补充相应汇率。', scope: '当前筛选范围内订单的币种与报表币种不同。' });
      const data = { start, end, currency: reportCurrency, rateType, alerts, counts: { syncFailedShops: syncShopIds.length, suspectedMissingOrderDays: suspectedOrderGapDays.length, missingProductCodes: missingProductCodes.length, unmatchedOrders: unmatchedOrderNumbers.length, missingRateOrders: missingRateOrderNumbers.length } };
      dashboardAlertsCache.set(cacheKey, { createdAt: Date.now(), data }); return sendJson(response, 200, data);
    }
    const [{ data: permissions, error: permissionsError }, { data: rates, error: ratesError }] = await Promise.all([
      adminClient.from('user_shop_permissions').select('shop_id').eq('user_id', identity.profile.id),
      rateType === 'settlement'
        ? adminClient.from('settlement_exchange_rates').select('base_currency, quote_currency, settlement_rate, effective_date').eq('is_active', true).lte('effective_date', end).order('effective_date', { ascending: false })
        : Promise.resolve({ data: [], error: null })
    ]);
    if (permissionsError || ratesError) throw new Error('读取店铺授权或报表结算汇率失败');
    const referenceRateData = rateType === 'reference' ? await refreshRates(reportCurrency) : null;
    let shopsQuery = adminClient.from('shops').select('id, shop_code, shop_name, country_code').eq('is_active', true);
    if (!isPrivileged) {
      const permittedIds = (permissions || []).map(row => row.shop_id);
      shopsQuery = shopsQuery.in('id', permittedIds.length ? permittedIds : ['00000000-0000-0000-0000-000000000000']);
    }
    const { data: shops, error: shopsError } = await shopsQuery;
    if (shopsError) throw new Error('读取业务端可见店铺失败');
    const visibleShopIds = (shops || []).map(shop => shop.id);
    if (requestedShopIds.some(shopId => !visibleShopIds.includes(shopId))) throw new Error('无权查看该店铺数据');
    const scopedShopIds = (requestedShopIds.length ? requestedShopIds : visibleShopIds).filter(shopId => !requestedSite || (shops || []).some(shop => shop.id === shopId && shop.country_code === requestedSite));
    const safeShopIds = scopedShopIds.length ? scopedShopIds : ['00000000-0000-0000-0000-000000000000'];
    const shopNameById = new Map((shops || []).map(shop => [shop.id, shop.shop_code || shop.shop_name || '未知店铺']));
    const itemRows = [];
    const pageSize = 1000;
    for (let offset = 0; ; offset += pageSize) {
      const page = await adminClient.from('order_items').select('product_code, orders!inner(shop_id, order_number, currency_code, ordered_at)').in('orders.shop_id', safeShopIds).gte('orders.ordered_at', `${start}T00:00:00+00:00`).lte('orders.ordered_at', `${end}T23:59:59.999+00:00`).order('created_at', { ascending: false }).range(offset, offset + pageSize - 1);
      if (page.error) throw new Error('读取订单预警数据失败');
      itemRows.push(...(page.data || []));
      if ((page.data || []).length < pageSize) break;
    }
    const ordersByNumber = new Map();
    const productCodes = new Set();
    itemRows.forEach(item => {
      const order = item.orders || {}, orderNumber = String(order.order_number || '').trim();
      if (orderNumber) ordersByNumber.set(orderNumber, { shopId: order.shop_id, date: businessDatePart(order.ordered_at), currency: order.currency_code });
      if (item.product_code) productCodes.add(String(item.product_code).trim());
    });
    const orderDatesByShop = new Map();
    ordersByNumber.forEach(order => {
      if (!order.shopId || !order.date) return;
      const dates = orderDatesByShop.get(order.shopId) || new Set();
      dates.add(order.date);
      orderDatesByShop.set(order.shopId, dates);
    });
    const suspectedOrderGapDays = [];
    for (const shopId of scopedShopIds) {
      const recordedDates = orderDatesByShop.get(shopId) || new Set();
      const allDates = [];
      for (let cursor = new Date(`${start}T00:00:00Z`), last = new Date(`${end}T00:00:00Z`); cursor <= last; cursor.setUTCDate(cursor.getUTCDate() + 1)) allDates.push(cursor.toISOString().slice(0, 10));
      const firstIndex = allDates.findIndex(date => recordedDates.has(date));
      const lastIndex = allDates.length - 1 - [...allDates].reverse().findIndex(date => recordedDates.has(date));
      if (firstIndex < 0 || lastIndex <= firstIndex) continue;
      allDates.slice(firstIndex + 1, lastIndex).forEach(date => { if (!recordedDates.has(date)) suspectedOrderGapDays.push({ shopId, date }); });
    }
    const productCodeList = [...productCodes].filter(Boolean);
    const [{ data: products, error: productsError }, { data: failedBatches, error: batchesError }] = await Promise.all([
      productCodeList.length ? adminClient.from('products').select('product_code').in('product_code', productCodeList) : Promise.resolve({ data: [], error: null }),
      adminClient.from('order_import_batches').select('shop_id, import_type, validation_status, failed_rows, created_at').in('shop_id', safeShopIds).gte('created_at', `${start}T00:00:00+00:00`).or('validation_status.eq.partial,failed_rows.gt.0').order('created_at', { ascending: false }).limit(200)
    ]);
    if (productsError || batchesError) throw new Error('读取成本或同步预警数据失败');
    const knownCodes = new Set((products || []).map(product => String(product.product_code || '').trim()));
    const missingProductCodes = productCodeList.filter(code => !knownCodes.has(code));
    const orderNumbers = [...ordersByNumber.keys()];
    const billChunks = [];
    for (let index = 0; index < orderNumbers.length; index += 500) billChunks.push(orderNumbers.slice(index, index + 500));
    const matchedOrderNumbers = new Set();
    for (let index = 0; index < billChunks.length; index += 5) {
      const pages = await Promise.all(billChunks.slice(index, index + 5).map(chunk => adminClient.from('tiktok_bill_records').select('related_order_id').in('shop_id', safeShopIds).in('related_order_id', chunk).in('source_type', ['settled', 'unsettled']).eq('replacement_status', 'active')));
      pages.forEach(page => { if (page.error) throw new Error('读取结算账单预警数据失败'); (page.data || []).forEach(row => matchedOrderNumbers.add(String(row.related_order_id || '').trim())); });
    }
    const unmatchedOrderNumbers = orderNumbers.filter(orderNumber => !matchedOrderNumbers.has(orderNumber));
    const rateFor = (baseCurrency, date) => {
      if (baseCurrency === reportCurrency) return { settlement_rate: 1 };
      if (rateType === 'reference') {
        const rate = referenceRateData?.rates?.find(item => item.pair === `${baseCurrency}/${reportCurrency}` && item.available);
        return rate?.rate ? { settlement_rate: rate.rate } : null;
      }
      const historicalRates = rates || [];
      const directRate = historicalRates.find(rate => rate.base_currency === baseCurrency && rate.quote_currency === reportCurrency && rate.effective_date <= date);
      if (directRate) return directRate;
      const sourceToCny = historicalRates.find(rate => rate.base_currency === baseCurrency && rate.quote_currency === 'CNY' && rate.effective_date <= date);
      const reportToCny = historicalRates.find(rate => rate.base_currency === reportCurrency && rate.quote_currency === 'CNY' && rate.effective_date <= date);
      if (baseCurrency === 'CNY' && reportToCny && Number(reportToCny.settlement_rate) > 0) return { settlement_rate: 1 / Number(reportToCny.settlement_rate) };
      if (reportCurrency === 'CNY' && sourceToCny && Number(sourceToCny.settlement_rate) > 0) return sourceToCny;
      if (sourceToCny && reportToCny) {
        const sourceRate = Number(sourceToCny.settlement_rate);
        const reportRate = Number(reportToCny.settlement_rate);
        if (Number.isFinite(sourceRate) && Number.isFinite(reportRate) && sourceRate > 0 && reportRate > 0) return { settlement_rate: sourceRate / reportRate };
      }
      return null;
    };
    const missingRateOrderNumbers = orderNumbers.filter(orderNumber => {
      const order = ordersByNumber.get(orderNumber);
      return order?.currency && order.currency !== reportCurrency && !rateFor(order.currency, order.date);
    });
    const failedByShop = new Map();
    (failedBatches || []).forEach(batch => { const rows = failedByShop.get(batch.shop_id) || []; rows.push(batch); failedByShop.set(batch.shop_id, rows); });
    const detailsForShops = shopIds => [...new Set(shopIds)].map(shopId => shopNameById.get(shopId) || '未知店铺').slice(0, 3).join('、');
    const syncShopIds = [...failedByShop.keys()];
    const alerts = [];
    if (syncShopIds.length) alerts.push({ id: 'sync-failed', level: 'high', title: '店铺数据同步失败', count: syncShopIds.length, detail: `${detailsForShops(syncShopIds)}${syncShopIds.length > 3 ? '等' : ''} · 存在导入失败或部分完成批次`, suggestion: '请检查导入记录中的失败原因并重新导入。', scope: '导入批次状态为部分完成，或存在失败行。' });
    if (suspectedOrderGapDays.length) alerts.push({ id: 'order-date-gap', level: 'high', title: '订单数据疑似缺失', count: suspectedOrderGapDays.length, detail: `${suspectedOrderGapDays.slice(0, 6).map(item => `${shopNameById.get(item.shopId) || '未知店铺'} ${item.date}`).join('、')}${suspectedOrderGapDays.length > 6 ? ' 等' : ''} · 前后日期均有订单，当天没有任何订单明细`, suggestion: '请在同步助手按该日期重新同步订单并确认导入成功；未补齐前，该店铺利润可能偏高或偏低。', scope: '仅识别筛选范围内部、同店铺前后均有订单但中间日期完全为空的 UTC 日期；自然零订单日会标为“疑似”，需人工核实。', affected: suspectedOrderGapDays });
    if (missingProductCodes.length) alerts.push({ id: 'missing-cost', level: 'medium', title: '商品成本缺失', count: missingProductCodes.length, detail: `${missingProductCodes.length} 个商品编码未匹配商品资料，无法核算商品成本`, suggestion: '请在商品管理中补充对应商品资料和成本后重新核算。', scope: '按当前筛选订单的商品编码，与商品管理资料匹配。' });
    if (unmatchedOrderNumbers.length) alerts.push({ id: 'settlement-unmatched', level: 'medium', title: '结算账单未匹配', count: unmatchedOrderNumbers.length, detail: `${unmatchedOrderNumbers.length} 笔订单尚未匹配已结算或未结算账单`, suggestion: '请核对账单中的“相关订单 ID”并补充导入相应账单。', scope: '订单 ID 未匹配有效的已结算或未结算账单。' });
    if (missingRateOrderNumbers.length) alerts.push({ id: 'missing-rate', level: 'medium', title: `${rateType === 'reference' ? '实时参考汇率' : '报表结算汇率'}缺失`, count: missingRateOrderNumbers.length, detail: `${missingRateOrderNumbers.length} 笔订单缺少换算为 ${reportCurrency} 的${rateType === 'reference' ? '实时参考汇率' : '生效汇率'}`, suggestion: rateType === 'reference' ? '请检查汇率中心的实时参考汇率是否可用。' : '请在汇率中心补充订单下单日期对应的报表结算汇率。', scope: rateType === 'reference' ? '订单币种与报表币种不同，且当前实时参考汇率不可用。' : '订单币种与报表币种不同，且下单日期没有可用结算汇率。' });
    const data = { start, end, currency: reportCurrency, rateType, alerts, counts: { syncFailedShops: syncShopIds.length, suspectedMissingOrderDays: suspectedOrderGapDays.length, missingProductCodes: missingProductCodes.length, unmatchedOrders: unmatchedOrderNumbers.length, missingRateOrders: missingRateOrderNumbers.length } };
    dashboardAlertsCache.set(cacheKey, { createdAt: Date.now(), data });
    sendJson(response, 200, data);
  } catch (error) { adminError(response, error); }
}
async function listBusinessRefundTrend(request, response) {
  try {
    const accessToken = bearerToken(request);
    if (!accessToken) throw new Error('UNAUTHORIZED');
    const identity = await getAuthenticatedProfile(accessToken);
    const isPrivileged = identity.roles.some(role => ['finance', 'admin', 'super_admin'].includes(role));
    const requestUrl = new URL(request.url, `http://${request.headers.host}`);
    const requestedSite = String(requestUrl.searchParams.get('site') || '').trim();
    const today = new Date().toISOString().slice(0, 10);
    const yesterdayDate = new Date(`${today}T00:00:00Z`); yesterdayDate.setUTCDate(yesterdayDate.getUTCDate() - 1);
    const yesterday = yesterdayDate.toISOString().slice(0, 10);
    const requestedStart = String(requestUrl.searchParams.get('start') || ''), requestedEnd = String(requestUrl.searchParams.get('end') || yesterday);
    const end = /^\d{4}-\d{2}-\d{2}$/.test(requestedEnd) ? requestedEnd : yesterday;
    const fallbackStart = new Date(`${end}T00:00:00Z`); fallbackStart.setUTCDate(fallbackStart.getUTCDate() - 6);
    const start = /^\d{4}-\d{2}-\d{2}$/.test(requestedStart) ? requestedStart : fallbackStart.toISOString().slice(0, 10);
    if (start > end) throw new Error('开始日期不能晚于结束日期');
    if (end >= today) throw new Error('退款趋势仅统计截至昨日的完整自然日数据');
    if (localDatabaseEnabled()) {
      const allShops = await localBusinessVisibleShops(identity);
      const visibleShops = allShops.filter(shop => !requestedSite || shop.country_code === requestedSite);
      const visibleShopIds = visibleShops.map(shop => shop.id), requestedShopId = String(requestUrl.searchParams.get('shopId') || '');
      if (requestedShopId && !visibleShopIds.includes(requestedShopId)) throw new Error('无权查看该店铺数据');
      const scopedShopIds = requestedShopId ? [requestedShopId] : visibleShopIds;
      const trendOrders = scopedShopIds.length ? (await localQuery(`select o.id, o.shop_id, o.order_number, to_char(o.ordered_at at time zone 'UTC', 'YYYY-MM-DD') as ordered_day, bool_or(nullif(trim(coalesce(i.cancellation_return_type, '')), '') is not null) as refunded from public.orders o left join public.order_items i on i.order_id = o.id where o.shop_id = any($1::uuid[]) and o.ordered_at >= $2::timestamptz and o.ordered_at <= $3::timestamptz group by o.id, o.shop_id, o.order_number, o.ordered_at`, [scopedShopIds, `${start}T00:00:00+00:00`, `${end}T23:59:59.999+00:00`])).rows : [];
      const byDate = new Map(), endDate = new Date(`${end}T00:00:00Z`);
      for (let cursor = new Date(`${start}T00:00:00Z`); cursor <= endDate; cursor.setUTCDate(cursor.getUTCDate() + 1)) byDate.set(cursor.toISOString().slice(0, 10), { date: cursor.toISOString().slice(0, 10), orders: 0, refunds: 0 });
      const seenOrders = new Set();
      trendOrders.forEach(order => { const bucket = byDate.get(order.ordered_day), key = `${order.shop_id}:${order.order_number || order.id}`; if (!bucket || seenOrders.has(key)) return; seenOrders.add(key); bucket.orders += 1; if (order.refunded) bucket.refunds += 1; });
      const series = [...byDate.values()].map(item => ({ ...item, refundRate: item.orders ? Number((item.refunds / item.orders * 100).toFixed(2)) : 0 }));
      return sendJson(response, 200, { start, end, shops: visibleShops.filter(shop => scopedShopIds.includes(shop.id)), series, statistics: { orderCount: series.reduce((total, item) => total + item.orders, 0), refundCount: series.reduce((total, item) => total + item.refunds, 0) } });
    }
    const { data: permissions, error: permissionsError } = await adminClient.from('user_shop_permissions').select('shop_id').eq('user_id', identity.profile.id);
    if (permissionsError) throw new Error('读取店铺授权失败');
    let visibleShopsQuery = adminClient.from('shops').select('id, shop_code, shop_name, country_code').eq('is_active', true);
    if (!isPrivileged) { const ids = permissions.map(row => row.shop_id); visibleShopsQuery = visibleShopsQuery.in('id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000']); }
    const { data: visibleShops, error: visibleShopsError } = await visibleShopsQuery;
    if (visibleShopsError) throw new Error('读取业务端可见店铺失败');
    const visibleShopIds = visibleShops.map(shop => shop.id), requestedShopId = String(requestUrl.searchParams.get('shopId') || '');
    if (requestedShopId && !visibleShopIds.includes(requestedShopId)) throw new Error('无权查看该店铺数据');
    const scopedShopIds = (requestedShopId ? [requestedShopId] : visibleShopIds).filter(shopId => !requestedSite || (visibleShops || []).some(shop => shop.id === shopId && shop.country_code === requestedSite));
    const safeIds = scopedShopIds.length ? scopedShopIds : ['00000000-0000-0000-0000-000000000000'];
    // 按页读取，确保所选店铺和日期范围内的订单全部参与统计。
    const trendOrders = [];
    const trendPageSize = 1000;
    for (let offset = 0; ; offset += trendPageSize) {
      const pageResult = await adminClient.from('orders').select('id, shop_id, order_number, ordered_at, order_items(cancellation_return_type)').in('shop_id', safeIds).gte('ordered_at', `${start}T00:00:00+00:00`).lte('ordered_at', `${end}T23:59:59.999+00:00`).order('ordered_at').order('id').range(offset, offset + trendPageSize - 1);
      if (pageResult.error) throw new Error('读取订单退款趋势失败');
      trendOrders.push(...(pageResult.data || []));
      if ((pageResult.data || []).length < trendPageSize) break;
    }
    const importedShops = (visibleShops || []).filter(shop => scopedShopIds.includes(shop.id)).sort((a, b) => String(a.shop_name).localeCompare(String(b.shop_name), 'zh-CN'));
    const byDate = new Map(), endDate = new Date(`${end}T00:00:00Z`);
    for (let cursor = new Date(`${start}T00:00:00Z`); cursor <= endDate; cursor.setUTCDate(cursor.getUTCDate() + 1)) byDate.set(cursor.toISOString().slice(0, 10), { date: cursor.toISOString().slice(0, 10), orders: 0, refunds: 0 });
    const seenOrders = new Set();
    trendOrders.forEach(order => { const date = businessDatePart(order.ordered_at), bucket = byDate.get(date), orderKey = `${order.shop_id}:${order.order_number || order.id}`; if (!bucket || seenOrders.has(orderKey)) return; seenOrders.add(orderKey); bucket.orders += 1; if ((order.order_items || []).some(item => String(item.cancellation_return_type || '').trim())) bucket.refunds += 1; });
    const series = [...byDate.values()].map(item => ({ ...item, refundRate: item.orders ? Number((item.refunds / item.orders * 100).toFixed(2)) : 0 }));
    sendJson(response, 200, { start, end, shops: importedShops, series, statistics: { orderCount: series.reduce((total, item) => total + item.orders, 0), refundCount: series.reduce((total, item) => total + item.refunds, 0) } });
  } catch (error) { adminError(response, error); }
}
async function listBusinessOrderDetails(request, response) {
  try {
    const accessToken = bearerToken(request);
    if (!accessToken) throw new Error('UNAUTHORIZED');
    const identity = await getAuthenticatedProfile(accessToken);
    const isPrivileged = identity.roles.some(role => ['finance', 'admin', 'super_admin'].includes(role));
    if (localDatabaseEnabled()) {
      const permissions = isPrivileged ? [] : (await localQuery(`select shop_id from public.user_shop_permissions where user_id = $1`, [identity.profile.id])).rows;
      const permittedIds = permissions.map(item => item.shop_id);
      const shops = (await localQuery(`select id from public.shops where is_active = true ${isPrivileged ? '' : 'and id = any($1::uuid[])'}`, isPrivileged ? [] : [permittedIds])).rows;
      return listPaginatedOrderSettlementManagementData(request, response, shops.map(shop => shop.id));
    }
    const { data: permissions, error: permissionsError } = await adminClient.from('user_shop_permissions').select('shop_id').eq('user_id', identity.profile.id);
    if (permissionsError) throw new Error('读取店铺授权失败');
    let shopsQuery = adminClient.from('shops').select('id').eq('is_active', true);
    if (!isPrivileged) {
      const shopIds = permissions.map(item => item.shop_id);
      shopsQuery = shopsQuery.in('id', shopIds.length ? shopIds : ['00000000-0000-0000-0000-000000000000']);
    }
    const { data: shops, error: shopsError } = await shopsQuery;
    if (shopsError) throw new Error('读取业务端可见店铺失败');
    await listPaginatedOrderSettlementManagementData(request, response, (shops || []).map(shop => shop.id));
  } catch (error) { adminError(response, error); }
}
async function localBusinessVisibleShops(identity) {
  const privileged = identity.roles.some(role => ['finance', 'admin', 'super_admin'].includes(role));
  const permissions = privileged ? [] : (await localQuery(`select shop_id from public.user_shop_permissions where user_id = $1`, [identity.profile.id])).rows;
  const ids = permissions.map(row => row.shop_id);
  return (await localQuery(`select id, shop_code, shop_name, country_code, currency_code from public.shops where is_active = true ${privileged ? '' : 'and id = any($1::uuid[])'} order by shop_name`, privileged ? [] : [ids])).rows;
}
async function listBusinessWarehouseCosts(request, response) {
  try {
    const accessToken = bearerToken(request);
    if (!accessToken) throw new Error('UNAUTHORIZED');
    const identity = await getAuthenticatedProfile(accessToken);
    const isPrivileged = identity.roles.some(role => ['finance', 'admin', 'super_admin'].includes(role));
    if (localDatabaseEnabled()) {
      const visibleShops = await localBusinessVisibleShops(identity);
      const shopIds = visibleShops.map(shop => shop.id);
      const links = shopIds.length ? (await localQuery(`select warehouse_id from public.shop_warehouses where shop_id = any($1::uuid[])`, [shopIds])).rows : [];
      const warehouseIds = [...new Set(links.map(link => link.warehouse_id))];
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
      const [warehouses, versions] = await Promise.all([
        warehouseIds.length ? localQuery(`select id, name, shipping_provider_name from public.warehouses where is_active = true and id = any($1::uuid[]) order by name`, [warehouseIds]) : Promise.resolve({ rows: [] }),
        warehouseIds.length ? localQuery(`select id, warehouse_id, amount, currency_code, billing_unit, effective_date::text as effective_date, note, created_at from public.warehouse_cost_versions where effective_date <= $1::date and warehouse_id = any($2::uuid[]) order by effective_date desc, created_at desc`, [today, warehouseIds]) : Promise.resolve({ rows: [] })
      ]);
      const versionsByWarehouse = new Map();
      versions.rows.forEach(version => { const rows = versionsByWarehouse.get(version.warehouse_id) || []; rows.push(version); versionsByWarehouse.set(version.warehouse_id, rows); });
      return sendJson(response, 200, { costs: warehouses.rows.map(warehouse => { const history = versionsByWarehouse.get(warehouse.id) || []; return { warehouse, currentCost: history[0] || null, previousCost: history[1] || null, history }; }), asOfDate: today });
    }
    const { data: permissions, error: permissionsError } = await adminClient.from('user_shop_permissions').select('shop_id').eq('user_id', identity.profile.id);
    if (permissionsError) throw new Error('读取店铺授权失败');
    let shopsQuery = adminClient.from('shops').select('id').eq('is_active', true);
    if (!isPrivileged) {
      const shopIds = permissions.map(row => row.shop_id);
      shopsQuery = shopIds.length ? shopsQuery.in('id', shopIds) : shopsQuery.in('id', ['00000000-0000-0000-0000-000000000000']);
    }
    const { data: visibleShops, error: shopsError } = await shopsQuery;
    if (shopsError) throw new Error('读取店铺数据失败');
    const { data: links, error: linksError } = await adminClient.from('shop_warehouses').select('warehouse_id').in('shop_id', visibleShops.length ? visibleShops.map(shop => shop.id) : ['00000000-0000-0000-0000-000000000000']);
    if (linksError) throw new Error('读取关联仓库失败');
    const warehouseIds = [...new Set(links.map(link => link.warehouse_id))];
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
    const [warehousesResult, versionsResult] = await Promise.all([
      adminClient.from('warehouses').select('id, name, shipping_provider_name').eq('is_active', true).in('id', warehouseIds.length ? warehouseIds : ['00000000-0000-0000-0000-000000000000']).order('name'),
      adminClient.from('warehouse_cost_versions').select('id, warehouse_id, amount, currency_code, billing_unit, effective_date, note, created_at').lte('effective_date', today).in('warehouse_id', warehouseIds.length ? warehouseIds : ['00000000-0000-0000-0000-000000000000']).order('effective_date', { ascending: false }).order('created_at', { ascending: false })
    ]);
    if (warehousesResult.error || versionsResult.error) throw new Error('读取仓库代发成本失败');
    const versionsByWarehouse = new Map();
    versionsResult.data.forEach(version => {
      const rows = versionsByWarehouse.get(version.warehouse_id) || [];
      rows.push(version);
      versionsByWarehouse.set(version.warehouse_id, rows);
    });
    const costs = warehousesResult.data.map(warehouse => {
      const versions = versionsByWarehouse.get(warehouse.id) || [];
      return { warehouse, currentCost: versions[0] || null, previousCost: versions[1] || null, history: versions };
    });
    sendJson(response, 200, { costs, asOfDate: today });
  } catch (error) { adminError(response, error); }
}
async function listBusinessProducts(request, response) {
  try {
    const accessToken = bearerToken(request);
    if (!accessToken) throw new Error('UNAUTHORIZED');
    const identity = await getAuthenticatedProfile(accessToken);
    const isPrivileged = identity.roles.some(role => ['finance', 'admin', 'super_admin'].includes(role));
    if (localDatabaseEnabled()) {
      const visibleShops = await localBusinessVisibleShops(identity);
      const shopIds = visibleShops.map(shop => shop.id);
      const links = shopIds.length ? (await localQuery(`select warehouse_id from public.shop_warehouses where shop_id = any($1::uuid[])`, [shopIds])).rows : [];
      const warehouseIds = [...new Set(links.map(link => link.warehouse_id))];
      const [warehouses, products] = await Promise.all([
        warehouseIds.length ? localQuery(`select id, name from public.warehouses where is_active = true and id = any($1::uuid[]) order by name`, [warehouseIds]) : Promise.resolve({ rows: [] }),
        warehouseIds.length ? localQuery(`select id, warehouse_id, product_code, product_name, image_url, sale_price, currency_code, updated_at from public.products where status = 'approved' and warehouse_id = any($1::uuid[]) order by updated_at desc`, [warehouseIds]) : Promise.resolve({ rows: [] })
      ]);
      const availableWarehouseIds = new Set(warehouses.rows.map(warehouse => warehouse.id));
      return sendJson(response, 200, { warehouses: warehouses.rows, products: products.rows.filter(product => availableWarehouseIds.has(product.warehouse_id)) });
    }
    const { data: permissions, error: permissionsError } = await adminClient.from('user_shop_permissions').select('shop_id').eq('user_id', identity.profile.id);
    if (permissionsError) throw new Error('读取店铺授权失败');
    let shopsQuery = adminClient.from('shops').select('id').eq('is_active', true);
    if (!isPrivileged) {
      const shopIds = permissions.map(row => row.shop_id);
      shopsQuery = shopIds.length ? shopsQuery.in('id', shopIds) : shopsQuery.in('id', ['00000000-0000-0000-0000-000000000000']);
    }
    const { data: visibleShops, error: shopsError } = await shopsQuery;
    if (shopsError) throw new Error('读取店铺数据失败');
    const { data: links, error: linksError } = await adminClient.from('shop_warehouses').select('warehouse_id').in('shop_id', visibleShops.length ? visibleShops.map(shop => shop.id) : ['00000000-0000-0000-0000-000000000000']);
    if (linksError) throw new Error('读取关联仓库失败');
    const warehouseIds = [...new Set(links.map(link => link.warehouse_id))];
    const safeIds = warehouseIds.length ? warehouseIds : ['00000000-0000-0000-0000-000000000000'];
    const [{ data: warehouses, error: warehousesError }, { data: products, error: productsError }] = await Promise.all([
      adminClient.from('warehouses').select('id, name').eq('is_active', true).in('id', safeIds).order('name'),
      adminClient.from('products').select('id, warehouse_id, product_code, product_name, image_url, sale_price, currency_code, updated_at').eq('status', 'approved').in('warehouse_id', safeIds).order('updated_at', { ascending: false })
    ]);
    if (warehousesError || productsError) throw new Error('读取商品数据失败');
    const availableWarehouseIds = new Set(warehouses.map(warehouse => warehouse.id));
    sendJson(response, 200, { warehouses, products: products.filter(product => availableWarehouseIds.has(product.warehouse_id)) });
  } catch (error) { adminError(response, error); }
}
async function listBusinessSettlementRates(request, response) {
  try {
    const accessToken = bearerToken(request);
    if (!accessToken) throw new Error('UNAUTHORIZED');
    const identity = await getAuthenticatedProfile(accessToken);
    if (!identity.primaryRole) throw new Error('FORBIDDEN');
    if (localDatabaseEnabled()) {
      const [ratesResult, versionsResult] = await Promise.all([
        localQuery(`select id, base_currency, quote_currency, settlement_rate, effective_date::text as effective_date, note, is_active, updated_at from public.settlement_exchange_rates order by effective_date desc, updated_at desc`),
        localQuery(`select id, rate_id, action, previous_data, current_data, created_at from public.settlement_exchange_rate_versions order by created_at desc limit 300`)
      ]);
      const rates = ratesResult.rows, versions = versionsResult.rows;
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
      const activeByPair = new Map();
      rates.filter(rate => rate.is_active && rate.effective_date <= today).forEach(rate => { const key = `${rate.base_currency}/${rate.quote_currency}`; const current = activeByPair.get(key); if (!current || rate.effective_date > current.effective_date) activeByPair.set(key, rate); });
      const enriched = rates.map(rate => { const current = activeByPair.get(`${rate.base_currency}/${rate.quote_currency}`); return { ...rate, status: !rate.is_active ? 'deactivated' : rate.effective_date > today ? 'pending' : current?.id === rate.id ? 'active' : 'expired' }; });
      return sendJson(response, 200, { rates: enriched, versions, today });
    }
    const [{ data: rates, error: ratesError }, { data: versions, error: versionsError }] = await Promise.all([
      adminClient.from('settlement_exchange_rates').select('id, base_currency, quote_currency, settlement_rate, effective_date, note, is_active, updated_at').order('effective_date', { ascending: false }).order('updated_at', { ascending: false }),
      adminClient.from('settlement_exchange_rate_versions').select('id, rate_id, action, previous_data, current_data, created_at').order('created_at', { ascending: false }).limit(300)
    ]);
    if (ratesError || versionsError) throw new Error('读取报表结算汇率失败');
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
    const activeByPair = new Map();
    rates.filter(rate => rate.is_active && rate.effective_date <= today).forEach(rate => {
      const key = `${rate.base_currency}/${rate.quote_currency}`;
      const current = activeByPair.get(key);
      if (!current || rate.effective_date > current.effective_date) activeByPair.set(key, rate);
    });
    const enriched = rates.map(rate => {
      const current = activeByPair.get(`${rate.base_currency}/${rate.quote_currency}`);
      const status = !rate.is_active ? 'deactivated' : rate.effective_date > today ? 'pending' : current?.id === rate.id ? 'active' : 'expired';
      return { ...rate, status };
    });
    sendJson(response, 200, { rates: enriched, versions, today });
  } catch (error) { adminError(response, error); }
}
async function listBusinessPromotions(request, response) {
  try {
    const accessToken = bearerToken(request);
    if (!accessToken) throw new Error('UNAUTHORIZED');
    const identity = await getAuthenticatedProfile(accessToken);
    if (!identity.primaryRole) throw new Error('FORBIDDEN');
    const requestUrl = new URL(request.url, `http://${request.headers.host}`);
    const reportCurrency = String(requestUrl.searchParams.get('currency') || 'USD').trim().toUpperCase();
    const rateType = String(requestUrl.searchParams.get('rateType') || 'settlement').trim();
    if (!QUOTE_CURRENCIES.has(reportCurrency)) throw new Error('报表币种仅支持 CNY 或 USD');
    if (!['settlement', 'reference'].includes(rateType)) throw new Error('汇率取值参数无效');
    const isPrivileged = identity.roles.some(role => ['finance', 'admin', 'super_admin'].includes(role));
    if (localDatabaseEnabled()) {
      const shops = await localBusinessVisibleShops(identity);
      const shopIds = shops.map(shop => shop.id);
      const [promotionsResult, ratesResult] = await Promise.all([
        shopIds.length ? localQuery(`select p.id, p.shop_id, p.promotion_date::text as promotion_date, p.cost_amount, p.sku_count, p.order_count, p.revenue_amount, p.currency_code, json_build_object('shop_code', s.shop_code, 'shop_name', s.shop_name, 'country_code', s.country_code) as shops from public.promotion_expenses p join public.shops s on s.id = p.shop_id where p.shop_id = any($1::uuid[]) order by p.promotion_date desc, p.created_at desc`, [shopIds]) : Promise.resolve({ rows: [] }),
        rateType === 'settlement' ? localQuery(`select base_currency, quote_currency, settlement_rate, effective_date::text as effective_date from public.settlement_exchange_rates where is_active = true order by effective_date desc`) : Promise.resolve({ rows: [] })
      ]);
      const referenceRateData = rateType === 'reference' ? await refreshRates(reportCurrency) : null;
      const rateFor = (sourceCurrency, date) => sourceCurrency === reportCurrency ? 1 : rateType === 'reference'
        ? (referenceRateData?.rates?.find(item => item.pair === `${sourceCurrency}/${reportCurrency}` && item.available)?.rate || null)
        : (ratesResult.rows.find(item => item.base_currency === sourceCurrency && item.quote_currency === reportCurrency && item.effective_date <= date)?.settlement_rate || null);
      const promotions = promotionsResult.rows.map(item => { const rate = rateFor(String(item.currency_code || '').toUpperCase(), item.promotion_date); return rate === null ? { ...item, cost_amount: null, revenue_amount: null, currency_code: reportCurrency, conversion_missing: true } : { ...item, cost_amount: Number(item.cost_amount || 0) * Number(rate), revenue_amount: Number(item.revenue_amount || 0) * Number(rate), currency_code: reportCurrency, conversion_missing: false }; });
      return sendJson(response, 200, { promotions, shops, currency: reportCurrency, rateType });
    }
    const { data: permissions, error: permissionsError } = await adminClient.from('user_shop_permissions').select('shop_id').eq('user_id', identity.profile.id);
    if (permissionsError) throw new Error('读取店铺授权失败');
    let shopQuery = adminClient.from('shops').select('id, shop_code, shop_name, country_code').eq('is_active', true).order('shop_name');
    if (!isPrivileged) shopQuery = (permissions || []).length ? shopQuery.in('id', permissions.map(item => item.shop_id)) : shopQuery.in('id', ['00000000-0000-0000-0000-000000000000']);
    const { data: shops, error: shopsError } = await shopQuery;
    if (shopsError) throw new Error('读取已授权店铺失败');
    const shopIds = (shops || []).map(shop => shop.id);
    const [{ data: promotions, error: promotionsError }, settlementRates] = await Promise.all([
      adminClient.from('promotion_expenses').select('id, shop_id, promotion_date, cost_amount, sku_count, order_count, revenue_amount, currency_code, shops!inner(shop_code, shop_name, country_code)').in('shop_id', shopIds.length ? shopIds : ['00000000-0000-0000-0000-000000000000']).order('promotion_date', { ascending: false }).order('created_at', { ascending: false }),
      rateType === 'settlement'
        ? adminClient.from('settlement_exchange_rates').select('base_currency, quote_currency, settlement_rate, effective_date').eq('is_active', true).order('effective_date', { ascending: false })
        : Promise.resolve({ data: [], error: null })
    ]);
    if (promotionsError || settlementRates.error) throw new Error('读取推广费用数据失败');
    const referenceRateData = rateType === 'reference' ? await refreshRates(reportCurrency) : null;
    const rateFor = (sourceCurrency, date) => {
      if (sourceCurrency === reportCurrency) return 1;
      if (rateType === 'reference') {
        const rate = referenceRateData?.rates?.find(item => item.pair === `${sourceCurrency}/${reportCurrency}` && item.available);
        return rate?.rate ? Number(rate.rate) : null;
      }
      const rate = (settlementRates.data || []).find(item => item.base_currency === sourceCurrency && item.quote_currency === reportCurrency && item.effective_date <= date);
      return rate?.settlement_rate ? Number(rate.settlement_rate) : null;
    };
    const rows = (promotions || []).map(item => {
      const rate = rateFor(String(item.currency_code || '').toUpperCase(), item.promotion_date);
      return rate === null
        ? { ...item, cost_amount: null, revenue_amount: null, currency_code: reportCurrency, conversion_missing: true }
        : { ...item, cost_amount: Number(item.cost_amount || 0) * rate, revenue_amount: Number(item.revenue_amount || 0) * rate, currency_code: reportCurrency, conversion_missing: false };
    });
    sendJson(response, 200, { promotions: rows, shops: shops || [], currency: reportCurrency, rateType });
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
  const extension = path.extname(filePath);
  // HTML must always be revalidated so it can reference the latest versioned client bundles.
  // API responses are separately marked no-store in sendJson.
  // 页面脚本和样式会持续更新。它们不能使用长期 immutable 缓存，
  // 否则其它电脑会继续运行旧版界面，导致利润汇总功能区缺失。
  const cacheControl = ['.html', '.js', '.css'].includes(extension)
    ? 'no-cache, max-age=0, must-revalidate'
    : 'public, max-age=31536000, immutable';
  response.writeHead(200, { 'Content-Type': type, 'Cache-Control': cacheControl }); fs.createReadStream(filePath).pipe(response);
}
http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const masterDataWrite = (url.pathname === '/api/admin/shops' && request.method === 'POST') || (url.pathname === '/api/admin/shops/configuration' && request.method === 'PUT') || (url.pathname === '/api/admin/promotions' && request.method === 'POST') || (url.pathname === '/api/admin/promotions/import' && request.method === 'POST') || (url.pathname === '/api/admin/promotions/configuration' && request.method === 'PUT') || (url.pathname === '/api/admin/warehouses' && request.method === 'POST') || (url.pathname === '/api/admin/warehouses/configuration' && request.method === 'PUT') || (url.pathname === '/api/admin/country-sites' && request.method === 'POST') || (url.pathname === '/api/admin/products' && ['POST', 'DELETE'].includes(request.method)) || (url.pathname === '/api/admin/products/import' && request.method === 'POST') || (url.pathname === '/api/admin/products/configuration' && request.method === 'PUT') || (url.pathname === '/api/admin/settlement-rates' && ['POST', 'DELETE'].includes(request.method)) || (url.pathname === '/api/admin/settlement-rates/configuration' && request.method === 'PUT') || (url.pathname === '/api/admin/members' && request.method === 'POST') || (url.pathname === '/api/admin/members/configuration' && request.method === 'PUT') || (url.pathname === '/api/admin/members/status' && request.method === 'PUT') || (url.pathname === '/api/admin/order-imports/correct-dates' && request.method === 'POST') || (url.pathname === '/api/admin/bill-imports' && request.method === 'POST');
  if (VISUAL_MODE && url.pathname.startsWith('/api/admin/') && ['POST', 'PUT', 'DELETE'].includes(request.method) && !masterDataWrite && !(url.pathname === '/api/admin/order-imports' && request.method === 'POST') && !(url.pathname === '/api/admin/order-imports/orders' && request.method === 'POST')) {
    return sendJson(response, 423, { message: '当前为视觉演示模式，管理数据不会写入系统。' });
  }
  if (url.pathname === '/api/auth/login' && request.method === 'POST') return handleLogin(request, response);
  if (url.pathname === '/api/auth/password-reset' && request.method === 'POST') return handlePasswordReset(request, response);
  if (url.pathname === '/api/auth/password-update' && request.method === 'POST') return handlePasswordUpdate(request, response);
  if (url.pathname === '/api/auth/session' && request.method === 'POST') return handleSession(request, response);
  if (url.pathname === '/api/auth/refresh' && request.method === 'POST') return handleSessionRefresh(request, response);
  if (url.pathname === '/api/admin/data' && request.method === 'GET') return listAdminData(request, response);
  if (url.pathname === '/api/admin/shops' && request.method === 'GET') return listShopManagementData(request, response);
  if (url.pathname === '/api/admin/shops' && request.method === 'POST') return createShop(request, response);
  if (url.pathname === '/api/admin/shops/configuration' && request.method === 'PUT') return updateShop(request, response);
  if (url.pathname === '/api/admin/promotions' && request.method === 'GET') return listPromotionExpenses(request, response);
  if (url.pathname === '/api/admin/promotions' && request.method === 'POST') return createPromotionExpense(request, response);
  if (url.pathname === '/api/admin/promotions/import' && request.method === 'POST') return importPromotionExpenses(request, response);
  if (url.pathname === '/api/admin/promotions/configuration' && request.method === 'PUT') return updatePromotionExpense(request, response);
  if (url.pathname === '/api/admin/warehouses' && request.method === 'GET') return listWarehouseManagementData(request, response);
  if (url.pathname === '/api/admin/warehouses' && request.method === 'POST') return createWarehouse(request, response);
  if (url.pathname === '/api/admin/warehouses/configuration' && request.method === 'PUT') return updateWarehouse(request, response);
  if (url.pathname === '/api/admin/order-settlements/detail' && request.method === 'GET') return getOrderSettlementDetail(request, response);
  if (url.pathname === '/api/admin/order-settlements' && request.method === 'GET') return listPaginatedOrderSettlementManagementData(request, response);
  if (url.pathname === '/api/admin/order-imports' && request.method === 'GET') return listOrderImportBatches(request, response);
  if (url.pathname === '/api/admin/order-imports' && request.method === 'POST') return importOrderSettlementData(request, response);
  if (url.pathname === '/api/admin/order-imports/correct-dates' && request.method === 'POST') return correctOrderImportDates(request, response);
  if (url.pathname === '/api/admin/order-import-configuration' && request.method === 'GET') return listOrderImportConfiguration(request, response);
  if (url.pathname === '/api/admin/order-imports/orders' && request.method === 'POST') return importOrderDetailV3(request, response);
  if (url.pathname === '/api/admin/bill-imports' && request.method === 'POST') return importTiktokBills(request, response);
  if (url.pathname === '/api/admin/bill-import-batches' && request.method === 'POST') return manageBillBatch(request, response);
  if (url.pathname === '/api/admin/country-sites' && request.method === 'POST') return saveCountrySite(request, response);
  if (url.pathname === '/api/admin/products' && request.method === 'GET') return listProductManagementData(request, response);
  if (url.pathname === '/api/admin/products' && request.method === 'POST') return createProduct(request, response);
  if (url.pathname === '/api/admin/products/import' && request.method === 'POST') return importProducts(request, response);
  if (url.pathname === '/api/admin/products/configuration' && request.method === 'PUT') return updateProduct(request, response);
  if (url.pathname === '/api/admin/products' && request.method === 'DELETE') return deleteProduct(request, response);
  if (url.pathname === '/api/admin/settlement-rates' && request.method === 'GET') return listSettlementRateManagementData(request, response);
  if (url.pathname === '/api/admin/settlement-rates' && request.method === 'POST') return createSettlementRate(request, response);
  if (url.pathname === '/api/admin/settlement-rates/configuration' && request.method === 'PUT') return updateSettlementRate(request, response);
  if (url.pathname === '/api/admin/settlement-rates' && request.method === 'DELETE') return deactivateSettlementRate(request, response);
  if (url.pathname === '/api/admin/members' && request.method === 'POST') return createMember(request, response);
  if (url.pathname === '/api/admin/members' && request.method === 'GET') return listMemberManagementData(request, response);
  if (url.pathname === '/api/admin/members/configuration' && request.method === 'PUT') return updateMemberConfiguration(request, response);
  if (url.pathname === '/api/admin/members/status' && request.method === 'PUT') return setMemberActive(request, response);
  if (url.pathname === '/api/admin/members/access' && request.method === 'PUT') return updateMemberAccess(request, response);
  if (url.pathname === '/api/admin/members/pending' && request.method === 'DELETE') return deletePendingMember(request, response);
  if (url.pathname === '/api/business/shops' && request.method === 'GET') return listBusinessShops(request, response);
  if (url.pathname === '/api/business/dashboard-overview' && request.method === 'GET') return listBusinessDashboardOverview(request, response);
  if (url.pathname === '/api/business/dashboard-alerts' && request.method === 'GET') return listBusinessDashboardAlerts(request, response);
  if (url.pathname === '/api/business/refund-trend' && request.method === 'GET') return listBusinessRefundTrend(request, response);
  if (url.pathname === '/api/business/order-details' && request.method === 'GET') return listBusinessOrderDetails(request, response);
  if (url.pathname === '/api/business/warehouse-costs' && request.method === 'GET') return listBusinessWarehouseCosts(request, response);
  if (url.pathname === '/api/business/products' && request.method === 'GET') return listBusinessProducts(request, response);
  if (url.pathname === '/api/business/settlement-rates' && request.method === 'GET') return listBusinessSettlementRates(request, response);
  if (url.pathname === '/api/business/promotions' && request.method === 'GET') return listBusinessPromotions(request, response);
  if (url.pathname === '/api/health' && request.method === 'GET') return sendJson(response, 200, { status: 'ok', storage: 'local-postgresql' });
  if (url.pathname === '/api/reference-rates') {
    const quote = url.searchParams.get('currency') || 'CNY';
    if (!QUOTE_CURRENCIES.has(quote)) return sendJson(response, 400, { message: '仅支持 CNY 或 USD' });
    const current = cache.get(quote);
    const data = !current || !current.nextRefreshAt || new Date(current.nextRefreshAt) <= new Date() || request.method === 'POST' ? await refreshRates(quote) : current;
    return sendJson(response, 200, data);
  }
  serveFile(request, response);
}).listen(PORT, '0.0.0.0', () => console.log(`TikTok Profit System: http://localhost:${PORT}`));
