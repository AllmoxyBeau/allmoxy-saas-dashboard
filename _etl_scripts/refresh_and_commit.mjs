#!/usr/bin/env node
/**
 * One-command refresh: pulls HubSpot, rebuilds all snapshots, commits, pushes.
 * Vercel auto-deploys ~90 seconds after the push.
 *
 * Usage:
 *   npm run refresh                    # full sequence (sync + build + commit + push)
 *   npm run refresh -- --no-push       # rebuild + commit but don't push (preview locally)
 *   npm run refresh -- --no-hubspot    # skip live HubSpot sync (faster, uses cached data)
 *   npm run refresh -- --no-commit     # rebuild only, no git activity
 *
 * Loads HUBSPOT_TOKEN automatically from .env.local — no need to set it manually.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const args = new Set(process.argv.slice(2));
const NO_PUSH = args.has('--no-push');
const NO_HUBSPOT = args.has('--no-hubspot');
const NO_COMMIT = args.has('--no-commit');

// ---- Auto-load .env.local ----
// Vite picks up .env.local automatically for the browser, but Node scripts
// don't. We parse it here so HUBSPOT_TOKEN flows through without the user
// having to `source .env.local` first.
const envPath = path.join(ROOT, '.env.local');
if (fs.existsSync(envPath)) {
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z_0-9]*)=(.*)$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
}

function step(num, total, title) {
  console.log(`\n[${num}/${total}] ${title}`);
}

function run(cmd) {
  console.log(`  → ${cmd}`);
  execSync(cmd, { cwd: ROOT, stdio: 'inherit' });
}

console.log('═════════════════════════════════════════════════════════');
console.log('  Allmoxy Dashboard — refresh & deploy');
console.log('═════════════════════════════════════════════════════════');
console.log(`  Repo:    ${ROOT}`);
console.log(`  HubSpot: ${process.env.HUBSPOT_TOKEN ? 'token loaded' : 'no token (will skip live sync)'}`);
const flags = [
  NO_HUBSPOT ? 'no-hubspot' : null,
  NO_COMMIT ? 'no-commit' : null,
  NO_PUSH ? 'no-push' : null,
].filter(Boolean);
if (flags.length > 0) console.log(`  Flags:   ${flags.join(', ')}`);

const totalSteps = NO_COMMIT ? 4 : (NO_PUSH ? 5 : 6);
let s = 0;

// ============================================================================
// 1. Sync HubSpot live data (optional)
// ============================================================================
s++;
if (NO_HUBSPOT) {
  step(s, totalSteps, 'HubSpot sync — SKIPPED (--no-hubspot flag)');
} else if (!process.env.HUBSPOT_TOKEN) {
  step(s, totalSteps, 'HubSpot sync — SKIPPED (HUBSPOT_TOKEN not in .env.local)');
} else {
  step(s, totalSteps, 'Syncing HubSpot Companies + Owners (~3 min)');
  run('node _etl_scripts/sync_hubspot.mjs');
}

// ============================================================================
// 2. Run the main ETL pipeline (xlsx → JSON snapshots)
// ============================================================================
s++;
step(s, totalSteps, 'Running ETL pipeline (refresh_all.mjs — all snapshots)');
run('node _etl_scripts/refresh_all.mjs');

// ============================================================================
// 3. Apply per-customer overrides (not included in refresh_all yet)
// ============================================================================
s++;
step(s, totalSteps, 'Applying customer overrides + rebuilding affected snapshots');
run('node _etl_scripts/apply_customer_overrides.mjs');
run('node _etl_scripts/build_orders_verified.mjs');
run('node _etl_scripts/build_churn_risk_matrix.mjs');
run('node _etl_scripts/build_time_to_value.mjs');

// ============================================================================
// 4. Run invariant tests (informational — non-fatal)
// ============================================================================
s++;
step(s, totalSteps, 'Running invariant tests (data quality check)');
try {
  run('node _etl_scripts/run_invariant_tests.mjs');
} catch {
  console.log('  (some invariants flagged — check public/snapshots/invariant_test_results.json)');
}

if (NO_COMMIT) {
  console.log('\n--no-commit flag set — stopping before git activity.');
  console.log('Your snapshots are updated locally. Inspect with `git status`.');
  process.exit(0);
}

// ============================================================================
// 5. Stage + commit
// ============================================================================
s++;
step(s, totalSteps, 'Staging changes + committing');
const status = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8' });
if (!status.trim()) {
  console.log('  ✓ No changes detected — snapshots unchanged. Done.');
  process.exit(0);
}
// Show what's about to be committed (concise summary)
console.log('  Changes:');
console.log(status.split('\n').slice(0, 10).map((l) => '    ' + l).join('\n'));
const lineCount = status.trim().split('\n').length;
if (lineCount > 10) console.log(`    ... +${lineCount - 10} more`);

// Stage only the safe paths — never commit env files, cache, or root-level changes
execSync('git add public/snapshots/ _etl_scripts/customer_overrides.json _etl_scripts/customer_status_overrides.json _etl_scripts/bid_only_customers.json _etl_scripts/churn_subpattern_overrides.json _etl_scripts/stripe_id_overrides.json _etl_scripts/metric_definitions.json src/data/annual_payer_ids.json src/data/segment_framework.json src/data/cim_narrative.json 2>/dev/null || true', { cwd: ROOT, shell: true });

const stagedStatus = execSync('git diff --cached --stat | tail -1', { cwd: ROOT, encoding: 'utf8', shell: true });
if (!stagedStatus.trim()) {
  console.log('  ✓ Nothing staged (changes were in untracked or excluded paths). Done.');
  process.exit(0);
}

const ts = new Date().toISOString().replace(/\..*$/, '').replace('T', ' ');
const msg = `Refresh: ${ts} UTC`;
execSync(`git commit -m ${JSON.stringify(msg)}`, { cwd: ROOT, stdio: 'inherit' });

// ============================================================================
// 6. Push (Vercel auto-deploys)
// ============================================================================
if (NO_PUSH) {
  console.log('\n--no-push flag set — commit made but not pushed.');
  console.log('Run `git push` manually when ready to deploy.');
  process.exit(0);
}

s++;
step(s, totalSteps, 'Pushing to GitHub (Vercel auto-deploys ~90s after push)');
run('git push origin main');

console.log('\n═════════════════════════════════════════════════════════');
console.log('  ✓ Done. Vercel will redeploy in ~90 seconds.');
console.log('═════════════════════════════════════════════════════════');
