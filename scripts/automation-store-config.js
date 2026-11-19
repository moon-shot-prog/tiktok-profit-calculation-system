const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, 'tiktok-automation.config.json');
const [action, sellerCenterName, countryCode, systemShopCode] = process.argv.slice(2);

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!['add', 'remove', 'list', 'save-settings', 'save-rules'].includes(action)) fail('不支持的店铺配置操作');
if (!['list', 'save-settings', 'save-rules'].includes(action) && ![sellerCenterName, countryCode].every(value => String(value || '').trim())) {
  fail('TikTok 后台店铺名称、站点代码均不能为空');
}
if (action === 'add' && !String(systemShopCode || '').trim()) {
  fail('系统店铺简称不能为空');
}

let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (error) {
  fail(`无法读取店铺配置：${error.message}`);
}

config.shopMappings = Array.isArray(config.shopMappings) ? config.shopMappings : [];
if (action === 'list') {
  console.log(JSON.stringify(config.shopMappings));
  process.exit(0);
}

if (action === 'save-settings') {
  const lookbackDays = Number(sellerCenterName);
  if (!Number.isInteger(lookbackDays) || lookbackDays < 1 || lookbackDays > 31) fail('每日导出范围必须是 1 至 31 天');
  const enabledKeys = new Set(String(countryCode || '').split(',').filter(Boolean));
  config.exportLookbackDays = lookbackDays;
  config.shopMappings.forEach(shop => { shop.automationEnabled = enabledKeys.has(shop.profileKey || 'default'); });
  const tempPath = `${configPath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, configPath);
  console.log(JSON.stringify({ ok: true, count: config.shopMappings.length, lookbackDays }));
  process.exit(0);
}

if (action === 'save-rules') {
  let rules;
  try { rules = JSON.parse(Buffer.from(String(sellerCenterName || ''), 'base64').toString('utf8')); } catch (_) { fail('同步规则格式无效'); }
  for (const key of ['orders', 'settledBills', 'unsettledBills']) {
    if (!Number.isInteger(rules[key]) || rules[key] < 1 || rules[key] > 31) fail(`${key} 必须是 1 至 31 天`);
  }
  // Promotion sync has not been connected yet.  Zero explicitly means
  // “disabled / pending integration”, rather than an invalid day count.
  if (!Number.isInteger(rules.promotions) || rules.promotions < 0 || rules.promotions > 31) fail('promotions 必须是 0 至 31 天');
  const enabledKeys = new Set(Array.isArray(rules.enabledKeys) ? rules.enabledKeys : []);
  config.exportLookbackDays = rules.orders;
  config.syncRules = { orders: rules.orders, settledBills: rules.settledBills, unsettledBills: rules.unsettledBills, promotions: rules.promotions };
  config.shopMappings.forEach(shop => { shop.automationEnabled = enabledKeys.has(shop.profileKey || 'default'); });
  const tempPath = `${configPath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, configPath);
  console.log(JSON.stringify({ ok: true, syncRules: config.syncRules }));
  process.exit(0);
}
const name = sellerCenterName.trim();
const country = countryCode.trim().toUpperCase();
const code = String(systemShopCode || '').trim();

if (action === 'remove') {
  const index = config.shopMappings.findIndex(shop => shop.sellerCenterName === name && String(shop.countryCode).toUpperCase() === country);
  if (index < 0) fail(`未找到店铺“${name} · ${country}”`);
  config.shopMappings.splice(index, 1);
  const tempPath = `${configPath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, configPath);
  console.log(JSON.stringify({ ok: true, count: config.shopMappings.length }));
  process.exit(0);
}

if (config.shopMappings.some(shop => shop.sellerCenterName === name && String(shop.countryCode).toUpperCase() === country)) {
  fail(`店铺“${name} · ${country}”已存在，无需重复添加`);
}

const baseKey = code.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'shop';
let profileKey = baseKey;
let suffix = 2;
while (config.shopMappings.some(shop => shop.profileKey === profileKey)) profileKey = `${baseKey}-${suffix++}`;

config.shopMappings.push({
  sellerCenterName: name,
  countryCode: country,
  systemShopCode: code,
  systemShopName: code,
  profileKey,
  automationEnabled: true,
  verifiedAt: null
});

const tempPath = `${configPath}.tmp`;
fs.writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
fs.renameSync(tempPath, configPath);
console.log(JSON.stringify({ ok: true, profileKey, count: config.shopMappings.length }));
