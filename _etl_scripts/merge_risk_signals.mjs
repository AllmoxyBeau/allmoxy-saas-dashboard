#!/usr/bin/env node
/**
 * Merge per-company risk-signal scan partial files into the canonical
 * /tmp/hubspot_risk_signals.json that build_at_risk_signals_from_batch.mjs reads.
 *
 * Reads from /tmp/risk_batch_*_partial/*.json (per-company files written by the
 * note-scan subagent fan-out) and writes a single consolidated file with the
 * expected shape.
 *
 * Also filters out known false positives from the Churn Risk Playbook template
 * text. Multiple subagents reported that the template question text contains
 * literal "cancel" — we exclude any signal whose snippet matches the boilerplate.
 */
import fs from 'node:fs';
import path from 'node:path';

const PARTIAL_GLOB_BASE = '/tmp';
const OUT = '/tmp/hubspot_risk_signals.json';

const PLAYBOOK_BOILERPLATE = [
  'has this customer asked to pause or cancel',
  'churn risk playbook',
  'churn-risk playbook',
];

function isFalsePositive(sig) {
  const snip = String(sig.snippet || '').toLowerCase();
  // Filter playbook template language
  if (PLAYBOOK_BOILERPLATE.some(p => snip.includes(p))) return true;
  // Filter "cancel" matches that are referring to third-party services in
  // transition notes (e.g. "Authorize.net cancellation")
  if (sig.keyword === 'cancel' || sig.keyword === 'cancellation' || sig.keyword === 'cancelled') {
    if (snip.includes('authorize.net') || snip.includes('unused service') || snip.includes('third party') || snip.includes('vendor account')) {
      return true;
    }
  }
  // Filter "moving to" workflow state language (vs vendor switch)
  if (sig.keyword === 'moving to') {
    if (snip.includes('in progress') || snip.includes('digital') || snip.includes('production') || snip.includes('sandbox') || snip.includes('live ( ') || snip.includes('moving to live')) {
      return true;
    }
  }
  return false;
}

const CATEGORY_PENALTY = {
  cancel_intent: -10,
  competitor: -5,
  dissatisfaction: -3,
  disengagement: -3,
  pricing_pressure: -3,
};

const byHs = {};
let companyCount = 0;
let companyWithNotes = 0;
let totalNotes = 0;
let totalMatches = 0;
const fpFiltered = { count: 0 };

const dirs = fs.readdirSync(PARTIAL_GLOB_BASE).filter(d => /^risk_batch_\d+_partial$/.test(d));
for (const d of dirs) {
  const dir = path.join(PARTIAL_GLOB_BASE, d);
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const hsId = f.replace(/\.json$/, '');
    if (byHs[hsId]) continue; // first-wins dedupe
    const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const rawSigs = Array.isArray(data.risk_signals) ? data.risk_signals : [];
    const cleanSigs = rawSigs.filter(s => {
      if (isFalsePositive(s)) { fpFiltered.count++; return false; }
      return true;
    });
    // Recompute penalty from cleaned signals
    let penalty = 0;
    for (const s of cleanSigs) {
      penalty += CATEGORY_PENALTY[s.category] ?? 0;
    }
    const capped = Math.max(-20, penalty);
    byHs[hsId] = {
      notes_scanned: data.notes_scanned ?? 0,
      scan_window_days: data.scan_window_days ?? 180,
      signal_4_risk: capped,
      risk_signals: cleanSigs,
    };
    companyCount++;
    if ((data.notes_scanned ?? 0) > 0) companyWithNotes++;
    totalNotes += data.notes_scanned ?? 0;
    totalMatches += cleanSigs.length;
  }
}

const out = {
  fetched_at: new Date().toISOString(),
  as_of_date: '2026-06-16',
  scan_window_days: 180,
  company_count: companyCount,
  company_count_with_notes: companyWithNotes,
  total_notes_scanned: totalNotes,
  total_keyword_matches: totalMatches,
  false_positives_filtered: fpFiltered.count,
  by_hubspot_company_id: byHs,
};

fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(`Wrote ${OUT}`);
console.log(`  companies: ${companyCount} · with_notes: ${companyWithNotes} · notes_scanned: ${totalNotes}`);
console.log(`  keyword matches: ${totalMatches} · false positives filtered: ${fpFiltered.count}`);

// Distribution
const dist = { '-20': 0, '-11_to_-19': 0, '-6_to_-10': 0, '-1_to_-5': 0, '0': 0 };
for (const v of Object.values(byHs)) {
  const r = v.signal_4_risk;
  if (r <= -20) dist['-20']++;
  else if (r <= -11) dist['-11_to_-19']++;
  else if (r <= -6) dist['-6_to_-10']++;
  else if (r <= -1) dist['-1_to_-5']++;
  else dist['0']++;
}
console.log('  signal_4_risk distribution:', dist);
