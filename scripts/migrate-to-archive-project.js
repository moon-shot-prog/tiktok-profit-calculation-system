const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

function loadEnv(file) {
  if (!fs.existsSync(file)) throw new Error(`缺少 ${path.basename(file)}`);
  return Object.fromEntries(fs.readFileSync(file, 'utf8').split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#')).map(line => {
    const index = line.indexOf('=');
    return [line.slice(0, index), line.slice(index + 1).replace(/^['"]|['"]$/g, '')];
  }));
}

const sourceEnv = loadEnv(path.join(__dirname, '..', '.env'));
const targetEnv = loadEnv(path.join(__dirname, '..', '.env.archive-target'));
const source = createClient(sourceEnv.SUPABASE_URL, sourceEnv.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const target = createClient(targetEnv.TARGET_SUPABASE_URL, targetEnv.TARGET_SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const dryRun = process.argv.includes('--dry-run');
const pageSize = 500;
const chunkSize = 200;
const selectedTablesArg = process.argv.find(value => value.startsWith('--tables='));
const selectedTables = selectedTablesArg ? new Set(selectedTablesArg.slice('--tables='.length).split(',').map(value => value.trim()).filter(Boolean)) : null;
const pageOrderColumn = { country_sites: 'code', shop_warehouses: 'shop_id', warehouse_country_sites: 'warehouse_id', user_roles: 'user_id', user_shop_permissions: 'user_id' };

const tableSpecs = [
  { table: 'warehouses', conflict: 'id' },
  { table: 'country_sites', conflict: 'code' },
  { table: 'shops', conflict: 'id' },
  { table: 'shop_warehouses', conflict: 'shop_id,warehouse_id' },
  { table: 'warehouse_country_sites', conflict: 'warehouse_id,country_code' },
  { table: 'user_shop_permissions', conflict: 'user_id,shop_id', users: ['user_id', 'granted_by'] },
  { table: 'products', conflict: 'id', users: ['created_by', 'reviewed_by'] },
  { table: 'product_cost_versions', conflict: 'id', users: ['created_by'] },
  { table: 'warehouse_cost_versions', conflict: 'id', users: ['created_by'] },
  { table: 'settlement_exchange_rates', conflict: 'id', users: ['created_by', 'updated_by'] },
  { table: 'promotion_import_batches', conflict: 'id', users: ['imported_by'] },
  { table: 'promotion_expenses', conflict: 'id', users: ['created_by', 'updated_by'] },
  { table: 'order_import_batches', conflict: 'id', users: ['imported_by'] },
  { table: 'orders', conflict: 'id', stripRaw: true },
  { table: 'order_items', conflict: 'id', stripRaw: true },
  { table: 'tiktok_bill_records', conflict: 'id', stripRaw: true },
  // These are the reversible before/after snapshots for a bill import.  They
  // must move with their batches so the target keeps the promised 30-day
  // rollback window after a database migration.
  { table: 'tiktok_bill_import_changes', conflict: 'id' }
];

const chunk = (items, size = chunkSize) => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, index * size + size));

async function loadRows(client, table) {
  const rows = [];
  for (let start = 0; ; start += pageSize) {
    const { data, error } = await client.from(table).select('*').order(pageOrderColumn[table] || 'id', { ascending: true }).range(start, start + pageSize - 1);
    if (error) throw new Error(`读取 ${table} 失败：${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < pageSize) return rows;
  }
}

async function loadUsers(client) {
  const users = [];
  for (let page = 1; ; page += 1) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`读取认证用户失败：${error.message}`);
    users.push(...(data.users || []));
    if (!data.users || data.users.length < 200) return users;
  }
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function randomPassword() { return crypto.randomBytes(32).toString('base64url'); }

async function buildUserMap(sourceUsers) {
  const targetUsers = await loadUsers(target);
  const existing = new Map(targetUsers.map(user => [user.app_metadata?.source_user_id, user]).filter(([id]) => id));
  const map = new Map();
  for (const user of sourceUsers) {
    if (!user.email) throw new Error(`用户 ${user.id} 没有邮箱，无法安全迁移认证账号`);
    let targetUser = existing.get(user.id);
    if (!targetUser && !dryRun) {
      const { data, error } = await target.auth.admin.createUser({
        email: user.email,
        password: randomPassword(),
        email_confirm: true,
        app_metadata: { source_user_id: user.id },
        user_metadata: { display_name: user.user_metadata?.display_name || '' }
      });
      if (error || !data.user) throw new Error(`创建用户 ${user.email} 失败：${error?.message || '未知错误'}`);
      targetUser = data.user;
    }
    map.set(user.id, targetUser?.id || `dry-run:${user.id}`);
  }
  return map;
}

function transformRow(row, spec, userMap) {
  const value = clone(row);
  for (const field of spec.users || []) if (value[field]) value[field] = userMap.get(value[field]) || null;
  if (spec.stripRaw) value.raw_data = spec.table === 'tiktok_bill_records' ? {} : null;
  // Rollback snapshots need the accounting state, not a second copy of the
  // original imported payload.  Keeping this data out of before/after JSON
  // preserves the 30-day rollback while avoiding raw-data duplication.
  if (spec.table === 'tiktok_bill_import_changes') {
    if (value.before_data && typeof value.before_data === 'object') delete value.before_data.raw_data;
    if (value.after_data && typeof value.after_data === 'object') delete value.after_data.raw_data;
  }
  if (spec.table === 'tiktok_bill_records') {
    value.replaced_by_id = null;
    value.replaces_record_id = null;
  }
  return value;
}

async function upsertRows(table, rows, conflict) {
  for (const part of chunk(rows)) {
    const { error } = await target.from(table).upsert(part, { onConflict: conflict });
    if (error) throw new Error(`写入 ${table} 失败：${error.message}`);
  }
}

async function verifyCount(table, expected) {
  const { count, error } = await target.from(table).select('*', { count: 'exact', head: true });
  if (error || count !== expected) throw new Error(`校验 ${table} 失败：源 ${expected}，目标 ${count || 0}`);
}

async function migrateProfiles(sourceUsers, userMap) {
  const profiles = await loadRows(source, 'profiles');
  const rows = profiles.map(profile => ({ ...profile, id: userMap.get(profile.id) }));
  if (!dryRun) await upsertRows('profiles', rows, 'id');
  return rows.length;
}

async function migrateRoles(userMap) {
  const roles = await loadRows(source, 'user_roles');
  const rows = roles.map(role => ({ ...role, user_id: userMap.get(role.user_id), assigned_by: role.assigned_by ? userMap.get(role.assigned_by) || null : null }));
  if (!dryRun) await upsertRows('user_roles', rows, 'user_id,role');
  return rows.length;
}

async function main() {
  console.log(JSON.stringify({ phase: 'read-source-users' }));
  const sourceUsers = await loadUsers(source);
  const sourceProfiles = await loadRows(source, 'profiles');
  if (sourceUsers.length !== sourceProfiles.length) throw new Error(`认证用户与资料数量不一致：认证 ${sourceUsers.length}，资料 ${sourceProfiles.length}`);
  console.log(JSON.stringify({ phase: 'build-user-map', users: sourceUsers.length }));
  const userMap = await buildUserMap(sourceUsers);
  const summary = { mode: dryRun ? 'dry-run' : 'write', users: sourceUsers.length, tables: {} };
  summary.tables.profiles = await migrateProfiles(sourceUsers, userMap);
  summary.tables.user_roles = await migrateRoles(userMap);
  for (const spec of tableSpecs.filter(item => !selectedTables || selectedTables.has(item.table))) {
    console.log(JSON.stringify({ phase: 'read-table', table: spec.table }));
    const sourceRows = await loadRows(source, spec.table);
    const rows = sourceRows.map(row => transformRow(row, spec, userMap));
    summary.tables[spec.table] = rows.length;
    if (!dryRun) {
      await upsertRows(spec.table, rows, spec.conflict);
      if (spec.table === 'tiktok_bill_records') {
        // Self-referencing replacement links can only be restored after every
        // bill exists in the target database.
        const rowsWithLinks = sourceRows.map(row => {
          const value = transformRow(row, { ...spec, stripRaw: true }, userMap);
          value.replaced_by_id = row.replaced_by_id;
          value.replaces_record_id = row.replaces_record_id;
          return value;
        });
        await upsertRows(spec.table, rowsWithLinks, spec.conflict);
      }
      await verifyCount(spec.table, rows.length);
    }
  }
  if (!dryRun) {
    await verifyCount('profiles', summary.tables.profiles);
    await verifyCount('user_roles', summary.tables.user_roles);
  }
  console.log(JSON.stringify(summary));
}

main().catch(error => { console.error(error.message || error); process.exitCode = 1; });
