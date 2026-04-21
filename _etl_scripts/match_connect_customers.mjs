#!/usr/bin/env node
/**
 * For each of the 101 Connect customers, find the best match(es) in the
 * 600-row Allmoxy roster. Outputs a ranked table grouped by confidence
 * so the user can paste it into a spreadsheet and resolve the ambiguous few.
 *
 * Strategies (tried in order; first strong hit wins):
 *   1. Exact lowercased-trimmed name match
 *   2. Normalized name match (strip Inc/LLC/Co/Ltd/Corp, punct, & vs and, dashes)
 *   3. Tokenized overlap (Jaccard on significant tokens)
 *   4. Substring containment (one name contains the other, post-normalize)
 */

import fs from 'node:fs';
import path from 'node:path';

const SNAP = '/Users/beaulewis/Documents/Claude/Projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard/src/data/snapshots';
const cbcm = JSON.parse(fs.readFileSync(path.join(SNAP, 'connect_by_customer_month.json'), 'utf8'));
const profiles = JSON.parse(fs.readFileSync(path.join(SNAP, 'customer_profiles.json'), 'utf8'));

const SUFFIX_RE = /\b(inc|incorporated|llc|l\.l\.c|ltd|limited|co|corp|corporation|company|llp|lp|plc)\b\.?/gi;
const TRIVIAL_WORDS = new Set(['the', 'a', 'an', 'of', 'and', '&']);

function normalize(name) {
  if (!name) return '';
  let s = String(name).toLowerCase();
  s = s.replace(/&/g, ' and ');
  s = s.replace(SUFFIX_RE, ' ');
  s = s.replace(/[^a-z0-9\s]/g, ' '); // strip punctuation
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function tokens(name) {
  return new Set(
    normalize(name)
      .split(/\s+/)
      .filter((t) => t.length >= 2 && !TRIVIAL_WORDS.has(t))
  );
}

function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union > 0 ? inter / union : 0;
}

// Pre-index the 600-row roster.
const rosterByExact = new Map();
const rosterByNorm = new Map();
const roster = [];
for (const r of profiles.rows) {
  const entry = {
    id: r.allmoxy_customer_id,
    name: r.name,
    installer_directory: r.installer_directory,
    normName: normalize(r.name),
    tokens: tokens(r.name),
    lifetime_total: r.lifetime_total,
    lifetime_connect: r.lifetime_connect,
  };
  roster.push(entry);
  rosterByExact.set(r.name.toLowerCase().trim(), entry);
  if (!rosterByNorm.has(entry.normName)) rosterByNorm.set(entry.normName, []);
  rosterByNorm.get(entry.normName).push(entry);
}

function classify(connectName) {
  // 0. Junk filter
  if (!connectName || /^#?N\/?A$/i.test(connectName) || connectName.trim() === '') {
    return { confidence: 'JUNK', reason: 'empty or #N/A', candidates: [] };
  }

  // 1. Exact
  const exact = rosterByExact.get(connectName.toLowerCase().trim());
  if (exact) return { confidence: 'HIGH', reason: 'exact name match', candidates: [{ ...exact, score: 1.0 }] };

  // 2. Normalized exact
  const norm = normalize(connectName);
  if (rosterByNorm.has(norm)) {
    const hits = rosterByNorm.get(norm);
    if (hits.length === 1) {
      return { confidence: 'HIGH', reason: 'normalized name match', candidates: [{ ...hits[0], score: 0.95 }] };
    }
    return {
      confidence: 'LOW',
      reason: `${hits.length} rows normalize to same key "${norm}"`,
      candidates: hits.map((h) => ({ ...h, score: 0.9 })),
    };
  }

  // 3/4. Token overlap + substring
  const cNorm = norm;
  const cTok = tokens(connectName);
  const scored = [];
  for (const r of roster) {
    if (!r.normName) continue;
    const j = jaccard(cTok, r.tokens);
    const containsAinB = r.normName.includes(cNorm) && cNorm.length >= 4;
    const containsBinA = cNorm.includes(r.normName) && r.normName.length >= 4;
    const score = Math.max(j, containsAinB || containsBinA ? 0.85 : 0);
    if (score > 0.4) scored.push({ ...r, score, containment: containsAinB || containsBinA });
  }
  scored.sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return { confidence: 'UNMATCHED', reason: 'no candidate above threshold', candidates: [] };
  }
  const top = scored[0];
  const second = scored[1];
  const gap = second ? top.score - second.score : 1;

  if (top.score >= 0.85 && gap >= 0.15) {
    return { confidence: 'PROBABLE', reason: top.containment ? 'substring containment' : `token overlap ${top.score.toFixed(2)}`, candidates: scored.slice(0, 3) };
  }
  if (top.score >= 0.6 && gap >= 0.1) {
    return { confidence: 'MAYBE', reason: `token overlap ${top.score.toFixed(2)}, gap ${gap.toFixed(2)}`, candidates: scored.slice(0, 3) };
  }
  return { confidence: 'LOW', reason: `ambiguous — top ${top.score.toFixed(2)}, runner-up ${(second?.score ?? 0).toFixed(2)}`, candidates: scored.slice(0, 3) };
}

// Classify every Connect customer.
const out = [];
let totalLifetimeFees = 0;
for (const row of cbcm.rows) {
  let lifetime = 0;
  for (const [k, v] of Object.entries(row)) {
    if (/^\d{4}-\d{2}$/.test(k) && typeof v === 'number' && v > 0) lifetime += v;
  }
  totalLifetimeFees += lifetime;
  const result = classify(row.customer_name);
  out.push({ connect_name: row.customer_name, lifetime_connect: Math.round(lifetime * 100) / 100, ...result });
}

// Sort: biggest Connect fees first within each group.
const ORDER = { HIGH: 0, PROBABLE: 1, MAYBE: 2, LOW: 3, UNMATCHED: 4, JUNK: 5 };
out.sort((a, b) => {
  const d = ORDER[a.confidence] - ORDER[b.confidence];
  if (d !== 0) return d;
  return b.lifetime_connect - a.lifetime_connect;
});

const counts = { HIGH: 0, PROBABLE: 0, MAYBE: 0, LOW: 0, UNMATCHED: 0, JUNK: 0 };
for (const r of out) counts[r.confidence]++;

console.log('\n=== SUMMARY ===');
console.log(`Total Connect customers: ${out.length}`);
console.log(`Total lifetime Connect fees: $${Math.round(totalLifetimeFees).toLocaleString()}`);
for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(10)} ${v}`);

// Dump a markdown table for the user, grouped by confidence.
console.log('\n');
for (const level of ['HIGH', 'PROBABLE', 'MAYBE', 'LOW', 'UNMATCHED', 'JUNK']) {
  const group = out.filter((r) => r.confidence === level);
  if (group.length === 0) continue;
  console.log(`\n### ${level} (${group.length})\n`);
  console.log('| Connect name | Lifetime fees | Proposed match | Allmoxy ID | Reason / alternates |');
  console.log('|---|---:|---|---:|---|');
  for (const r of group) {
    const top = r.candidates[0];
    const alts = r.candidates.slice(1, 3).map((c) => `${c.name} (${c.id}, ${c.score.toFixed(2)})`).join(' · ');
    const note = alts ? `${r.reason}; alts: ${alts}` : r.reason;
    const fees = `$${r.lifetime_connect.toLocaleString()}`;
    if (top) {
      console.log(`| ${r.connect_name} | ${fees} | ${top.name} | ${top.id} | ${note} |`);
    } else {
      console.log(`| ${r.connect_name} | ${fees} | — | — | ${note} |`);
    }
  }
}

// Also emit a JSON file with the proposed mapping for review/patching.
const mapping = {
  generated_at: new Date().toISOString(),
  summary: counts,
  total_lifetime_connect_fees: Math.round(totalLifetimeFees * 100) / 100,
  rows: out.map((r) => ({
    connect_name: r.connect_name,
    lifetime_connect: r.lifetime_connect,
    confidence: r.confidence,
    reason: r.reason,
    proposed_allmoxy_customer_id: r.candidates[0]?.id ?? null,
    proposed_name: r.candidates[0]?.name ?? null,
    alternates: r.candidates.slice(1, 3).map((c) => ({ id: c.id, name: c.name, score: Math.round(c.score * 100) / 100 })),
  })),
};
fs.writeFileSync('/tmp/connect_mapping_proposal.json', JSON.stringify(mapping, null, 2));
console.log(`\n\nFull proposal JSON: /tmp/connect_mapping_proposal.json`);
