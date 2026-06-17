#!/usr/bin/env node
/**
 * Consolidates all churn_research_batches/batch_*.json into a single keyed
 * snapshot at public/snapshots/churn_research_classifications.json that the
 * Churn Investigator page reads to surface the agent-proposed classifications
 * + verbatim evidence per customer.
 *
 * Idempotent — re-run whenever batches are added/edited.
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard';
const BATCH_DIR = path.join(ROOT, '_etl_scripts/churn_research_batches');
const OUT = path.join(ROOT, 'public/snapshots/churn_research_classifications.json');

const files = fs.readdirSync(BATCH_DIR)
  .filter((f) => f.startsWith('batch_') && f.endsWith('.json'))
  .sort();

const byCustomerId = {};
let total = 0;
const batchMeta = [];
for (const f of files) {
  const data = JSON.parse(fs.readFileSync(path.join(BATCH_DIR, f), 'utf8'));
  batchMeta.push({
    file: f,
    batch_id: data.batch_id,
    researched_at: data.researched_at,
    researcher: data.researcher,
    count: (data.classifications || []).length,
    review_status: data.review_status,
  });
  for (const c of data.classifications || []) {
    byCustomerId[String(c.allmoxy_customer_id)] = {
      ...c,
      source_batch: f,
    };
    total++;
  }
}

const out = {
  fetched_at: new Date().toISOString(),
  comment:
    'Consolidated agent-proposed churn-reason classifications, keyed by allmoxy_customer_id. Sourced from _etl_scripts/churn_research_batches/. Each entry carries the proposed_churn_reason, confidence, 3-5 verbatim evidence_quotes (date + quote + interpretation), supporting_facts, alternative_reasons_considered (with rule-out reasons), and recommended_action. Surfaced on /churn-investigator so the reviewer can accept/edit the proposed reason with one click rather than re-investigating from scratch.',
  total: total,
  batches: batchMeta,
  classifications_by_customer_id: byCustomerId,
};

fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(`Wrote ${OUT}`);
console.log(`  ${total} classifications consolidated across ${files.length} batch files`);
