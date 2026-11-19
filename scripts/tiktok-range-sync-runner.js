/* Historical range sync. Every selected category is exported once for its
 * complete date interval; it must never expand a range into daily downloads. */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const dir = __dirname;
const configPath = path.join(dir, 'tiktok-automation.config.json');
const loginPath = path.join(dir, 'tiktok-seller-auto-login.js');
const closeSessionPath = path.join(dir, 'tiktok-browser-session-close.js');
const jobs = { orders: path.join(dir, 'tiktok-daily-job.js'), settledBills: path.join(dir, 'tiktok-unsettled-bill-job.js'), unsettledBills: path.join(dir, 'tiktok-unsettled-bill-job.js'), promotions: path.join(dir, 'tiktok-promotion-job.js') };
function initialTargetUrl(config, store, type) {
  const base = String(config.sellerCenterUrl).replace(/\/$/, '');
  if (type === 'settledBills' || type === 'unsettledBills') return `${base}/finance/bills?subTab=bills&tab=statements`;
  if (type === 'promotions') return `${base}/ads-creation?origin=SC_ads_tab_button_PC&shop_region=${encodeURIComponent(store.countryCode)}`;
  return `${base}/order?shop_region=${encodeURIComponent(store.countryCode)}&tab=all`;
}
function waitSync(milliseconds) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds); }
function runStoreLogin(config, store, type) {
  let result = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    result = spawnSync(process.execPath, [loginPath, '--store', store.profileKey, '--continue-url', initialTargetUrl(config, store, type), '--keep-session'], { encoding: 'utf8' });
    const detail = String(result.stderr || result.stdout || '');
    if (result.status === 0 || attempt === 2 || !/target page, context or browser has been closed/i.test(detail)) break;
    waitSync(2000);
  }
  return result;
}
function closeStoreSession(profileKey) { spawnSync(process.execPath, [closeSessionPath, '--store', profileKey], { encoding: 'utf8', timeout: 15000 }); }
function read(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; } }
function write(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8'); }
function writeState(file, value) { value.pid = process.pid; value.heartbeatAt = new Date().toISOString(); write(file, value); }
function lockPath(rootDir) { return path.join(rootDir, '待处理', '同步助手运行锁.json'); }
function acquireLock(rootDir) {
  const file = lockPath(rootDir); const current = read(file, null); const started = Date.parse(current?.startedAt || '');
  let ownerAlive = false;
  try { if (current?.pid) { process.kill(Number(current.pid), 0); ownerAlive = true; } } catch (_) { ownerAlive = false; }
  if (current && ownerAlive && Number.isFinite(started) && Date.now() - started < 2 * 60 * 60 * 1000) throw new Error(`已有同步任务正在运行（开始于 ${current.startedAt}）。`);
  if (current && !ownerAlive) try { fs.unlinkSync(file); } catch (_) { /* replace below */ }
  write(file, { pid: process.pid, startedAt: new Date().toISOString(), mode: 'custom_range' }); return file;
}
function cancelled(rootDir) { return fs.existsSync(path.join(rootDir, '待处理', '同步助手取消请求.json')); }
function parseRanges() { const encoded = process.argv[process.argv.indexOf('--ranges') + 1]; if (!encoded) throw new Error('缺少日期范围'); const input = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')); const output = {}; for (const key of Object.keys(jobs)) { const range = input[key]; if (!range) continue; if (!/^\d{4}-\d{2}-\d{2}$/.test(range.start) || !/^\d{4}-\d{2}-\d{2}$/.test(range.end) || range.start > range.end) throw new Error(`${key} 的日期范围无效`); const duration = (Date.parse(`${range.end}T00:00:00Z`) - Date.parse(`${range.start}T00:00:00Z`)) / 86400000 + 1; if (duration > 366) throw new Error('单个日期范围最多 366 天'); output[key] = { ...range, duration }; } if (!Object.keys(output).length) throw new Error('请至少选择一种数据类型'); return output; }
function main() {
  const config = read(configPath, null); if (!config?.rootDir) throw new Error('自动化配置不完整');
  try { fs.unlinkSync(path.join(config.rootDir, '待处理', '同步助手取消请求.json')); } catch (_) { /* no pending request */ }
  const ranges = parseRanges(), stores = (config.shopMappings || []).filter(shop => shop.automationEnabled !== false);
  const statePath = path.join(config.rootDir, '待处理', '同步助手状态.json');
  const activeLock = acquireLock(config.rootDir);
  const state = { mode: 'custom_range', status: 'running', startedAt: new Date().toISOString(), completedAt: null, ranges, message: '正在按自定义日期范围同步…', stores: stores.map(shop => ({ store: shop.sellerCenterName, countryCode: shop.countryCode, profileKey: shop.profileKey || 'default', status: 'waiting' })) };
  writeState(statePath, state); let failures = 0; const sessionKeys = new Set();
  try { for (const store of state.stores) {
    if (cancelled(config.rootDir)) { state.status = 'cancelled'; state.message = '已收到取消请求，未启动后续店铺。'; break; }
    store.status = 'running'; state.message = `正在检查登录：${store.store}`; writeState(statePath, state);
    const firstType = Object.keys(ranges)[0];
    sessionKeys.add(store.profileKey || 'default');
    const login = runStoreLogin(config, store, firstType);
    store.login = { status: login.status === 0 ? 'completed' : 'failed', error: login.status === 0 ? null : String(login.stderr || login.stdout || '自动登录失败').trim() };
    if (login.status !== 0) { store.status = 'failed'; store.error = store.login.error; failures += 1; writeState(statePath, state); continue; }
    for (const [type, range] of Object.entries(ranges)) {
      // The UI reads this state while the child process is running.  Do not
      // pre-mark it completed, otherwise the user sees “已完成” while the
      // file is still being generated and assumes later shops were skipped.
      const result = { status: 'running', range: `${range.start} 至 ${range.end}`, exportCount: 0, error: null };
      store[type] = result;
      if (cancelled(config.rootDir)) { state.status = 'cancelled'; state.message = '已收到取消请求，未启动后续数据类型。'; break; }
      state.message = `正在同步${type}：${store.store} · ${range.start} 至 ${range.end}`; writeState(statePath, state);
      const args = [jobs[type], '--store', store.profileKey, '--start-date', range.start, '--end-date', range.end]; if (type === 'settledBills') args.push('--source', 'settled');
      const task = spawnSync(process.execPath, args, { encoding: 'utf8' });
      if (task.status === 0) { result.status = 'completed'; result.exportCount = 1; }
      else { result.status = 'failed'; result.error = String(task.stderr || task.stdout || '任务失败').trim().slice(0, 500); store.status = 'failed'; store.error = `${type} 范围导出失败：${result.error}`; }
      writeState(statePath, state);
    }
    if (store.status !== 'failed') store.status = 'completed'; else failures += 1;
    store.completedAt = new Date().toISOString(); writeState(statePath, state);
  }
  state.completedAt = new Date().toISOString(); if (state.status !== 'cancelled') state.status = failures ? 'completed_with_errors' : 'completed'; state.message = state.status === 'cancelled' ? '范围同步已取消。' : (failures ? `范围同步完成：${stores.length - failures} 家通过，${failures} 家需要处理。` : `范围同步完成：${stores.length} 家店铺均通过。`); writeState(statePath, state); if (failures) process.exitCode = 1;
  } finally { for (const profileKey of sessionKeys) closeStoreSession(profileKey); try { fs.unlinkSync(activeLock); } catch (_) {} }
}
try { main(); } catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
