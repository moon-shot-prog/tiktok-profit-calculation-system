/* Controlled historical re-import runner. Processes selected dates serially. */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const scriptDirectory = __dirname;
const configPath = path.join(scriptDirectory, 'tiktok-automation.config.json');
const orderJob = path.join(scriptDirectory, 'tiktok-daily-job.js');
const billJob = path.join(scriptDirectory, 'tiktok-unsettled-bill-job.js');
const promotionJob = path.join(scriptDirectory, 'tiktok-promotion-job.js');
const dateText = process.argv.find((value, index) => process.argv[index - 1] === '--dates') || '';
const dates = [...new Set(dateText.split(',').map(value => value.trim()).filter(value => /^\d{4}-\d{2}-\d{2}$/.test(value)))].sort();

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temporary, filePath);
}
function runJob(file, arguments) {
  const result = spawnSync(process.execPath, [file, ...arguments], { encoding: 'utf8' });
  return { status: result.status === 0 ? 'completed' : 'failed', error: result.status === 0 ? null : String(result.stderr || result.stdout || '任务未返回结果').trim().slice(-1500) };
}
function main() {
  if (!dates.length) throw new Error('请通过 --dates 指定至少一个 YYYY-MM-DD 日期。');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const enabled = (config.shopMappings || []).filter(shop => shop.automationEnabled !== false);
  if (!config.rootDir || !enabled.length) throw new Error('没有已启用的店铺配置。');
  const statePath = path.join(config.rootDir, '待处理', '历史重导入状态.json');
  const state = { status: 'running', dates, startedAt: new Date().toISOString(), completedAt: null, stores: [] };
  writeJson(statePath, state);
  let failures = 0;
  try {
    for (const date of dates) for (const shop of enabled) {
      const item = { date, store: shop.sellerCenterName, profileKey: shop.profileKey || 'default', status: 'running', startedAt: new Date().toISOString() };
      state.stores.push(item); writeJson(statePath, state);
      const base = ['--store', item.profileKey, '--date', date];
      item.order = runJob(orderJob, base);
      item.settledBill = runJob(billJob, [...base, '--source', 'settled']);
      item.unsettledBill = runJob(billJob, base);
      item.promotion = runJob(promotionJob, base);
      const failed = [item.order, item.settledBill, item.unsettledBill, item.promotion].some(stage => stage.status === 'failed');
      item.status = failed ? 'completed_with_errors' : 'completed';
      item.completedAt = new Date().toISOString();
      if (failed) failures += 1;
      writeJson(statePath, state);
    }
    state.status = failures ? 'completed_with_errors' : 'completed';
  } finally {
    state.completedAt = new Date().toISOString();
    writeJson(statePath, state);
  }
  if (failures) process.exitCode = 1;
}
try { main(); } catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
