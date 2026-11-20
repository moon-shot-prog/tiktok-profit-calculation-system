/* Single scheduled task: processes enabled shops serially and writes UI status. */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const scriptDirectory = __dirname;
const configPath = path.join(scriptDirectory, 'tiktok-automation.config.json');
const jobPath = path.join(scriptDirectory, 'tiktok-daily-job.js');
const unsettledBillJobPath = path.join(scriptDirectory, 'tiktok-unsettled-bill-job.js');
const promotionJobPath = path.join(scriptDirectory, 'tiktok-promotion-job.js');
const sellerLoginPath = path.join(scriptDirectory, 'tiktok-seller-auto-login.js');
const closeSessionPath = path.join(scriptDirectory, 'tiktok-browser-session-close.js');
const checkOnly = process.argv.includes('--check');
function initialOrderUrl(config, store) { return `${String(config.sellerCenterUrl).replace(/\/$/, '')}/order?shop_region=${encodeURIComponent(store.countryCode)}&tab=all`; }
function waitSync(milliseconds) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds); }
function runStoreLogin(config, store) {
  let result = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    result = spawnSync(process.execPath, [sellerLoginPath, '--store', store.profileKey, '--continue-url', initialOrderUrl(config, store), '--keep-session'], { encoding: 'utf8' });
    const detail = String(result.stderr || result.stdout || '');
    if (result.status === 0 || attempt === 2 || !/target page, context or browser has been closed/i.test(detail)) break;
    // Chrome may still be closing from the preceding isolated profile. Retry
    // once with the same profile instead of skipping a newly added shop.
    waitSync(2000);
  }
  return result;
}
function closeStoreSession(profileKey) {
  // Cleanup happens only after every data type (and any bill retry) has had a
  // chance to reuse the authenticated page.  The profiles are dedicated to
  // the assistant, so this also closes an orphaned session reused from a
  // previous interrupted run instead of accumulating Chrome windows.
  spawnSync(process.execPath, [closeSessionPath, '--store', profileKey], { encoding: 'utf8', timeout: 15000 });
}

function readJson(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) { return fallback; }
}
function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tempPath, filePath);
}
function writeState(filePath, value) {
  value.pid = process.pid;
  value.heartbeatAt = new Date().toISOString();
  writeJson(filePath, value);
}
function cancellationRequested(rootDir) {
  return fs.existsSync(path.join(rootDir, '待处理', '同步助手取消请求.json'));
}
function markShopLoginVerified(config, profileKey) {
  const shop = (config.shopMappings || []).find(item => (item.profileKey || 'default') === profileKey);
  if (!shop) return;
  shop.verifiedAt = new Date().toISOString();
  const tempPath = `${configPath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, configPath);
}
function utcYesterday() { const value = new Date(); value.setUTCDate(value.getUTCDate() - 1); return value.toISOString().slice(0, 10); }
function latestStoreRun(rootDir, profileKey, targetDate) {
  const log = readJson(path.join(rootDir, '待处理', '自动任务记录.json'), { runs: [] });
  return (log.runs || []).find(run => run.key === `${targetDate}|${profileKey}`) || null;
}
function latestUnsettledBillRun(rootDir, profileKey, targetDate) {
  const log = readJson(path.join(rootDir, '待处理', '未结算账单自动任务记录.json'), { runs: [] });
  return (log.runs || []).find(run => run.key === `${targetDate}|${profileKey}`) || null;
}
function latestSettledBillRun(rootDir, profileKey, targetDate) {
  const log = readJson(path.join(rootDir, '待处理', '已结算账单自动任务记录.json'), { runs: [] });
  return (log.runs || []).find(run => run.key === `${targetDate}|${profileKey}`) || null;
}
function latestPromotionRun(rootDir, profileKey, targetDate) {
  const log = readJson(path.join(rootDir, '待处理', '推广自动任务记录.json'), { runs: [] });
  return (log.runs || []).find(run => run.key === `${targetDate}|${profileKey}`) || null;
}

function acquireRunLock(rootDir) {
  const lockPath = path.join(rootDir, '待处理', '同步助手运行锁.json');
  const existing = readJson(lockPath, null);
  const startedAt = existing?.startedAt ? Date.parse(existing.startedAt) : NaN;
  // A previous process may have been interrupted. A two-hour-old lock must not
  // prevent the next scheduled run forever.
  let ownerAlive = false;
  try { if (existing?.pid) { process.kill(Number(existing.pid), 0); ownerAlive = true; } } catch (_) { ownerAlive = false; }
  if (existing && ownerAlive && Number.isFinite(startedAt) && Date.now() - startedAt < 2 * 60 * 60 * 1000) {
    throw new Error(`已有同步任务正在运行（开始于 ${existing.startedAt}），请等待其结束后再执行。`);
  }
  if (existing && !ownerAlive) try { fs.unlinkSync(lockPath); } catch (_) { /* replace below */ }
  writeJson(lockPath, { pid: process.pid, startedAt: new Date().toISOString(), mode: checkOnly ? 'preflight' : 'sync' });
  return lockPath;
}

function main() {
  const config = readJson(configPath, null);
  if (!config || !config.rootDir || !Array.isArray(config.shopMappings)) throw new Error('自动化配置不完整');
  // A cancellation request belongs to the previous process tree.  New manual
  // and scheduled runs start with a clean cancellation channel.
  try { fs.unlinkSync(path.join(config.rootDir, '待处理', '同步助手取消请求.json')); } catch (_) { /* no pending request */ }
  const enabled = config.shopMappings.filter(shop => shop.automationEnabled !== false);
  const statePath = path.join(config.rootDir, '待处理', '同步助手状态.json');
  const lockPath = acquireRunLock(config.rootDir);
  const targetDate = utcYesterday();
  const state = {
    mode: checkOnly ? 'preflight' : 'sync', status: 'running', targetDate,
    startedAt: new Date().toISOString(), completedAt: null,
    message: checkOnly ? '正在逐店检查登录、店铺映射、系统授权、账单和推广入口…' : '正在逐店串行同步前一日订单、已结算、未结算账单及推广费…',
    stores: enabled.map(shop => ({ profileKey: shop.profileKey || 'default', store: shop.sellerCenterName, countryCode: shop.countryCode, status: 'waiting' }))
  };
  writeState(statePath, state);
  const billRetryQueue = [];
  const isFailed = stage => stage && stage.status === 'failed';
  const updateStoreStatus = store => {
    const failedStage = [store.order, store.settledBill, store.unsettledBill, store.promotion].find(isFailed);
    store.status = failedStage ? 'failed' : 'completed';
    store.error = failedStage?.error || null;
  };
  const runBillStage = (store, sourceType, retry = false) => {
    const isSettled = sourceType === 'settled';
    const field = isSettled ? 'settledBill' : 'unsettledBill';
    const label = isSettled ? '已结算账单' : '未结算账单';
    state.message = retry
      ? `${checkOnly ? '正在复检' : '正在重试'}${label}：${store.store}`
      : `${checkOnly ? '正在检测' : '正在同步'}${label}：${store.store}`;
    writeState(statePath, state);
    const result = spawnSync(process.execPath, [unsettledBillJobPath, '--store', store.profileKey, '--date', targetDate, ...(isSettled ? ['--source', 'settled'] : []), ...(checkOnly ? ['--dry-run'] : [])], { encoding: 'utf8' });
    const run = isSettled
      ? latestSettledBillRun(config.rootDir, store.profileKey, targetDate)
      : latestUnsettledBillRun(config.rootDir, store.profileKey, targetDate);
    const previous = store[field] || {};
    store[field] = {
      status: run?.status || (result.status === 0 ? 'completed' : 'failed'),
      batchCode: run?.batchCode ?? null,
      error: run?.error || (result.status === 0 ? null : String(result.stderr || result.stdout || `${label}任务未返回结果`).trim()),
      preview: run?.preview ?? null,
      attempts: Number(previous.attempts || 0) + 1,
      retried: retry
    };
    if (retry && previous.error) store[field].initialError = previous.initialError || previous.error;
    if (!isFailed(store[field])) store.unsettledBillBatchCode = isSettled ? store.unsettledBillBatchCode : store[field].batchCode;
    return store[field];
  };
  const sessionKeys = new Set();
  try { for (const store of state.stores) {
    if (cancellationRequested(config.rootDir)) { state.status = 'cancelled'; state.message = '已收到取消请求，未启动后续店铺。'; break; }
    store.status = 'running'; store.startedAt = new Date().toISOString();
    state.message = `${checkOnly ? '正在检测' : '正在同步'}：${store.store}（检查登录）`;
    writeState(statePath, state);
    // First reuse the isolated Chrome session.  If TikTok has expired it, the
    // helper decrypts this store's locally protected credential just long
    // enough to fill the sign-in form.  Captcha/2FA remains a manual step.
    // Always register the dedicated profile before login: failed logins must
    // not leave a newly opened Chrome instance behind either.
    sessionKeys.add(store.profileKey || 'default');
    const loginResult = runStoreLogin(config, store);
    store.login = {
      status: loginResult.status === 0 ? 'completed' : 'failed',
      error: loginResult.status === 0 ? null : String(loginResult.stderr || loginResult.stdout || '自动登录未返回结果').trim()
    };
    if (store.login.status === 'failed') {
      store.order = { status: 'failed', batchCode: null, error: store.login.error };
      store.completedAt = new Date().toISOString();
      updateStoreStatus(store);
      writeState(statePath, state);
      closeStoreSession(store.profileKey || 'default');
      sessionKeys.delete(store.profileKey || 'default');
      continue;
    }
    state.message = `${checkOnly ? '正在检测' : '正在同步'}：${store.store}`;
    writeState(statePath, state);
    const result = spawnSync(process.execPath, [jobPath, '--store', store.profileKey, '--date', targetDate, ...(checkOnly ? ['--dry-run'] : [])], { encoding: 'utf8' });
    const run = latestStoreRun(config.rootDir, store.profileKey, targetDate);
    store.order = { status: run?.status || (result.status === 0 ? 'completed' : 'failed'), batchCode: run?.batchCode ?? null, error: run?.error || (result.status === 0 ? null : String(result.stderr || result.stdout || '订单任务未返回结果').trim()) };
    store.orderCount = run?.orderCount ?? null; store.batchCode = run?.batchCode ?? null;
    const settledEnabled = Number(config.syncRules?.settledBills || 0) >= 1;
    const unsettledEnabled = Number(config.syncRules?.unsettledBills || 0) >= 1;
    const promotionsEnabled = Number(config.syncRules?.promotions || 0) >= 1;
    if (store.order.status !== 'failed') {
      if (settledEnabled) {
        const settled = runBillStage(store, 'settled');
        if (isFailed(settled)) billRetryQueue.push({ store, sourceType: 'settled' });
      }
      if (unsettledEnabled) {
        const unsettled = runBillStage(store, 'unsettled');
        if (isFailed(unsettled)) billRetryQueue.push({ store, sourceType: 'unsettled' });
      }
      // 推广日报来自独立的“店铺广告”数据源。账单平台延迟生成报表时，
      // 不能阻断已经校验通过的推广费同步；账单失败仍会保留在店铺状态中。
      if (promotionsEnabled && store.order.status !== 'failed') {
        state.message = `${checkOnly ? '正在检测推广日报' : '正在同步推广费'}：${store.store}`; writeState(statePath, state);
        const promotionResult = spawnSync(process.execPath, [promotionJobPath, '--store', store.profileKey, '--date', targetDate, ...(checkOnly ? ['--dry-run'] : [])], { encoding: 'utf8' });
        const promotionRun = latestPromotionRun(config.rootDir, store.profileKey, targetDate);
        store.promotion = { status: promotionRun?.status || (promotionResult.status === 0 ? 'completed' : 'failed'), batchCode: promotionRun?.batchCode ?? null, error: promotionRun?.error || (promotionResult.status === 0 ? null : String(promotionResult.stderr || promotionResult.stdout || '推广费任务未返回结果').trim()), preview: promotionRun?.preview ?? null };
        if (store.promotion.status === 'failed') { store.error = store.promotion.error; }
      }
    }
    store.completedAt = new Date().toISOString();
    updateStoreStatus(store);
    writeState(statePath, state);
    // The normal path is now complete for this store.  Do not leave its
    // dedicated Chrome window open while later stores download.  A store with
    // a queued bill retry stays open until that retry finishes below.
    if (!billRetryQueue.some(item => item.store === store)) {
      closeStoreSession(store.profileKey || 'default');
      sessionKeys.delete(store.profileKey || 'default');
    }
  }
    // 首轮已按店铺和任务完整执行。现在仅重试失败的账单，不会重复已成功的订单或推广任务。
    if (billRetryQueue.length) {
      state.message = `首轮任务已完成，正在重试 ${billRetryQueue.length} 个失败账单…`;
      state.billRetryCount = billRetryQueue.length;
      writeState(statePath, state);
      for (const retry of billRetryQueue) {
        retry.store.status = 'retrying';
        runBillStage(retry.store, retry.sourceType, true);
        updateStoreStatus(retry.store);
        retry.store.completedAt = new Date().toISOString();
        writeState(statePath, state);
        closeStoreSession(retry.store.profileKey || 'default');
        sessionKeys.delete(retry.store.profileKey || 'default');
      }
    }
    let failures = 0;
    state.stores.forEach(store => {
      updateStoreStatus(store);
      // 只有订单、各已启用账单和推广任务最终均通过后，才标记浏览器会话可用。
      if (store.status === 'completed') markShopLoginVerified(config, store.profileKey);
      else failures += 1;
    });
    state.completedAt = new Date().toISOString();
    if (state.status !== 'cancelled') state.status = failures ? 'completed_with_errors' : 'completed';
    state.message = failures ? `已完成：${state.stores.length - failures} 家通过，${failures} 家需要处理。` : `已完成：${state.stores.length} 家店铺均通过。`;
    writeState(statePath, state);
    if (failures) process.exitCode = 1;
  } finally {
    for (const profileKey of sessionKeys) closeStoreSession(profileKey);
    try { fs.unlinkSync(lockPath); } catch (_) { /* no-op */ }
  }
}
try { main(); } catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
