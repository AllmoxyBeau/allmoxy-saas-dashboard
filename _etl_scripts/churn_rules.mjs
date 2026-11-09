/**
 * THE CHURN RULE — one definition, shared by the profile status (apply_churn_model),
 * the MRR waterfall (build_waterfall) and the logo flow (build_customer_base).
 *
 * Adopted 2026-11-09 (Beau), following the SaaS-metrics convention (Skok et al.):
 * churn is booked in the month the recurring revenue stops; a short lapse that
 * recovers was never churn; a return after confirmed churn is a reactivation.
 *
 *   CHURN MONTH   = the first month with no invoiced subscription revenue. Backdated
 *                   and frozen — confirmation never moves it, so history never rewrites.
 *   CONFIRMED BY  = whichever comes first:
 *                     • the customer's Stripe subscriptions are all canceled / ended
 *                     • HubSpot Pay Status = Cancelled, or a churn reason is filled
 *                     • LAPSE_MONTHS (3 ≈ 90 days) consecutive months without invoicing
 *   LAPSED        = stopped billing, not yet confirmed. Provisional; only ever applies to
 *                   the most recent < LAPSE_MONTHS months.
 *   RECOVERED     = billing resumed after a lapse shorter than LAPSE_MONTHS (not churn,
 *                   so the return is not a reactivation either).
 *   REACTIVATED   = billing resumed after a gap of LAPSE_MONTHS or more (confirmed churn).
 *   PAUSED        = HubSpot Pay Status "Active - Pause Granted". Supersedes all of the
 *                   above: a paused customer is never churned. Pause start = HubSpot
 *                   Payment Stop Date; expected end = Pause Resume Date. A pause past its
 *                   resume date, or older than PAUSE_REVIEW_MONTHS with no date, is
 *                   flagged for CS review — still not churned.
 */
export const LAPSE_MONTHS = 3;
export const PAUSE_REVIEW_MONTHS = 6;

export const shift = (m, d) => {
  const [y, mo] = m.split('-').map(Number);
  const dt = new Date(y, mo - 1 + d, 1);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
};
/** Whole months from a to b (b − a). */
export const monthsBetween = (a, b) => {
  const [ya, ma] = a.split('-').map(Number), [yb, mb] = b.split('-').map(Number);
  return (yb - ya) * 12 + (mb - ma);
};

const billedMonths = (series) => Object.keys(series).filter((m) => (series[m] || 0) > 0).sort();

/**
 * Classify a customer dropping to $0 in `month` (billed the month before, not this one).
 * `series` = the same month→MRR map the caller is walking; `model` = profile.churn_model.
 * Returns 'churn' | 'lapse' | 'paused'. ('lapse' is reported as delinquent or voided.)
 */
export function classifyDeparture(series, month, model) {
  const next = billedMonths(series).find((m) => m > month);
  if (next) return monthsBetween(month, next) >= LAPSE_MONTHS ? 'churn' : 'lapse';
  // No return. The customer's current state decides it.
  // Pause Granted, Pre-Sale and Partnership Free are agreed non-billing: never churn.
  if (model?.state === 'paused' || model?.state === 'non_billing_arrangement') return 'paused';
  if (model?.state === 'churned') return 'churn';
  return 'lapse';
}

/** Classify a customer returning to billing in `month` after a gap. 'reactivated' | 'recovered'. */
export function classifyReturn(series, month) {
  const prev = billedMonths(series).filter((m) => m < month).pop();
  if (!prev) return 'new';
  return monthsBetween(prev, month) - 1 >= LAPSE_MONTHS ? 'reactivated' : 'recovered';
}
