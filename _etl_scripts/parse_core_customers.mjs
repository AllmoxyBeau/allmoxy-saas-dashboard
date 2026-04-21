#!/usr/bin/env node
// Extract allmoxy_core_customer rows (L3-L157) from Meta sheet markdown.
// Output shape: { rows: [{allmoxy_customer_id, name, sign_up_date, stripe_ids[]}] }

import fs from 'node:fs';

const [, , src] = process.argv;
const HEADER_LINE = 1;
const LAST_DATA_LINE = 157;

const lines = fs.readFileSync(src, 'utf8').split('\n');

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

const rows = [];
for (let i = HEADER_LINE + 1; i <= LAST_DATA_LINE; i++) {
  const line = lines[i - 1];
  if (!line || !line.startsWith('|') || /^\|\s*:-+/.test(line)) continue;
  const c = cellsOf(line);
  const id = Number(c[0]);
  if (!Number.isFinite(id)) continue;
  const stripeIds = [c[6], c[7], c[8], c[9]].filter((x) => x && x.startsWith('cus_'));
  rows.push({
    allmoxy_customer_id: id,
    name: c[1],
    sign_up_date: c[2],
    stripe_customer_ids: stripeIds,
  });
}

const now = new Date();
process.stdout.write(
  JSON.stringify(
    {
      tab: 'allmoxy_core_customer',
      sheetId: '18RR86SKihlhx9qa1LyP59XaxRKkOHbAx00NnbE7iV30',
      fetchedAt: now.toISOString(),
      cachedUntil: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
      columns: ['allmoxy_customer_id', 'name', 'sign_up_date', 'stripe_customer_ids'],
      rows,
      rowCount: rows.length,
      notes:
        'Historical customer roster from allmoxy_core_customer tab. Covers signups 2009-2020 only; tab appears to not track newer customers.',
    },
    null,
    2
  ) + '\n'
);
