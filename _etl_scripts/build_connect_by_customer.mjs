#!/usr/bin/env node
// Per-customer × per-month Connect (affiliate) fee revenue, merged from the
// 2024, 2025, and 2026 Stripe Connect Revenue sheet markdown exports.

import fs from 'node:fs';

const MONTHS = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };

function normalizeMonth(label) {
  if (!label) return null;
  const s = String(label).trim();
  let m = s.match(/^(\d{4})-(\w{3})$/);            // "2026-Jan"
  if (m) return `${m[1]}-${MONTHS[m[2]]}`;
  m = s.match(/^(\w{3})\s+(\d{4})$/);              // "Jan 2024"
  if (m) return `${m[2]}-${MONTHS[m[1]]}`;
  return null;
}

function unescape(cell) {
  return cell
    .replace(/\\_/g, '_')
    .replace(/\\#/g, '#')
    .replace(/\\!/g, '!')
    .replace(/\\\|/g, '|')
    .replace(/\\&/g, '&')
    .replace(/&#10;/g, '\n')
    .trim();
}
function cellsOf(line) {
  const parts = line.split('|');
  if (parts[0] === '') parts.shift();
  if (parts[parts.length - 1] === '') parts.pop();
  return parts.map(unescape);
}
function toNum(raw) {
  if (!raw) return null;
  if (raw === '#N/A' || raw === '#DIV/0!' || raw === '#REF!') return null;
  const n = Number(String(raw).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Returns a map name → { month → $ } by scanning one Connect sheet markdown file
// for the primary per-customer table.
function parseConnectFile(path, { customerNameCol, skipIdCol = false, monthsStartAtIdx }) {
  const lines = fs.readFileSync(path, 'utf8').split('\n');
  // Locate the header row by finding a row where most cells parse as months.
  let headerLineIdx = -1;
  let monthCols = []; // { colIdx, month }
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l || !l.startsWith('|')) continue;
    if (/^\|\s*:-+/.test(l)) continue;
    const cells = cellsOf(l);
    if (cells.length < 3) continue;
    // Test from monthsStartAtIdx onward
    const candidates = cells.slice(monthsStartAtIdx);
    const parsed = candidates.map((c) => normalizeMonth(c));
    const hits = parsed.filter(Boolean).length;
    if (hits >= 2 && hits / candidates.length > 0.5) {
      headerLineIdx = i;
      parsed.forEach((m, j) => {
        if (m) monthCols.push({ colIdx: j + monthsStartAtIdx, month: m });
      });
      break;
    }
  }
  if (headerLineIdx < 0) throw new Error(`Couldn't find month header in ${path}`);

  const out = new Map();
  // Data rows start after header + separator.
  for (let i = headerLineIdx + 2; i < lines.length; i++) {
    const l = lines[i];
    if (!l || !l.startsWith('|')) break;
    if (/^\|\s*:-+/.test(l)) continue;
    const cells = cellsOf(l);
    if (cells.length < monthsStartAtIdx + 1) continue;
    const name = cells[customerNameCol];
    if (!name || /^NO_HEADER$/i.test(name) || name === '' || /^\s*$/.test(name)) continue;
    if (skipIdCol && !Number.isFinite(Number(cells[0]))) continue;
    const trimmed = String(name).trim();
    if (!trimmed || /company name/i.test(trimmed)) continue; // skip repeated headers
    if (!out.has(trimmed)) out.set(trimmed, {});
    const rec = out.get(trimmed);
    for (const { colIdx, month } of monthCols) {
      const v = toNum(cells[colIdx]);
      if (v != null && v > 0) rec[month] = v;
    }
  }
  return out;
}

// Connect 2026: primary table at L85 — "|  | 2026-Jan | ... |" with customer name in col 0.
const m2026 = parseConnectFile('/tmp/connect2026.md', { customerNameCol: 0, skipIdCol: false, monthsStartAtIdx: 1 });
// Connect 2025: primary table at L100 — same pattern.
const m2025 = parseConnectFile('/tmp/connect2025.md', { customerNameCol: 0, skipIdCol: false, monthsStartAtIdx: 1 });
// Connect 2024: primary table at L1 — "Id | Name | Jan 2024 | ...", name in col 1, months start at col 2.
const m2024 = parseConnectFile('/tmp/connect2024.md', { customerNameCol: 1, skipIdCol: true, monthsStartAtIdx: 2 });

// Merge into one map (name → month → $). For overlapping months, prefer the
// newer sheet's value (2026 > 2025 > 2024) since later sheets are more current.
const merged = new Map();
function mergeInto(source) {
  for (const [name, months] of source) {
    if (!merged.has(name)) merged.set(name, {});
    const rec = merged.get(name);
    for (const [m, v] of Object.entries(months)) {
      if (rec[m] == null) rec[m] = v;
    }
  }
}
mergeInto(m2026);
mergeInto(m2025);
mergeInto(m2024);

// Build month columns and monthlyTotals.
const monthSet = new Set();
for (const months of merged.values()) for (const m of Object.keys(months)) monthSet.add(m);
const monthCols = [...monthSet].sort();
const monthlyTotals = {};
for (const m of monthCols) monthlyTotals[m] = 0;

const rows = [];
for (const [name, months] of merged) {
  const row = { customer_name: name };
  for (const m of monthCols) {
    const v = months[m];
    if (v != null) {
      row[m] = Math.round(v * 100) / 100;
      monthlyTotals[m] += v;
    } else {
      row[m] = null;
    }
  }
  rows.push(row);
}

for (const m of Object.keys(monthlyTotals)) monthlyTotals[m] = Math.round(monthlyTotals[m] * 100) / 100;

// Sort rows by lifetime connect revenue desc.
rows.sort((a, b) => {
  const aa = Object.entries(a).filter(([k]) => k !== 'customer_name').reduce((s, [, v]) => s + (typeof v === 'number' ? v : 0), 0);
  const bb = Object.entries(b).filter(([k]) => k !== 'customer_name').reduce((s, [, v]) => s + (typeof v === 'number' ? v : 0), 0);
  return bb - aa;
});

const now = new Date();
const out = {
  tab: 'connect_by_customer_month',
  sheetIds: [
    '1PUVgothQMpbj6QcHZQ0nuQIGIuDbYdb4eXgMrWTpXeE', // 2024
    '1fWkT8fpM7V8FqRwAubZWUlcCIEsdtHT4OZXoK15KW1k', // 2025
    '1IZz8yoeJ1CiSmHa_pKw1LsI3jsONVw94ZMzn-JSoMok', // 2026
  ],
  fetchedAt: now.toISOString(),
  cachedUntil: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
  columns: ['customer_name', ...monthCols],
  rows,
  rowCount: rows.length,
  monthlyTotals,
  notes:
    `Per-customer Connect fee revenue merged from Stripe Connect Revenue sheets 2024/2025/2026 (${rows.length} unique customers × ${monthCols.length} months). ` +
    'Source is monthly aggregate from each sheet; transaction-level detail not available here.',
};

process.stdout.write(JSON.stringify(out, null, 2) + '\n');
