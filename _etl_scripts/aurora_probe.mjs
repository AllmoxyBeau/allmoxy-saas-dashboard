#!/usr/bin/env node
/**
 * Connectivity + schema-discovery probe for the Aurora MySQL cluster.
 * Reads AURORA_* from .env.local, connects (TLS), and reports:
 *   - SELECT 1 (auth works)
 *   - SHOW DATABASES (if no AURORA_DATABASE set) OR table list + row hints
 *     for the orders/verified-orders tables (if AURORA_DATABASE set).
 * Read-only; runs nothing destructive. Throwaway diagnostic before sync_aurora.mjs.
 *
 *   node _etl_scripts/aurora_probe.mjs            # list databases (no db set)
 *   node _etl_scripts/aurora_probe.mjs orders     # also grep table names for "order"
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ENV = { ...process.env };
for (const line of fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m && ENV[m[1]] == null) ENV[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}

const grep = (process.argv[2] || 'order').toLowerCase();
if (!ENV.AURORA_USER || !ENV.AURORA_PASSWORD) {
  console.error('✗ AURORA_USER / AURORA_PASSWORD not set in .env.local — fill them first.');
  process.exit(1);
}

const conn = await mysql.createConnection({
  host: ENV.AURORA_HOST,
  port: Number(ENV.AURORA_PORT || 3306),
  user: ENV.AURORA_USER,
  password: ENV.AURORA_PASSWORD,
  database: ENV.AURORA_DATABASE || undefined,
  ssl: { rejectUnauthorized: false }, // RDS TLS; relax cert check for the probe
  connectTimeout: 10000,
});
console.error('✓ connected to', ENV.AURORA_HOST);

const [[ping]] = await conn.query('SELECT 1 AS ok, VERSION() AS version, DATABASE() AS db, CURRENT_USER() AS user');
console.error(`✓ SELECT 1 -> ok=${ping.ok} · MySQL ${ping.version} · db=${ping.db || '(none selected)'} · user=${ping.user}`);

if (!ENV.AURORA_DATABASE) {
  const [dbs] = await conn.query('SHOW DATABASES');
  console.error('\nDatabases on the cluster:');
  for (const r of dbs) console.error('  - ' + Object.values(r)[0]);
  console.error('\nSet AURORA_DATABASE=<one of these> in .env.local, then re-run to see tables.');
} else {
  const [tables] = await conn.query('SHOW TABLES');
  const names = tables.map((t) => Object.values(t)[0]);
  console.error(`\n${names.length} tables in ${ENV.AURORA_DATABASE}.`);
  const hits = names.filter((n) => n.toLowerCase().includes(grep));
  console.error(`\nTables matching "${grep}" (${hits.length}):`);
  for (const n of hits) {
    const [[c]] = await conn.query(`SELECT COUNT(*) AS n FROM \`${n}\``);
    console.error(`  - ${n} (${c.n.toLocaleString()} rows)`);
  }
  if (!hits.length) {
    console.error('  (none — showing first 40 table names instead)');
    for (const n of names.slice(0, 40)) console.error('  · ' + n);
  }
}
await conn.end();
