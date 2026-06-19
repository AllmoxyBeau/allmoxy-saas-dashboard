import InfoIcon from './InfoIcon';

// The 6-signal Churn Risk Health Score breakdown. Used in two places:
//   - Customer Detail · Churn Risk Health Score section
//   - Churn Risk Matrix · row-expansion Score Breakdown panel
// Keep both surfaces in sync by editing this content here.
export default function HealthScoreInfo() {
  return (
    <InfoIcon
      info={
        <>
          <strong>How the score is built:</strong> six weighted signals sum to a single
          total. Higher = healthier. Tier thresholds with full data: <strong>red &lt;40</strong>,
          <strong> yellow 40-69</strong>, <strong>green 70+</strong>.<br /><br />

          <strong>1 · Order Volume</strong> (max +35)<br />
          Compares current-year $/mo run-rate to prior year (or YTD order count
          when monthly average isn&apos;t available). Running orders → +35.
          Declining &gt;50% YoY → +15. Dormant/dropped-off → 0.
          Never ran an order ("gym member") → −10.
          Within 5-mo signup grace period with no orders yet → 0 (no penalty).
          Bid-only customers → +35 (signal doesn&apos;t apply).<br /><br />

          <strong>2 · Launch Status</strong> (max +25)<br />
          From Live Date in the orders xlsx. Launched + actively running → +25.
          Launched but unclear → +18. Lifetime orders but no Live Date → +12.
          Not launched → 0.<br /><br />

          <strong>3 · Engagement Recency</strong> (max +20)<br />
          From HubSpot <code>notes_last_contacted</code>. ≤14d → +20, 15-30d → +15,
          31-60d → +8, 61-90d → +3, &gt;90d → 0. Customers running orders +
          getting silent contact are treated as autonomous power users
          (override to +20 — silence = health, not risk).<br /><br />

          <strong>4 · Risk Signals</strong> (max 0, can subtract up to −20)<br />
          Keyword scan of HubSpot notes for churn/cancel/refund/etc. mentions.
          Each match contributes a penalty. No flagged keywords → 0.<br /><br />

          <strong>5 · Tenure × Launch</strong> (max 0, can subtract up to −15)<br />
          Penalizes long-tenured customers who never launched. Launched
          (or bid-only) → 0. 6-12mo unlaunched → −5. 12-18mo → −10. 18mo+ → −15.<br /><br />

          <strong>6 · CS Health Pulse</strong> (-25 to +25)<br />
          Human judgment from the HubSpot Customer Health Pulse property
          (set by the CS rep). Green → +25. Yellow → 0. Red → −25.
          Unset → 0 (no signal).<br /><br />

          <strong>Tier overrides</strong>: hard-override-red, gym-member-cliff,
          cancelled-launch force red regardless of score. New signups within
          their 5-mo grace period are forced green unless there are concrete
          negative signals (Pulse red, failed charges, risk keywords).
        </>
      }
    />
  );
}
