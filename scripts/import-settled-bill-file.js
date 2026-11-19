/* Imports one verified settled-bill workbook through the normal bill-import API. */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ExcelJS = require('exceljs');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'tiktok-automation.config.json'), 'utf8'));
const filePath = process.argv[2];
const targetDate = process.argv[3];
if (!filePath || !targetDate || !fs.existsSync(filePath)) throw new Error('请提供存在的账单文件和目标日期');

function session() {
  const vault = path.join(__dirname, 'SystemAuthVault.exe');
  const result = spawnSync(vault, ['read', config.rootDir], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0 || !String(result.stdout || '').trim()) throw new Error('系统管理员授权不可用');
  return JSON.parse(Buffer.from(String(result.stdout).trim(), 'base64').toString('utf8'));
}
async function verifyDate() {
  const book = new ExcelJS.Workbook(); await book.xlsx.readFile(filePath); const sheet = book.worksheets[0];
  const header = sheet.getRow(1).values.slice(1).map(value => String(value || '').trim()); const index = header.indexOf('结算日期');
  if (index < 0) throw new Error('文件缺少“结算日期”列');
  const selected = [];
  for (let row = 2; row <= sheet.rowCount; row += 1) {
    const line = sheet.getRow(row); const date = line.getCell(index + 1).text.trim().replace(/\//g, '-');
    if (date !== targetDate) continue;
    const item = {}; header.forEach((name, cell) => { if (name) item[name] = line.getCell(cell + 1).text; }); item['结算日期'] = targetDate; item.__sourceRowNumber = row; selected.push(item);
  }
  if (!selected.length) throw new Error(`文件中没有结算日期为 ${targetDate} 的记录`);
  const filteredPath = path.join(config.rootDir, '接收箱', `已结算-${targetDate}-${path.basename(filePath)}`);
  fs.mkdirSync(path.dirname(filteredPath), { recursive: true });
  const output = new ExcelJS.Workbook(); const outputSheet = output.addWorksheet('已结算账单'); outputSheet.addRow(header);
  selected.forEach(item => outputSheet.addRow(header.map(name => item[name] || '')));
  await output.xlsx.writeFile(filteredPath);
  return { selected, filteredPath };
}
async function main() {
  const filtered = await verifyDate(); const rows = filtered.selected; const auth = session(); const url = String(config.systemUrl).replace(/\/$/, '');
  const mapping = config.shopMappings.find(item => (item.profileKey || 'default') === 'default');
  const shopsResponse = await fetch(`${url}/api/admin/order-import-configuration`, { headers: { Authorization: `Bearer ${auth.accessToken}` } });
  const shops = await shopsResponse.json(); const shop = (shops.shops || []).find(item => item.id === mapping.systemShopId || item.code === mapping.systemShopCode);
  if (!shop) throw new Error('未找到 Feilinka TH 的系统店铺映射');
  const payload = { sourceType: 'settled', shopId: shop.id, fileName: path.basename(filtered.filteredPath), fileBase64: fs.readFileSync(filtered.filteredPath).toString('base64') };
  const submit = async mode => { const response = await fetch(`${url}/api/admin/bill-imports`, { method: 'POST', headers: { Authorization: `Bearer ${auth.accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, mode }) }); const data = await response.json().catch(() => ({})); if (!response.ok || !data.valid) throw new Error(`${data.message || '账单校验未通过'} ${JSON.stringify((data.failures || []).slice(0, 10))}`); return data; };
  const preview = await submit('preview'); const committed = await submit('commit');
  const archive = path.join(config.rootDir, '导入成功', `${committed.batchCode}-${path.basename(filtered.filteredPath)}`); fs.mkdirSync(path.dirname(archive), { recursive: true }); fs.renameSync(filtered.filteredPath, archive);
  console.log(JSON.stringify({ targetDate, workbookRows: rows.length, preview: { insertCount: preview.insertCount, updateCount: preview.updateCount, skipCount: preview.skipCount, replaceCount: preview.replaceCount, reviewCount: preview.reviewCount }, batchCode: committed.batchCode, message: committed.message, archive }, null, 2));
}
main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
