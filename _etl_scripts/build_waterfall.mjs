#!/usr/bin/env node
// Build MRR waterfall snapshot on BOTH bases: per-month New / Expansion / Contraction /
// Churn deltas.
//
// For each month M vs prior month M-1, for each customer:
//   prev == 0 && cur > 0  → New (first-ever MRR month) or Reactivated
//   prev > 0 && cur == 0  → Churned (confirmed) / Voided (billing canceled) / Delinquent
//   cur > prev            → Expansion (cur - prev)
//   cur < prev            → Contraction (prev - cur)
//
// Ending MRR = Starting + New + Reactivated + Expansion - Contraction - Churn - Voided - Delinquent.
//
// TWO BASES (Beau, 2026-09-05 — accrual is the default view, cash stays visible):
//   • CASH (`monthly`)  — from customer_profiles.monthly_history: what CLEARED Stripe.
//     Full history. Right for bank reconciliation, but a failed card / late capture
//     reads as churn, which overstates churn ~2x and understates GRR/NRR.
//   • ACCRUAL (`monthly_accrual`) — from revenue_recognition.accrual_series: what was
//     BILLED by invoice date. A card failure is an open receivable, not churn. Only
//     available from `accrual_reliable_from` (2025-08) because Allmoxy migrated to
//     Stripe invoicing mid-2025 and coverage before then is 4–28% of actual revenue.
//
// Retention metrics should read the ACCRUAL basis; reconciliation reads CASH.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard';
const SNAP = path.join(ROOT, 'public/snapshots');
const profiles = JSON.parse(fs.readFileSync(path.join(SNAP, 'customer_profiles.json'), 'utf8')).rows;
// Accrual series + reliability window (built by build_revenue_recognition, which now
// runs BEFORE this script). Optional: if absent, only the cash basis is emitted.
let RR = null; try { RR = JSON.parse(fs.readFileSync(path.join(SNAP, 'revenue_recognition.json'), 'utf8')); } catch { /* first run */ }
// Voided invoices by (aid, service month) — a voided invoice means the billing was
// intentionally canceled, so the customer dropping to $0 is NOT delinquency/dunning.
let INV = null; try { INV = JSON.parse(fs.readFileSync(path.join(ROOT, '_etl_scripts/cache/stripe_invoices.json'), 'utf8')); } catch { /* optional */ }

const r2 = (v) => Math.round(v * 100) / 100;
const shift = (m, d) => { const [y, mo] = m.split('-').map(Number); const dt = new Date(y, mo - 1 + d, 1); return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`; };
const today = new Date();
const currentMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;

// ── voided-billing index + sales-tax index, both aid-keyed ──
// SALES TAX IS NOT REVENUE (Beau, 2026-09-05). Stripe CHARGE amounts are invoice
// totals, so the cash series carries ~1.5% of sales tax (~$3.4K/mo) that must come
// out. The accrual series is already ex-tax (it sums invoice LINE amounts, and tax
// lives in total_tax_amounts). Tax is keyed by the invoice's PAID month so it nets
// against the month the cash actually cleared.
const voidedByAid = new Map();
const taxByAidPaidMonth = new Map(); // aid -> { 'YYYY-MM': tax }
if (INV) {
  const custToAid = new Map();
  for (const p of profiles) for (const c of (p.stripe_customer_ids || [])) custToAid.set(c, p.allmoxy_customer_id);
  for (const [cid, cust] of Object.entries(INV.by_customer || {})) {
    const aid = custToAid.get(cid); if (aid == null) continue;
    for (const i of (cust.invoices || [])) {
      const line = (i.lines || []).find((l) => l.rec && l.ps);
      if (i.status === 'void') {
        const m = (line?.ps || i.d || '').slice(0, 7); if (!m) continue;
        if (!voidedByAid.has(aid)) voidedByAid.set(aid, new Set());
        voidedByAid.get(aid).add(m);
        continue;
      }
      if (!(i.tax > 0) || !i.paid_at) continue; // only collected tax sits in the cash series
      const pm = String(i.paid_at).slice(0, 7);
      if (!taxByAidPaidMonth.has(aid)) taxByAidPaidMonth.set(aid, {});
      const o = taxByAidPaidMonth.get(aid); o[pm] = r2((o[pm] || 0) + i.tax);
    }
  }
}

// ── CASH series: live profiles, with boundary-slip correction ──
// A subscription charge that clears in the first 3 days of month M but covers the PRIOR
// cycle (M-1 empty, M-2 present — an end-of-month biller whose payment cleared on the
// 1st) is attributed to M-1. Without this, the month it slipped out of shows false churn
// and the month it slipped into shows false reactivation. transactions[] keep their real
// dates (cash) — only this in-memory monthly series is period-adjusted.
function cashCustomers() {
  const out = [];
  for (const p of profiles) {
    const mrrByMonth = {};
    for (const [m, v] of Object.entries(p.monthly_history || {})) { const s = v.subscription || 0; if (s > 0) mrrByMonth[m] = s; }
    for (const t of (p.transactions || [])) {
      if (t.type !== 'subscription' || t.status !== 'succeeded') continue;
      const d = String(t.created || ''); const day = Number(d.slice(8, 10)); const M = d.slice(0, 7);
      if (!(day <= 3) || !M) continue;
      const pm = shift(M, -1), pm2 = shift(M, -2);
      if ((mrrByMonth[pm] || 0) === 0 && (mrrByMonth[pm2] || 0) > 0) {
        const amt = (t.net_amount ?? t.amount) || 0;
        mrrByMonth[pm] = r2((mrrByMonth[pm] || 0) + amt);
        mrrByMonth[M] = r2(Math.max(0, (mrrByMonth[M] || 0) - amt));
        if (mrrByMonth[M] <= 0.5) delete mrrByMonth[M];
      }
    }
    // Remove collected sales tax — it's a pass-through liability, not revenue.
    const tx = taxByAidPaidMonth.get(p.allmoxy_customer_id);
    if (tx) for (const [m, t] of Object.entries(tx)) {
      if (!(mrrByMonth[m] > 0)) continue;
      mrrByMonth[m] = r2(Math.max(0, mrrByMonth[m] - t));
      if (mrrByMonth[m] <= 0.5) delete mrrByMonth[m];
    }
    if (Object.keys(mrrByMonth).length) out.push({ name: p.name, id: p.allmoxy_customer_id ?? null, status: p.status ?? null, pay_status: p.pay_status ?? null, mrrByMonth });
  }
  return out;
}

// ── ACCRUAL series: invoice-basis recognized MRR per customer × month ──
function accrualCustomers() {
  if (!RR?.accrual_series?.length) return null;
  const byAid = new Map(profiles.map((p) => [p.allmoxy_customer_id, p]));
  const out = [];
  for (const row of RR.accrual_series) {
    const p = byAid.get(row.allmoxy_customer_id); if (!p) continue;
    if (Object.keys(row.months || {}).length) out.push({ name: p.name, id: p.allmoxy_customer_id, status: p.status ?? null, pay_status: p.pay_status ?? null, mrrByMonth: row.months });
  }
  return out;
}

// ── the walk (shared by both bases) ──
function walk(customers, { startMonth = null } = {}) {
  const monthCols = [...new Set(customers.flatMap((c) => Object.keys(c.mrrByMonth)))]
    .filter((m) => !startMonth || m >= startMonth).sort();
  const keyOf = (c) => (c.id != null ? `id:${c.id}` : `nm:${c.name}`);
  // First-ever MRR month distinguishes a true new logo from a reactivation. Computed on
  // the customer's FULL series (not the windowed one) so a customer active before the
  // accrual window isn't miscounted as new in the window's first month.
  const firstMonth = new Map();
  for (const c of customers) {
    const ms = Object.keys(c.mrrByMonth).filter((m) => (c.mrrByMonth[m] ?? 0) > 0).sort();
    if (ms.length) firstMonth.set(keyOf(c), ms[0]);
  }
  const monthly = [];
  for (let i = 1; i < monthCols.length; i++) {
    const prev = monthCols[i - 1], cur = monthCols[i];
    if (cur >= currentMonth) break; // exclude current (partial) month
    let newMrr = 0, reactivatedMrr = 0, expansion = 0, contraction = 0, churn = 0, voided = 0, delinquent = 0;
    let startingMrr = 0, endingMrr = 0, churnedLogos = 0, voidedLogos = 0, delinquentLogos = 0, newLogos = 0, reactivatedLogos = 0;
    const details = { new: [], reactivated: [], expansion: [], contraction: [], churn: [], voided: [], delinquent: [] };
    for (const c of customers) {
      const p = c.mrrByMonth[prev] ?? 0, n = c.mrrByMonth[cur] ?? 0;
      startingMrr += p; endingMrr += n;
      if (p === 0 && n > 0) {
        if (firstMonth.get(keyOf(c)) === cur) { newMrr += n; newLogos += 1; details.new.push({ name: c.name, id: c.id, mrr: r2(n) }); }
        else { reactivatedMrr += n; reactivatedLogos += 1; details.reactivated.push({ name: c.name, id: c.id, mrr: r2(n) }); }
      } else if (p > 0 && n === 0) {
        // Dropped to $0. Three distinct causes, reported separately:
        //   churn      — confirmed cancellation (status 'churned' = HubSpot-confirmed or 12-month lapse)
        //   voided     — the invoice for this period was VOIDED in Stripe: billing was
        //                intentionally canceled, so nothing is owed. Not dunning.
        //   delinquent — still billable, just didn't clear (card failure / non-payment).
        // All three reduce ending MRR; separating them keeps `churn` a true-loss number.
        if (c.status === 'churned') { churn += p; churnedLogos += 1; details.churn.push({ name: c.name, id: c.id, mrr: r2(p) }); }
        else if (voidedByAid.get(c.id)?.has(cur)) { voided += p; voidedLogos += 1; details.voided.push({ name: c.name, id: c.id, mrr: r2(p), status: c.status, pay_status: c.pay_status }); }
        else { delinquent += p; delinquentLogos += 1; details.delinquent.push({ name: c.name, id: c.id, mrr: r2(p), status: c.status, pay_status: c.pay_status }); }
      } else if (n > p) {
        expansion += n - p; details.expansion.push({ name: c.name, id: c.id, prev_mrr: r2(p), new_mrr: r2(n), delta: r2(n - p) });
      } else if (n < p) {
        contraction += p - n; details.contraction.push({ name: c.name, id: c.id, prev_mrr: r2(p), new_mrr: r2(n), delta: r2(p - n) });
      }
    }
    for (const k of ['new', 'reactivated', 'churn', 'voided', 'delinquent']) details[k].sort((a, b) => b.mrr - a.mrr);
    for (const k of ['expansion', 'contraction']) details[k].sort((a, b) => b.delta - a.delta);
    const netNew = newMrr + reactivatedMrr + expansion - contraction - churn - voided - delinquent;
    const grr = startingMrr > 0 ? (startingMrr - churn - contraction) / startingMrr : null;
    const nrr = startingMrr > 0 ? (startingMrr - churn - contraction + expansion) / startingMrr : null;
    const p4 = (v) => (v != null ? Math.round(v * 10000) / 10000 : null);
    monthly.push({
      month: cur,
      starting_mrr: r2(startingMrr), new_mrr: r2(newMrr), reactivated_mrr: r2(reactivatedMrr),
      expansion_mrr: r2(expansion), contraction_mrr: r2(contraction), churn_mrr: r2(churn),
      voided_mrr: r2(voided), delinquent_mrr: r2(delinquent),
      ending_mrr: r2(endingMrr), net_new_mrr: r2(netNew),
      new_logos: newLogos, reactivated_logos: reactivatedLogos, churned_logos: churnedLogos,
      voided_logos: voidedLogos, delinquent_logos: delinquentLogos,
      gross_churn_rate_monthly: p4(startingMrr > 0 ? churn / startingMrr : null),
      net_churn_rate_monthly: p4(startingMrr > 0 ? (churn + contraction - expansion) / startingMrr : null),
      expansion_rate_monthly: p4(startingMrr > 0 ? expansion / startingMrr : null),
      grr_monthly: p4(grr), nrr_monthly: p4(nrr),
      quick_ratio: churn + contraction > 0 ? Math.round(((newMrr + expansion) / (churn + contraction)) * 100) / 100 : null,
      details,
    });
  }
  return monthly;
}

function summarize(monthly) {
  const ttm = monthly.filter((r) => r.month < currentMonth).slice(-12);
  const sum = (k) => ttm.reduce((s, r) => s + (r[k] ?? 0), 0);
  const mean = (k) => { const v = ttm.map((r) => r[k]).filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const p4 = (v) => (v != null ? Math.round(v * 10000) / 10000 : null);
  const start = ttm[0]?.starting_mrr ?? 0;
  const mGross = mean('gross_churn_rate_monthly'), mNRR = mean('nrr_monthly'), mGRR = mean('grr_monthly');
  const churn = sum('churn_mrr'), contraction = sum('contraction_mrr');
  return {
    windowStart: ttm[0]?.month ?? null, windowEnd: ttm[ttm.length - 1]?.month ?? null, months: ttm.length,
    starting_mrr: r2(start), ending_mrr: r2(ttm[ttm.length - 1]?.ending_mrr ?? 0),
    new_mrr: r2(sum('new_mrr')), reactivated_mrr: r2(sum('reactivated_mrr')),
    expansion_mrr: r2(sum('expansion_mrr')), contraction_mrr: r2(contraction),
    churn_mrr: r2(churn), voided_mrr: r2(sum('voided_mrr')), delinquent_mrr: r2(sum('delinquent_mrr')),
    net_new_mrr: r2(sum('new_mrr') + sum('reactivated_mrr') + sum('expansion_mrr') - contraction - churn - sum('voided_mrr') - sum('delinquent_mrr')),
    gross_mrr_churn_ttm: p4(start > 0 ? churn / start : null),
    annual_gross_churn_rate: p4(mGross != null ? 1 - Math.pow(1 - mGross, 12) : null),
    annual_grr: p4(mGRR != null ? Math.pow(mGRR, 12) : null),
    annual_nrr: p4(mNRR != null ? Math.pow(mNRR, 12) : null),
    quick_ratio: churn + contraction > 0 ? Math.round(((sum('new_mrr') + sum('expansion_mrr')) / (churn + contraction)) * 100) / 100 : null,
  };
}

const monthly = walk(cashCustomers());
const accrualCusts = accrualCustomers();
const accrualFrom = RR?.accrual_reliable_from ?? null;
const monthlyAccrual = accrualCusts ? walk(accrualCusts, { startMonth: accrualFrom }) : null;

const now = new Date();
const out = {
  tab: 'mrr_waterfall',
  fetchedAt: now.toISOString(),
  cachedUntil: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
  columns: [], rows: [], rowCount: 0,
  // Default basis for retention/churn reading. `monthly`/`ttm` stay CASH so existing
  // reconciliation consumers are unchanged; retention consumers read *_accrual.
  basis_default: monthlyAccrual ? 'accrual' : 'cash',
  accrual_reliable_from: accrualFrom,
  accrual_coverage: RR?.accrual_coverage ?? null,
  monthly,
  ttm: summarize(monthly),
  monthly_accrual: monthlyAccrual,
  ttm_accrual: monthlyAccrual ? summarize(monthlyAccrual) : null,
  notes:
    'MRR waterfall on two bases. CASH (monthly/ttm) = customer_profiles.monthly_history — what cleared Stripe, boundary-slip corrected, full history; use for bank reconciliation. ' +
    'ACCRUAL (monthly_accrual/ttm_accrual) = revenue_recognition.accrual_series — what was BILLED by invoice date, so a card failure is an open receivable rather than churn; use for retention metrics. ' +
    `Accrual starts ${accrualFrom ?? 'n/a'} because Stripe-invoice coverage before mid-2025 is 4–28% of actual revenue (Allmoxy migrated to invoicing then). ` +
    'New = customer first appears with MRR > 0; Reactivated = billed before, returning. Churn = confirmed-churned (status churned). ' +
    'Voided = dropped to $0 with a VOIDED invoice for the period — billing intentionally canceled, nothing owed (not dunning). ' +
    'Delinquent = dropped to $0, still billable, did not clear (card failure / non-payment) — may still pay. All three reduce ending MRR but are reported separately. ' +
    'Sales tax is EXCLUDED on both bases: it is a pass-through liability, not revenue. Accrual sums pre-tax invoice lines; cash has collected tax subtracted by the invoice paid month (~1.5% of gross, ~$3.4K/mo). ' +
    'Services and Connect revenue are NOT included — subscription only.',
  sales_tax_excluded: true,
};

process.stdout.write(JSON.stringify(out, null, 2) + '\n');
