/*
 * 本地同步助手（第一阶段）
 *
 * 只扫描和校验本地下载文件，绝不写入订单、账单或数据库。
 * 工作流：接收箱 -> 识别类型与表头 -> 待处理/同步清单.json。
 * 后续阶段才会在管理员确认后调用系统的导入接口。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ExcelJS = require('exceljs');

const scriptDirectory = __dirname;
const configPath = path.join(scriptDirectory, 'local-sync.config.json');
const configExamplePath = path.join(scriptDirectory, 'local-sync.config.example.json');
const supportedExtensions = new Set(['.csv', '.xlsx', '.xls']);
const ignoredFilePattern = /(^~\$|\.crdownload$|\.part$|\.tmp$)/i;

function ensureConfig() {
  if (!fs.existsSync(configPath)) {
    fs.copyFileSync(configExamplePath, configPath);
    console.log(`已创建本机配置：${configPath}`);
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!config.rootDir || !path.isAbsolute(config.rootDir)) throw new Error('rootDir 必须是本机绝对路径');
  return {
    rootDir: config.rootDir,
    scanIntervalSeconds: Math.max(20, Number(config.scanIntervalSeconds) || 60),
    minimumFileAgeSeconds: Math.max(10, Number(config.minimumFileAgeSeconds) || 20)
  };
}

function ensureFolders(rootDir) {
  const folders = ['接收箱', '已校验', '导入成功', '待处理', '失败'];
  folders.forEach(folder => fs.mkdirSync(path.join(rootDir, folder), { recursive: true }));
  return Object.fromEntries(folders.map(folder => [folder, path.join(rootDir, folder)]));
}

function normalizeHeader(value) {
  return String(value || '')
    .replace(/^\uFEFF/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function headerHas(headers, ...names) {
  return names.some(name => headers.has(normalizeHeader(name)));
}

function classifyHeaders(values) {
  const headers = new Set(values.map(normalizeHeader).filter(Boolean));
  const orderScore = Number(headerHas(headers, 'Order ID', '订单ID', '订单 ID')) + Number(headerHas(headers, 'SKU ID', 'SKU_ID', 'sku_id')) + Number(headerHas(headers, 'Created Time', '下单日期', '订单创建时间'));
  const estimated = headerHas(headers, 'Estimated Settlement Amount', '预计结算金额', '预估结算金额');
  const settlementDate = headerHas(headers, 'Settlement Date', 'Statement Date', '结算日期');
  const settlementId = headerHas(headers, 'Settlement ID', 'Statement ID', '结算单 ID', '结算单ID');
  if (orderScore >= 2) return { type: 'orders', label: '订单明细', confidence: orderScore };
  if (estimated) return { type: 'unsettled_bills', label: '未结算账单', confidence: 3 };
  if (settlementDate && settlementId) return { type: 'settled_bills', label: '已结算账单', confidence: 3 };
  return { type: 'unknown', label: '未识别', confidence: 0 };
}

async function readWorksheetRows(filePath, extension) {
  if (extension === '.xls') throw new Error('暂不支持旧版 .xls，请在 Seller Center 导出 CSV 或 XLSX');
  const workbook = new ExcelJS.Workbook();
  if (extension === '.csv') await workbook.csv.readFile(filePath);
  else await workbook.xlsx.readFile(filePath);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error('文件不含可读取的工作表');
  const rows = [];
  for (let rowNumber = 1; rowNumber <= Math.min(20, worksheet.rowCount); rowNumber += 1) {
    const values = worksheet.getRow(rowNumber).values.slice(1).map(value => {
      if (value && typeof value === 'object' && 'text' in value) return value.text;
      return value;
    });
    rows.push({ rowNumber, values });
  }
  return rows;
}

async function inspectFile(filePath) {
  const stat = fs.statSync(filePath);
  const extension = path.extname(filePath).toLowerCase();
  const buffer = fs.readFileSync(filePath);
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const rows = await readWorksheetRows(filePath, extension);
  const candidates = rows.map(row => ({ ...row, classification: classifyHeaders(row.values) }));
  const best = candidates.sort((left, right) => right.classification.confidence - left.classification.confidence)[0];
  return {
    fileName: path.basename(filePath),
    filePath,
    extension,
    sizeBytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    sha256,
    headerRow: best?.rowNumber || null,
    headers: (best?.values || []).map(value => String(value || '').trim()).filter(Boolean),
    ...best.classification
  };
}

function readManifest(manifestPath) {
  try { return JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
  catch (_) { return { generatedAt: null, files: [] }; }
}

function writeManifest(manifestPath, manifest) {
  const temporaryPath = `${manifestPath}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(manifest, null, 2), 'utf8');
  fs.renameSync(temporaryPath, manifestPath);
}

function readAutomationAssignment(filePath) {
  const sidecarPath = `${filePath}.automation.json`;
  if (!fs.existsSync(sidecarPath)) return null;
  try {
    const assignment = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
    if (!assignment?.shop || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(assignment.shop.id || '')) return null;
    if (!assignment.shop.name || !assignment.shop.countryCode) return null;
    return assignment;
  } catch (_) {
    return null;
  }
}

function argumentValue(name) {
  const position = process.argv.indexOf(name);
  return position >= 0 ? process.argv[position + 1] : null;
}

function assignShop(config) {
  const fileName = argumentValue('--file');
  const shopId = argumentValue('--shop-id');
  const shopName = argumentValue('--shop-name');
  const countryCode = argumentValue('--country-code');
  if (!fileName || !shopId || !shopName || !countryCode) {
    throw new Error('店铺配对需要 --file、--shop-id、--shop-name 和 --country-code 参数');
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(shopId)) {
    throw new Error('店铺 ID 格式无效，已拒绝配对');
  }
  const folders = ensureFolders(config.rootDir);
  const manifestPath = path.join(folders['待处理'], '同步清单.json');
  const manifest = readManifest(manifestPath);
  const matchedFiles = (manifest.files || []).filter(file => file.fileName === fileName);
  if (matchedFiles.length !== 1) {
    throw new Error(matchedFiles.length ? `发现 ${matchedFiles.length} 个同名文件，已拒绝配对` : '未在待处理清单中找到该文件');
  }
  const file = matchedFiles[0];
  if (file.type === 'unknown') throw new Error('文件类型尚未识别，不能配对店铺');
  file.shop = {
    id: shopId,
    name: shopName,
    countryCode: countryCode.toUpperCase(),
    assignedAt: new Date().toISOString(),
    source: 'database-verified'
  };
  file.status = 'ready_for_import_review';
  manifest.generatedAt = new Date().toISOString();
  writeManifest(manifestPath, manifest);
  console.log(`已完成本机配对：${file.fileName} -> ${shopName} (${countryCode.toUpperCase()})。仍未导入任何数据。`);
}

async function scan(config) {
  const folders = ensureFolders(config.rootDir);
  const manifestPath = path.join(folders['待处理'], '同步清单.json');
  const manifest = readManifest(manifestPath);
  const knownHashes = new Set((manifest.files || []).map(file => file.sha256));
  const now = Date.now();
  const files = fs.readdirSync(folders['接收箱'], { withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => path.join(folders['接收箱'], entry.name))
    .filter(filePath => supportedExtensions.has(path.extname(filePath).toLowerCase()) && !ignoredFilePattern.test(path.basename(filePath)));

  const additions = [];
  for (const filePath of files) {
    const stat = fs.statSync(filePath);
    if (now - stat.mtimeMs < config.minimumFileAgeSeconds * 1000) continue;
    try {
      const inspected = await inspectFile(filePath);
      if (knownHashes.has(inspected.sha256)) continue;
      const automation = readAutomationAssignment(filePath);
      const canAutoAssign = automation && inspected.type !== 'unknown';
      additions.push({
        ...inspected,
        ...(canAutoAssign ? { shop: automation.shop, automation: { downloadedAt: automation.downloadedAt, source: 'seller-center-verified' } } : {}),
        status: inspected.type === 'unknown' ? 'needs_review' : (canAutoAssign ? 'ready_for_import_review' : 'ready_for_review'),
        scannedAt: new Date().toISOString(),
        importStatus: 'not_started'
      });
      knownHashes.add(inspected.sha256);
    } catch (error) {
      additions.push({ fileName: path.basename(filePath), filePath, status: 'needs_review', error: error.message, scannedAt: new Date().toISOString(), importStatus: 'not_started' });
    }
  }
  if (additions.length || !fs.existsSync(manifestPath)) {
    manifest.files = [...(manifest.files || []), ...additions];
    manifest.generatedAt = new Date().toISOString();
    writeManifest(manifestPath, manifest);
  }
  console.log(`扫描完成：发现 ${files.length} 个下载文件，新增待处理 ${additions.length} 个。`);
  if (additions.length) additions.forEach(file => console.log(`- ${file.fileName}：${file.label || '待人工确认'}（${file.status}）`));
}

async function main() {
  const config = ensureConfig();
  if (process.argv.includes('--assign')) {
    assignShop(config);
    return;
  }
  const watchMode = process.argv.includes('--watch');
  await scan(config);
  if (!watchMode) return;
  console.log(`正在监控 ${path.join(config.rootDir, '接收箱')}，每 ${config.scanIntervalSeconds} 秒扫描一次。按 Ctrl+C 停止。`);
  setInterval(() => scan(config).catch(error => console.error(`扫描失败：${error.message}`)), config.scanIntervalSeconds * 1000);
}

main().catch(error => { console.error(`本地同步助手启动失败：${error.message}`); process.exitCode = 1; });
