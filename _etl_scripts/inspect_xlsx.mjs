#!/usr/bin/env node
import fs from 'node:fs';
import * as XLSX from '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard/node_modules/xlsx/xlsx.mjs';

const FILE = '/Users/beaulewis/projects/2 - Allmoxy - CFO/Allmoxy - Meta Data Reconcile Tool.xlsx';
const wb = XLSX.read(fs.readFileSync(FILE), { type: 'buffer' });

const tab = process.argv[2] || 'allmoxy_core_customer';
const sheet = wb.Sheets[tab];
if (!sheet) {
  console.error('Tab not found:', tab);
  console.error('Available:', wb.SheetNames);
  process.exit(1);
}
const rows = XLSX.utils.sheet_to_json(sheet, { defval: null, raw: false });
// Drop trailing empty rows
const nonEmpty = rows.filter((r) => Object.values(r).some((v) => v != null && v !== ''));
console.log(`Tab: ${tab}`);
console.log(`Total rows (incl. blanks): ${rows.length}`);
console.log(`Non-empty rows: ${nonEmpty.length}`);
console.log('Columns:', Object.keys(nonEmpty[0] || {}));
console.log('First 3 rows:');
for (const r of nonEmpty.slice(0, 3)) console.log(JSON.stringify(r, null, 2));
console.log('Last row:');
console.log(JSON.stringify(nonEmpty[nonEmpty.length - 1] || {}, null, 2));
