#!/usr/bin/env node
/**
 * QoE-7: Publish metric_definitions.json from _etl_scripts/ to public/snapshots/
 * so the dashboard's Definitions page can fetch it via the standard dataClient.
 *
 * Trivial pass-through; exists so the file participates in the refresh pipeline
 * and any consumer can rely on the canonical SNAP path.
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard';
const SRC = path.join(ROOT, '_etl_scripts/metric_definitions.json');
const DEST = path.join(ROOT, 'public/snapshots/metric_definitions.json');

const json = JSON.parse(fs.readFileSync(SRC, 'utf8'));
json.fetched_at = new Date().toISOString();
fs.writeFileSync(DEST, JSON.stringify(json, null, 2));
console.log(`Wrote ${DEST} — ${json.metrics.length} metric definitions across ${json.categories.length} categories.`);
