#!/usr/bin/env node
/**
 * Pull the QuickBooks Online Profit & Loss report via the Intuit API — the
 * API-direct replacement for the manually-exported "Loss.xlsx" P&L (which goes
 * stale and caused the Unit-Econ / margin / EBITDA reconciliation gap).
 *
 * OAuth 2.0: a stored refresh token (from the one-time OAuth Playground consent)
 * is exchanged for a 1-hour access token on each run. Intuit ROTATES the refresh
 * token on every refresh, so we persist the new one back to .env.local — that
 * keeps the nightly cron self-sustaining (a refresh token only expires after
 * ~100 days idle). No-ops cleanly if creds aren't filled yet.
 *
 * Env (.env.local): QBO_CLIENT_ID, QBO_CLIENT_SECRET, QBO_REALM_ID,
 * QBO_REFRESH_TOKEN, QBO_ENVIRONMENT (production|sandbox).
 *
 * Output: _etl_scripts/cache/quickbooks_pnl.json  (normalized P&L by month).
 * Consumed by build_pnl.mjs (prefers this cache over Loss.xlsx when present).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env.local');
const OUT = path.join(ROOT, '_etl_scripts/cache/quickbooks_pnl.json');
fs.mkdirSync(path.dirname(OUT), { recursive: true });

function loadEnv() {
  const env = { ...process.env };
  if (fs.existsSync(ENV_PATH)) for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && env[m[1]] == null) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return env;
}
const ENV = loadEnv();

// No-op guard: skip cleanly (exit 0) until the OAuth creds are filled, so this
// step is safe to wire into refresh_all before setup is complete.
const REQUIRED = ['QBO_CLIENT_ID', 'QBO_CLIENT_SECRET', 'QBO_REALM_ID', 'QBO_REFRESH_TOKEN'];
const missing = REQUIRED.filter((k) => !ENV[k] || !String(ENV[k]).trim());
if (missing.length) {
  console.error(`[quickbooks] skipped — not configured (missing: ${missing.join(', ')}). Fill .env.local to enable.`);
  process.exit(0);
}

const isSandbox = String(ENV.QBO_ENVIRONMENT || 'production').toLowerCase() === 'sandbox';
const API_BASE = isSandbox ? 'https://sandbox-quickbooks.api.intuit.com' : 'https://quickbooks.api.intuit.com';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const MINOR_VERSION = '73';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- 1) Refresh the access token; persist the rotated refresh token ----------
async function refreshAccessToken() {
  const basic = Buffer.from(`${ENV.QBO_CLIENT_ID}:${ENV.QBO_CLIENT_SECRET}`).toString('base64');
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: ENV.QBO_REFRESH_TOKEN });
  for (let a = 0; a < 4; a++) {
    let res;
    try {
      res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body,
      });
    } catch { await sleep(600 * (a + 1)); continue; }
    if (res.status === 429 || res.status >= 500) { await sleep(600 * (a + 1)); continue; }
    const j = await res.json();
    if (res.status !== 200) throw new Error(`QBO token refresh ${res.status}: ${JSON.stringify(j).slice(0, 200)} (refresh token may be expired — re-run the OAuth Playground consent)`);
    return j; // { access_token, refresh_token, expires_in, x_refresh_token_expires_in }
  }
  throw new Error('QBO token refresh: retries exhausted');
}

// Persist the rotated refresh token back into .env.local so the next run works.
function persistRefreshToken(newToken) {
  if (!newToken || newToken === ENV.QBO_REFRESH_TOKEN) return;
  try {
    let txt = fs.readFileSync(ENV_PATH, 'utf8');
    if (/^QBO_REFRESH_TOKEN=.*$/m.test(txt)) txt = txt.replace(/^QBO_REFRESH_TOKEN=.*$/m, `QBO_REFRESH_TOKEN=${newToken}`);
    else txt += `\nQBO_REFRESH_TOKEN=${newToken}\n`;
    fs.writeFileSync(ENV_PATH, txt);
    console.error('[quickbooks] rotated refresh token persisted to .env.local');
  } catch (e) { console.error(`[quickbooks] WARNING: could not persist rotated refresh token: ${e.message}`); }
}

// --- 2) Pull the Profit & Loss report, summarized by month -------------------
async function fetchPnL(accessToken, startDate, endDate) {
  const qs = new URLSearchParams({ start_date: startDate, end_date: endDate, summarize_column_by: 'Month', minorversion: MINOR_VERSION });
  const url = `${API_BASE}/v3/company/${ENV.QBO_REALM_ID}/reports/ProfitAndLoss?${qs}`;
  for (let a = 0; a < 4; a++) {
    let res;
    try { res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } }); }
    catch { await sleep(600 * (a + 1)); continue; }
    if (res.status === 429 || res.status >= 500) { await sleep(600 * (a + 1)); continue; }
    const j = await res.json();
    if (res.status !== 200) throw new Error(`QBO P&L ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
    return j;
  }
  throw new Error('QBO P&L: retries exhausted');
}

// Flatten the nested report into accounts: [{ name, section, by_month }].
// QBO report rows are either a leaf (ColData: [accountName, ...monthly $]) or a
// section (Header + nested Rows + Summary). Column 0 is the account label; the
// remaining columns map to the month headers (Columns.Column[].MetaData StartDate).
function parseReport(report) {
  const cols = report?.Columns?.Column || [];
  // Month keys come from each column's MetaData StartDate (skip the first label col).
  const months = cols.map((c) => {
    const sd = (c.MetaData || []).find((m) => m.Name === 'StartDate')?.Value;
    return sd ? sd.slice(0, 7) : null;
  });
  const accounts = [];
  const walk = (rows, section) => {
    for (const row of rows || []) {
      const sec = row.group || section || null;
      if (row.Rows?.Row) {
        const hdrLabel = row.Header?.ColData?.[0]?.value || null;
        walk(row.Rows.Row, hdrLabel || sec);
        // capture the section Summary as its own total line
        if (row.Summary?.ColData) pushLine(row.Summary.ColData, sec, true);
      } else if (row.ColData) {
        pushLine(row.ColData, sec, row.type === 'Summary');
      }
    }
  };
  const pushLine = (colData, section, isTotal) => {
    const name = colData[0]?.value;
    if (!name) return;
    const by_month = {};
    for (let i = 1; i < colData.length; i++) {
      const m = months[i];
      if (!m) continue;
      const raw = colData[i]?.value;
      const num = raw === '' || raw == null ? 0 : Number(String(raw).replace(/[$,()]/g, (x) => (x === '(' ? '-' : '')));
      by_month[m] = Number.isFinite(num) ? num : 0;
    }
    accounts.push({ name, section: section || null, is_total: !!isTotal, by_month });
  };
  walk(report?.Rows?.Row, null);
  return { months: months.filter(Boolean), accounts };
}

// --- run ---------------------------------------------------------------------
const t0 = Date.now();
const tok = await refreshAccessToken();
persistRefreshToken(tok.refresh_token);
// Pull a wide window (full history) so any TTM/trailing view is fully backed.
const today = new Date().toISOString().slice(0, 10);
const start = `${new Date().getFullYear() - 3}-01-01`;
const report = await fetchPnL(tok.access_token, start, today);
const parsed = parseReport(report);

fs.writeFileSync(OUT, JSON.stringify({
  source: 'quickbooks_online:reports/ProfitAndLoss',
  fetchedAt: new Date().toISOString(),
  environment: isSandbox ? 'sandbox' : 'production',
  realm_id: ENV.QBO_REALM_ID,
  window: { start, end: today },
  currency: report?.Header?.Currency || null,
  months: parsed.months,
  accounts: parsed.accounts,
}, null, 2));
console.error(`✓ quickbooks_pnl.json: ${parsed.accounts.length} P&L lines · ${parsed.months.length} months (${parsed.months[0]}…${parsed.months[parsed.months.length - 1]}) · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
