/*
 * Imports a completed read-only source export into the local PostgreSQL
 * database. It uses psql and a password supplied only through the calling
 * PowerShell session; no password is saved to disk.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const dataDir = option('--data-dir');
const psql = option('--psql');
const database = option('--database') || 'tiktok_profit_local';
const user = option('--user') || 'tiktok_app';
const resetLocalData = process.argv.includes('--reset-local-data');
const verifyOnly = process.argv.includes('--verify-only');
if (!dataDir || !psql) throw new Error('Usage: --data-dir <export-folder> --psql <psql.exe> [--database name] [--user name]');

const resolvedDataDir = path.resolve(dataDir);
const manifestPath = path.join(resolvedDataDir, 'manifest.json');
if (!fs.existsSync(manifestPath)) throw new Error(`manifest.json was not found in ${resolvedDataDir}`);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

// This is also the foreign-key safe import order.
const tables = [
  'profiles', 'user_roles', 'warehouses', 'shops', 'user_shop_permissions',
  'shop_warehouses', 'country_sites', 'warehouse_country_sites',
  'warehouse_cost_versions', 'products', 'product_cost_versions',
  'settlement_exchange_rates', 'settlement_exchange_rate_versions',
  'order_import_batches', 'orders', 'order_items', 'order_import_changes',
  'settlement_records', 'tiktok_bill_records', 'tiktok_bill_import_changes',
  'promotion_import_batches', 'promotion_expenses', 'import_archives',
  'product_feedbacks', 'general_feedbacks', 'audit_logs'
];
const importWarnings = [];
const foreignKeyRules = [
  ['user_roles', 'user_id', 'profiles', true], ['user_roles', 'assigned_by', 'profiles', false],
  ['user_shop_permissions', 'user_id', 'profiles', true], ['user_shop_permissions', 'shop_id', 'shops', true], ['user_shop_permissions', 'granted_by', 'profiles', false],
  ['shop_warehouses', 'shop_id', 'shops', true], ['shop_warehouses', 'warehouse_id', 'warehouses', true],
  ['warehouse_country_sites', 'warehouse_id', 'warehouses', true],
  ['warehouse_cost_versions', 'warehouse_id', 'warehouses', true], ['warehouse_cost_versions', 'created_by', 'profiles', true],
  ['products', 'created_by', 'profiles', true],
  ['product_cost_versions', 'product_id', 'products', true], ['product_cost_versions', 'warehouse_id', 'warehouses', true], ['product_cost_versions', 'created_by', 'profiles', false],
  ['settlement_exchange_rates', 'created_by', 'profiles', true], ['settlement_exchange_rates', 'updated_by', 'profiles', false],
  ['settlement_exchange_rate_versions', 'rate_id', 'settlement_exchange_rates', true], ['settlement_exchange_rate_versions', 'operated_by', 'profiles', false],
  ['order_import_batches', 'imported_by', 'profiles', true], ['order_import_batches', 'shop_id', 'shops', false],
  ['orders', 'shop_id', 'shops', true], ['orders', 'warehouse_id', 'warehouses', false],
  ['order_items', 'order_id', 'orders', true], ['order_items', 'product_id', 'products', false],
  ['tiktok_bill_records', 'shop_id', 'shops', true], ['tiktok_bill_records', 'import_batch_id', 'order_import_batches', false],
  ['tiktok_bill_import_changes', 'batch_id', 'order_import_batches', true], ['tiktok_bill_import_changes', 'record_id', 'tiktok_bill_records', false],
  ['promotion_import_batches', 'shop_id', 'shops', true], ['promotion_import_batches', 'imported_by', 'profiles', true],
  ['promotion_expenses', 'shop_id', 'shops', true], ['promotion_expenses', 'created_by', 'profiles', true], ['promotion_expenses', 'updated_by', 'profiles', false], ['promotion_expenses', 'import_batch_id', 'promotion_import_batches', false],
  ['import_archives', 'batch_id', 'order_import_batches', true],
  ['order_import_changes', 'batch_id', 'order_import_batches', true], ['order_import_changes', 'order_id', 'orders', false], ['order_import_changes', 'order_item_id', 'order_items', false],
  ['audit_logs', 'actor_id', 'profiles', false]
];

function quoteIdentifier(value) {
  return `"${value.replace(/"/g, '""')}"`;
}

function rowsFor(table) {
  const file = path.join(resolvedDataDir, `${table}.json`);
  if (!fs.existsSync(file)) throw new Error(`Export file missing: ${file}`);
  const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(rows)) throw new Error(`Invalid JSON array: ${file}`);
  return rows;
}

function preflightExport() {
  for (const table of tables) {
    const actual = rowsFor(table).length;
    const expected = manifest.tables?.[table]?.rows;
    if (actual !== expected) throw new Error(`Export validation failed for ${table}: manifest=${expected}, file=${actual}`);
  }
  const billRows = rowsFor('tiktok_bill_records');
  const ids = new Set(billRows.map(row => row.id));
  const baseRows = billRows.map(({ replaces_record_id, replaced_by_id, ...row }) => row);
  const leakedLinkFields = baseRows.filter(row => 'replaces_record_id' in row || 'replaced_by_id' in row).length;
  if (leakedLinkFields) throw new Error('Bill import preflight failed: self-referencing fields remain in the initial payload.');
  const missingLinks = billRows.reduce((total, row) => total
    + Number(Boolean(row.replaces_record_id && !ids.has(row.replaces_record_id)))
    + Number(Boolean(row.replaced_by_id && !ids.has(row.replaced_by_id))), 0);
  const missingRequired = [];
  const missingOptional = [];
  for (const [source, column, target, required] of foreignKeyRules) {
    const targetIds = new Set(rowsFor(target).map(row => String(row.id)));
    const missing = rowsFor(source).filter(row => row[column] != null && !targetIds.has(String(row[column])));
    if (!missing.length) continue;
    const issue = { source, column, target, count: missing.length };
    (required ? missingRequired : missingOptional).push(issue);
  }
  if (missingRequired.length) throw new Error(`Export validation failed: mandatory foreign keys are missing: ${JSON.stringify(missingRequired)}`);
  return { tables: tables.length, billRows: billRows.length, missingLinks, optionalReferenceIssues: missingOptional };
}

function writeWarningReport() {
  const warningPath = path.join(resolvedDataDir, 'local-import-warnings.json');
  if (!importWarnings.length) {
    // A previous failed attempt may have left an obsolete warning report.
    if (fs.existsSync(warningPath)) fs.unlinkSync(warningPath);
    return;
  }
  fs.writeFileSync(warningPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    warning: 'Nullable references absent from the exported dataset were left empty to preserve local foreign-key integrity.',
    skippedReferenceCount: importWarnings.length,
    references: importWarnings
  }, null, 2), 'utf8');
}

function normalizeRowsForImport(table, rows) {
  if (table !== 'tiktok_bill_import_changes') return rows;
  const billIds = new Set(rowsFor('tiktok_bill_records').map(row => row.id));
  return rows.map(row => {
    if (!row.record_id || billIds.has(row.record_id)) return row;
    importWarnings.push({ table, recordId: row.id, field: 'record_id', missingRecordId: row.record_id });
    return { ...row, record_id: null };
  });
}

function runPsql() {
  const child = spawn(psql, ['-h', 'localhost', '-p', '5432', '-U', user, '-d', database, '-v', 'ON_ERROR_STOP=1', '-q', '-f', '-'], {
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let errors = '';
  let output = '';
  // A large import writes many batches. psql closing its input is surfaced
  // through this stream, so avoid Node's default 10-listener warning.
  child.stdin.setMaxListeners(0);
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { errors += chunk.toString(); });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(output) : reject(new Error(errors.trim() || `psql exited with code ${code}`)));
  });
  return { child, done };
}

function write(child, sql) {
  return new Promise((resolve, reject) => {
    if (child.stdin.write(sql, 'utf8')) return resolve();
    child.stdin.once('drain', resolve);
    child.stdin.once('error', reject);
  });
}

function payloadSql(table, rows) {
  const payload = Buffer.from(JSON.stringify(rows), 'utf8').toString('base64');
  const identifier = quoteIdentifier(table);
  // Some historical tables use GENERATED ALWAYS identity keys. Preserve the
  // exported identifiers so all foreign-key references remain intact.
  return `insert into public.${identifier} overriding system value select * from jsonb_populate_recordset(null::public.${identifier}, convert_from(decode('${payload}', 'base64'), 'UTF8')::jsonb) on conflict do nothing;\n`;
}

async function seedLocalAuthUsers(profiles) {
  if (!profiles.length) return;
  const { child, done } = runPsql();
  await write(child, 'begin;\n');
  for (let offset = 0; offset < profiles.length; offset += 500) {
    const payload = Buffer.from(JSON.stringify(profiles.slice(offset, offset + 500)), 'utf8').toString('base64');
    await write(child, `insert into auth.users (id, email, raw_user_meta_data) select id, concat('migrated-', id::text, '@local.invalid'), '{"migrated_from_supabase":true}'::jsonb from jsonb_to_recordset(convert_from(decode('${payload}', 'base64'), 'UTF8')::jsonb) as source(id uuid) on conflict (id) do nothing;\n`);
  }
  await write(child, 'commit;\n');
  child.stdin.end();
  await done;
}

async function clearLocalMigrationData() {
  // Deliberately explicit: this removes only rows in the local target database
 // before a first full migration. It never connects to a remote service.
  const { child, done } = runPsql();
  const sql = `
begin;
truncate table
  public.audit_logs,
  public.general_feedbacks,
  public.product_feedbacks,
  public.import_archives,
  public.promotion_expenses,
  public.promotion_import_batches,
  public.tiktok_bill_import_changes,
  public.tiktok_bill_records,
  public.settlement_records,
  public.order_import_changes,
  public.order_items,
  public.orders,
  public.order_import_batches,
  public.settlement_exchange_rate_versions,
  public.settlement_exchange_rates,
  public.product_cost_versions,
  public.products,
  public.warehouse_cost_versions,
  public.warehouse_country_sites,
  public.country_sites,
  public.shop_warehouses,
  public.user_shop_permissions,
  public.shops,
  public.warehouses,
  public.user_roles,
  public.profiles
restart identity cascade;
truncate table auth.users restart identity cascade;
commit;
`;
  await write(child, sql);
  child.stdin.end();
  await done;
}

async function importTable(table) {
  const rows = rowsFor(table);
  if (!rows.length) return { table, expected: 0 };
  // tiktok_bill_records has two self-referencing foreign keys. Insert each
  // record with those links empty first, then restore them after every record
  // exists locally.
  const normalizedRows = normalizeRowsForImport(table, rows);
  const importRows = table === 'tiktok_bill_records'
    ? normalizedRows.map(({ replaces_record_id, replaced_by_id, ...row }) => row)
    : normalizedRows;
  const { child, done } = runPsql();
  await write(child, 'begin;\n');
  for (let offset = 0; offset < importRows.length; offset += 500) {
    await write(child, payloadSql(table, importRows.slice(offset, offset + 500)));
  }
  await write(child, 'commit;\n');
  child.stdin.end();
  await done;
  if (table === 'tiktok_bill_records') await restoreBillReplacementLinks(rows);
  return { table, expected: rows.length };
}

async function restoreBillReplacementLinks(rows) {
  const availableIds = new Set(rows.map(row => row.id));
  const warnings = [];
  const links = rows.map(row => {
    const replaces = row.replaces_record_id && availableIds.has(row.replaces_record_id) ? row.replaces_record_id : null;
    const replacedBy = row.replaced_by_id && availableIds.has(row.replaced_by_id) ? row.replaced_by_id : null;
    if (row.replaces_record_id && !replaces) warnings.push({ table: 'tiktok_bill_records', recordId: row.id, field: 'replaces_record_id', missingRecordId: row.replaces_record_id });
    if (row.replaced_by_id && !replacedBy) warnings.push({ table: 'tiktok_bill_records', recordId: row.id, field: 'replaced_by_id', missingRecordId: row.replaced_by_id });
    return { id: row.id, replaces_record_id: replaces, replaced_by_id: replacedBy };
  }).filter(link => link.replaces_record_id || link.replaced_by_id);
  if (warnings.length) {
    importWarnings.push(...warnings);
    writeWarningReport();
    console.log(`  Bill link preflight: restored ${links.length} valid links; skipped ${warnings.length} references absent from the export (details: local-import-warnings.json).`);
  }
  if (!links.length) return;
  const { child, done } = runPsql();
  await write(child, 'begin;\n');
  for (let offset = 0; offset < links.length; offset += 500) {
    const payload = Buffer.from(JSON.stringify(links.slice(offset, offset + 500)), 'utf8').toString('base64');
    await write(child, `update public.tiktok_bill_records as target set replaces_record_id = source.replaces_record_id, replaced_by_id = source.replaced_by_id from jsonb_to_recordset(convert_from(decode('${payload}', 'base64'), 'UTF8')::jsonb) as source(id uuid, replaces_record_id uuid, replaced_by_id uuid) where target.id = source.id;\n`);
  }
  await write(child, 'commit;\n');
  child.stdin.end();
  await done;
}

function verificationSql() {
  return tables.map(table => `select '${table}' as table_name, count(*) as rows from public.${quoteIdentifier(table)}`).join('\nunion all\n') + ';\n';
}

async function verify() {
  const { child, done } = runPsql();
  await write(child, '\\pset format unaligned\n\\pset tuples_only on\n');
  await write(child, verificationSql());
  child.stdin.end();
  return done;
}

async function verifyImportedCounts() {
  const verification = await verify();
  process.stdout.write(verification);
  const actualCounts = new Map(verification.trim().split(/\r?\n/).filter(Boolean).map(line => {
    const [table, count] = line.split('|');
    return [table, Number(count)];
  }));
  const mismatches = tables.filter(table => actualCounts.get(table) !== manifest.tables?.[table]?.rows);
  if (mismatches.length) throw new Error(`Verification failed for: ${mismatches.join(', ')}. Review the output above before retrying.`);
}

(async () => {
  console.log(`Import target: ${database} on localhost`);
  console.log(`Import source: ${resolvedDataDir}`);
  const preflight = preflightExport();
  console.log(`Export preflight passed: ${preflight.tables} tables verified; ${preflight.billRows} bill records; ${preflight.missingLinks} absent historical bill links and ${preflight.optionalReferenceIssues.reduce((total, issue) => total + issue.count, 0)} nullable external references will be recorded as warnings and left empty.`);
  if (verifyOnly) {
    console.log('Verification-only mode: no local rows will be inserted, updated, or deleted.');
    console.log('\nVerification counts (compare with manifest):');
    await verifyImportedCounts();
    console.log('\nLocal business data verification completed.');
    return;
  }
  if (!resetLocalData) {
    throw new Error('Refusing to merge into an existing local database. Re-run with --reset-local-data after confirming the local data can be cleared.');
  }
  console.log('Clearing local-only migration data and default seed rows...');
  await clearLocalMigrationData();
  console.log('Seeding local placeholder identities for existing profiles...');
  await seedLocalAuthUsers(rowsFor('profiles'));
  for (const table of tables) {
    const expected = manifest.tables?.[table]?.rows;
    process.stdout.write(`Importing ${table} (${expected ?? '?'} rows)... `);
    const result = await importTable(table);
    console.log(result.expected === 0 ? 'skipped (empty)' : 'done');
  }
  writeWarningReport();
  console.log('\nVerification counts (compare with manifest):');
  await verifyImportedCounts();
console.log('\nLocal business data import completed. Source data was not changed.');
})().catch(error => {
  console.error(`Local import failed: ${error.message}`);
  process.exitCode = 1;
});
