const fs = require('fs');
const path = require('path');

// Downloaded source files are intentionally kept outside the automation work
// directory, so operators can review them even after a successful import.
const DOWNLOAD_DIRECTORY = 'G:\\codex\\自动下载';
const STAGING_DIRECTORY = path.join(DOWNLOAD_DIRECTORY, '.下载中');

function safePart(value, fallback) {
  const text = String(value || fallback || '').trim().replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ');
  return text || fallback;
}
function contentDateLabel(value = new Date()) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(至\d{4}-\d{2}-\d{2})?$/.test(value)) return value;
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(value);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
function extensionOf(filePath, fallback = '.xlsx') {
  const extension = path.extname(String(filePath || '')).toLowerCase();
  return /^\.(csv|xlsx|xls)$/i.test(extension) ? extension : fallback;
}
function ensureDownloadDirectory() { fs.mkdirSync(DOWNLOAD_DIRECTORY, { recursive: true }); return DOWNLOAD_DIRECTORY; }
function stagingDirectory() { fs.mkdirSync(STAGING_DIRECTORY, { recursive: true }); return STAGING_DIRECTORY; }
function outputPath(fileType, mapping, extension, contentDate = new Date()) {
  ensureDownloadDirectory();
  const baseName = [safePart(fileType, '下载文件'), safePart(mapping?.sellerCenterName || mapping?.systemShopCode, '店铺'), safePart(mapping?.countryCode, '站点'), contentDateLabel(contentDate)].join('_');
  const suffix = extensionOf(`file${extension || ''}`, '.xlsx');
  let candidate = path.join(DOWNLOAD_DIRECTORY, `${baseName}${suffix}`), sequence = 2;
  while (fs.existsSync(candidate)) candidate = path.join(DOWNLOAD_DIRECTORY, `${baseName}_${sequence++}${suffix}`);
  return candidate;
}
function finalizeDownloadedFile(sourcePath, fileType, mapping, contentDate) {
  const destination = outputPath(fileType, mapping, extensionOf(sourcePath), contentDate);
  fs.renameSync(sourcePath, destination);
  return destination;
}

module.exports = { DOWNLOAD_DIRECTORY, ensureDownloadDirectory, stagingDirectory, outputPath, finalizeDownloadedFile };
