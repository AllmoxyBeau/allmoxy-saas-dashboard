#!/usr/bin/env node
// Parse the allmoxy_core_customer tab from the Meta Data Reconcile Tool xlsx.
// List tab names first so we can confirm the right one.

import fs from 'node:fs';
import * as XLSX from '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard/node_modules/xlsx/xlsx.mjs';

const FILE = '/Users/beaulewis/projects/2 - Allmoxy - CFO/Allmoxy - Meta Data Reconcile Tool.xlsx';

const wb = XLSX.read(fs.readFileSync(FILE), { type: 'buffer' });
console.log('Sheet names:', JSON.stringify(wb.SheetNames));

for (const name of wb.SheetNames) {
  const sheet = wb.Sheets[name];
  const ref = sheet['!ref'];
  const rowCount = ref ? XLSX.utils.decode_range(ref).e.r + 1 : 0;
  console.log(`  ${name}: ${rowCount} rows`);
}
