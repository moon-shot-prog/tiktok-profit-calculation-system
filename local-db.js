const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const localEnvPath = path.join(__dirname, '.env.local');
if (typeof process.loadEnvFile === 'function' && fs.existsSync(localEnvPath)) process.loadEnvFile(localEnvPath);

let pool = null;

function localDatabaseEnabled() {
  return Boolean(process.env.DATABASE_URL);
}

function getLocalPool() {
  if (!localDatabaseEnabled()) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 12,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      application_name: 'tiktok-profit-local'
    });
    pool.on('error', error => console.error(`Local PostgreSQL pool error: ${error.message}`));
  }
  return pool;
}

async function localQuery(text, values) {
  const currentPool = getLocalPool();
  if (!currentPool) throw new Error('Local PostgreSQL is not configured. Set DATABASE_URL in .env.local.');
  return currentPool.query(text, values);
}

async function withLocalTransaction(work) {
  const currentPool = getLocalPool();
  if (!currentPool) throw new Error('Local PostgreSQL is not configured. Set DATABASE_URL in .env.local.');
  const client = await currentPool.connect();
  try {
    await client.query('begin');
    const result = await work({
      query: (text, values) => client.query(text, values)
    });
    await client.query('commit');
    return result;
  } catch (error) {
    try { await client.query('rollback'); } catch (_) { /* retain the original error */ }
    throw error;
  } finally {
    client.release();
  }
}

async function localDatabaseHealth() {
  const result = await localQuery('select current_database() as database, count(*)::int as orders from public.orders');
  return result.rows[0];
}

module.exports = { localDatabaseEnabled, getLocalPool, localQuery, withLocalTransaction, localDatabaseHealth };
