#!/usr/bin/env node
// Parse allmoxy_core_customer from the .xlsx file. Row 1 is metadata
// ("MySQL Import / Last updated just now"), Row 2 is the real header.

import fs from 'node:fs';
import * as XLSX from '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard/node_modules/xlsx/xlsx.mjs';

const FILE = '/Users/beaulewis/projects/2 - Allmoxy - CFO/Allmoxy - Meta Data Reconcile Tool.xlsx';
const wb = XLSX.read(fs.readFileSync(FILE), { type: 'buffer' });
const sheet = wb.Sheets['allmoxy_core_customer'];

// sheet_to_json with range=1 skips row 1, uses row 2 as header.
const raw = XLSX.utils.sheet_to_json(sheet, { range: 1, defval: null, raw: false });

const rows = raw
  .filter((r) => r.allmoxy_customer_id != null && String(r.allmoxy_customer_id).trim() !== '')
  .map((r) => {
    const stripeIds = [r.stripe_customer_id_fromhubspot, r.stripe_customer_id_1, r.stripe_customer_id_2, r.stripe_customer_id_3]
      .filter((x) => x && String(x).startsWith('cus_'));
    return {
      allmoxy_customer_id: Number(r.allmoxy_customer_id),
      name: String(r.name ?? '').trim(),
      sign_up_date: String(r.sign_up_date ?? '').trim() || null,
      hubspot_company_id: r.hubspot_company_id != null ? String(r.hubspot_company_id) : null,
      installer_id: r.installer_id != null ? String(r.installer_id) : null,
      installer_directory: r.installer_directory ? String(r.installer_directory).trim() : null,
      stripe_customer_ids: stripeIds,
      harvest_id: r.harvest_id != null ? String(r.harvest_id) : null,
    };
  });

const now = new Date();
const out = {
  tab: 'allmoxy_core_customer',
  sheetId: '18RR86SKihlhx9qa1LyP59XaxRKkOHbAx00NnbE7iV30',
  fetchedAt: now.toISOString(),
  cachedUntil: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
  columns: ['allmoxy_customer_id', 'name', 'sign_up_date', 'hubspot_company_id', 'installer_id', 'installer_directory', 'stripe_customer_ids', 'harvest_id'],
  rows,
  rowCount: rows.length,
  notes: 'Full 600+ customer roster parsed from local xlsx export (Drive connector truncated the online version).',
};

process.stdout.write(JSON.stringify(out, null, 2) + '\n');
