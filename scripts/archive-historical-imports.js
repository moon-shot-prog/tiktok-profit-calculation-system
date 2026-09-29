const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const envPath = path.join(__dirname, '..', '.env');
if (typeof process.loadEnvFile === 'function' && fs.existsSync(envPath)) process.loadEnvFile(envPath);

const url = process.env.SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
if (!url || !secret) throw new Error('缺少 SUPABASE_URL 或 SUPABASE_SECRET_KEY，无法进行安全归档');

const client = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
const bucket = 'import-archives';
const dryRun = process.argv.includes('--dry-run');
const limitArg = process.argv.find(value => value.startsWith('--limit='));
const limit = Math.max(1, Number(limitArg?.slice('--limit='.length)) || 1);
const pageSize = 500;

function chunk(values, size = 200) {
  return Array.from({ length: Math.ceil(values.length / size) }, (_, index) => values.slice(index * size, index * size + size));
}

async function loadPages(queryBuilder) {
  const rows = [];
  for (let start = 0; ; start += pageSize) {
    const { data, error } = await queryBuilder(start, start + pageSize - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < pageSize) return rows;
  }
}

async function batchesWithoutArchive() {
  const [{ data: batches, error: batchError }, { data: archives, error: archiveError }] = await Promise.all([
    client.from('order_import_batches').select('id, batch_code, import_type, created_at').in('import_type', ['orders', 'settled_bills', 'unsettled_bills']).order('created_at', { ascending: true }),
    client.from('import_archives').select('batch_id')
  ]);
  if (batchError || archiveError) throw batchError || archiveError;
  const archived = new Set((archives || []).map(item => item.batch_id));
  return (batches || []).filter(batch => !archived.has(batch.id));
}

async function sourceRecords(batch) {
  if (batch.import_type !== 'orders') {
    const rows = await loadPages((from, to) => client.from('tiktok_bill_records')
      .select('id, raw_data, settlement_amount, total_income, total_fees')
      .eq('import_batch_id', batch.id)
      .not('raw_data', 'is', null)
      .range(from, to));
    const records = rows.filter(row => !row.raw_data?.archived).map(row => ({ entity: 'tiktok_bill_records', id: row.id, raw_data: row.raw_data }));
    const totals = rows.reduce((value, row) => ({ settlement: value.settlement + Number(row.settlement_amount || 0), income: value.income + Number(row.total_income || 0), fees: value.fees + Number(row.total_fees || 0) }), { settlement: 0, income: 0, fees: 0 });
    return { records, totals, tableCounts: { tiktok_bill_records: records.length } };
  }

  const orders = await loadPages((from, to) => client.from('orders')
    .select('id, raw_data, payment_amount')
    .eq('source_identifier', batch.batch_code)
    .not('raw_data', 'is', null)
    .range(from, to));
  const orderIds = orders.map(row => row.id);
  const itemRows = [];
  for (const ids of chunk(orderIds)) {
    const rows = await loadPages((from, to) => client.from('order_items')
      .select('id, raw_data, allocated_payment')
      .in('order_id', ids)
      .not('raw_data', 'is', null)
      .range(from, to));
    itemRows.push(...rows);
  }
  const cleanOrders = orders.filter(row => !row.raw_data?.archived);
  const cleanItems = itemRows.filter(row => !row.raw_data?.archived);
  return {
    records: [
      ...cleanOrders.map(row => ({ entity: 'orders', id: row.id, raw_data: row.raw_data })),
      ...cleanItems.map(row => ({ entity: 'order_items', id: row.id, raw_data: row.raw_data }))
    ],
    totals: {
      payment: orders.reduce((sum, row) => sum + Number(row.payment_amount || 0), 0),
      allocated: itemRows.reduce((sum, row) => sum + Number(row.allocated_payment || 0), 0)
    },
    tableCounts: { orders: cleanOrders.length, order_items: cleanItems.length }
  };
}

function roundedTotals(totals) {
  return Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, Number(Number(value).toFixed(2))]));
}

async function replaceRawData(table, ids, marker) {
  for (const idsChunk of chunk(ids)) {
    const { error } = await client.from(table).update({ raw_data: marker }).in('id', idsChunk);
    if (error) throw error;
  }
}

async function verifyMarker(table, archiveId, ids) {
  if (!ids.length) return;
  const rows = [];
  for (const idsChunk of chunk(ids)) {
    const { data, error } = await client.from(table).select('id, raw_data').in('id', idsChunk);
    if (error) throw error;
    rows.push(...(data || []));
  }
  const marked = rows.filter(row => row.raw_data?.archived === true && row.raw_data?.archive_id === archiveId).length;
  if (rows.length !== ids.length || marked !== ids.length) throw new Error(`归档后 ${table} 校验失败：预期 ${ids.length}，实际 ${marked}`);
}

async function archiveBatch(batch) {
  const source = await sourceRecords(batch);
  if (!source.records.length) return { skipped: true, batchCode: batch.batch_code, reason: '无待归档原始字段' };

  const payload = Buffer.from(JSON.stringify({
    format: 'tiktok-profit-historical-raw-v1',
    batch: { id: batch.id, code: batch.batch_code, type: batch.import_type, createdAt: batch.created_at },
    archivedAt: new Date().toISOString(),
    records: source.records
  }));
  const sha256 = crypto.createHash('sha256').update(payload).digest('hex');
  // Storage object keys must be portable across providers. Keep the readable
  // batch code in metadata/file name, but use the UUID for the path segment.
  const archivePath = `historical/${batch.created_at.slice(0, 10)}/${batch.id}/${sha256.slice(0, 16)}-raw.json`;
  const summary = { batchCode: batch.batch_code, type: batch.import_type, rows: source.records.length, bytes: payload.length, sha256, totals: roundedTotals(source.totals), tableCounts: source.tableCounts };
  if (dryRun) return { dryRun: true, ...summary };

  const { error: uploadError } = await client.storage.from(bucket).upload(archivePath, payload, { contentType: 'application/json', upsert: false });
  if (uploadError) throw new Error(`上传归档文件失败：${uploadError.message}`);
  const { data: downloaded, error: downloadError } = await client.storage.from(bucket).download(archivePath);
  if (downloadError) throw new Error(`读取归档文件失败：${downloadError.message}`);
  const downloadedHash = crypto.createHash('sha256').update(Buffer.from(await downloaded.arrayBuffer())).digest('hex');
  if (downloadedHash !== sha256) throw new Error('归档文件哈希校验失败，未清理原始字段');

  const { data: archive, error: archiveError } = await client.from('import_archives').insert({
    batch_id: batch.id,
    storage_path: archivePath,
    source_file_name: `${batch.batch_code}-historical-raw.json`,
    source_content_type: 'application/json',
    byte_size: payload.length,
    sha256,
    row_count: source.records.length
  }).select('id, storage_path, sha256, row_count').single();
  if (archiveError) throw new Error(`写入归档索引失败：${archiveError.message}`);
  if (archive.sha256 !== sha256 || archive.row_count !== source.records.length) throw new Error('归档索引校验失败，未清理原始字段');

  const marker = { archived: true, archive_id: archive.id, archive_path: archive.storage_path, archived_at: new Date().toISOString() };
  for (const table of Object.keys(source.tableCounts)) {
    const ids = source.records.filter(record => record.entity === table).map(record => record.id);
    await replaceRawData(table, ids, marker);
    await verifyMarker(table, archive.id, ids);
  }
  return { archived: true, ...summary, archiveId: archive.id, archivePath };
}

async function main() {
  const candidates = await batchesWithoutArchive();
  const results = [];
  for (const batch of candidates) {
    const result = await archiveBatch(batch);
    results.push(result);
    console.log(JSON.stringify(result));
    if (!result.skipped && results.filter(item => !item.skipped).length >= limit) break;
  }
  if (!results.some(item => !item.skipped)) console.log(JSON.stringify({ message: '没有待归档的历史原始字段' }));
}

main().catch(error => { console.error(error.message || error); process.exitCode = 1; });
