#!/usr/bin/env node
/**
 * Create the allmoxy_onboarding schema in Aurora MySQL and load the reverse-engineered seed.
 *
 *   node _etl_scripts/load_onboarding_to_aurora.mjs            # schema + seed
 *   node _etl_scripts/load_onboarding_to_aurora.mjs --dry-run  # print what would run
 *
 * Runs _etl_scripts/onboarding/schema.sql (CREATE ... IF NOT EXISTS, safe to repeat) then
 * _etl_scripts/onboarding/seed.sql (upserts; a customer row the instance tab or a person wrote
 * — source <> 'seed' — is never overwritten). Uses the AURORA_* settings in .env.local; the
 * user needs CREATE / INSERT / UPDATE on allmoxy_onboarding.
 *
 * Not part of the daily refresh: run it by hand until the instance tab owns these tables.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DRY = process.argv.includes('--dry-run');

const ENV = { ...process.env };
for (const line of fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m && ENV[m[1]] == null) ENV[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}
const schema = fs.readFileSync(path.join(__dirname, 'onboarding/schema.sql'), 'utf8');
const seed = fs.readFileSync(path.join(__dirname, 'onboarding/seed.sql'), 'utf8');

if (DRY) {
  console.log(`Would run schema.sql (${schema.length.toLocaleString()} chars) and seed.sql (${seed.length.toLocaleString()} chars, ${(seed.match(/^INSERT INTO/gm) || []).length} upserts) on ${ENV.AURORA_HOST}`);
  process.exit(0);
}

const conn = await mysql.createConnection({
  host: ENV.AURORA_HOST, port: Number(ENV.AURORA_PORT || 3306), user: ENV.AURORA_USER, password: ENV.AURORA_PASSWORD,
  ssl: { rejectUnauthorized: false }, connectTimeout: 20000, multipleStatements: true,
});
try {
  await conn.query(schema);
  console.error('[onboarding→aurora] schema ready');
  await conn.beginTransaction();
  await conn.query(seed);
  await conn.commit();
  const [[c]] = await conn.query('SELECT COUNT(*) n, SUM(source = \'seed\') seeded FROM allmoxy_onboarding.ob_customer');
  const [[s]] = await conn.query('SELECT COUNT(*) n FROM allmoxy_onboarding.ob_customer_step');
  console.error(`[onboarding→aurora] ob_customer ${c.n} rows (${c.seeded} seeded) · ob_customer_step ${s.n} rows`);
} catch (e) {
  try { await conn.rollback(); } catch { /* not in a transaction */ }
  console.error(`[onboarding→aurora] failed: ${e.message}`);
  process.exitCode = 1;
} finally {
  await conn.end();
}
