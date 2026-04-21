#!/usr/bin/env node
// Parse a markdown table range into the SheetTabResponse JSON shape.
// Usage: node parse_tab.mjs <source.md> <startLine> <endLine> <tabName> <sheetId>

import fs from 'node:fs';

const [, , src, startS, endS, tabName, sheetId] = process.argv;
const start = Number(startS);
const end = Number(endS);

const lines = fs.readFileSync(src, 'utf8').split('\n');
const slice = lines.slice(start - 1, end); // 1-indexed inclusive

// Markdown tables from the Drive connector escape underscores as \_, pipes in
// content are unescaped here too. Rows are "| v1 | v2 | ... |" — split on `|`
// and trim the leading/trailing empties.
function unescape(cell) {
  return cell
    .replace(/\\_/g, '_')
    .replace(/\\\*/g, '*')
    .replace(/\\#/g, '#')
    .replace(/\\\|/g, '|')
    .replace(/&#10;/g, '\n')
    .trim();
}

function splitRow(line) {
  const parts = line.split('|');
  // Leading and trailing empty strings from leading/trailing `|`.
  if (parts[0] === '') parts.shift();
  if (parts[parts.length - 1] === '') parts.pop();
  return parts.map(unescape);
}

const [headerLine, sepLine, ...dataLines] = slice;
if (!sepLine || !/^\|\s*:-:/.test(sepLine)) {
  console.error('Expected markdown separator at line', start + 1);
  process.exit(1);
}

const columns = splitRow(headerLine);

const rows = dataLines
  .filter((l) => l.trim().startsWith('|'))
  .map((line) => {
    const cells = splitRow(line);
    const obj = {};
    columns.forEach((col, i) => {
      if (!col) return;
      const raw = cells[i];
      if (raw === undefined || raw === '') {
        obj[col] = null;
      } else {
        const n = Number(raw.replace(/,/g, ''));
        obj[col] = !Number.isNaN(n) && /^-?\d+(\.\d+)?$/.test(raw.replace(/,/g, '')) ? n : raw;
      }
    });
    return obj;
  });

const now = new Date();
const out = {
  tab: tabName,
  sheetId,
  fetchedAt: now.toISOString(),
  cachedUntil: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
  columns,
  rows,
  rowCount: rows.length,
};

process.stdout.write(JSON.stringify(out, null, 2) + '\n');
