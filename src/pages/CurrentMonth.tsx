import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import Skeleton from '@mui/material/Skeleton';
import Alert from '@mui/material/Alert';
import Chip from '@mui/material/Chip';
import Link from '@mui/material/Link';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import Collapse from '@mui/material/Collapse';

import PageHeader from '../components/common/PageHeader';
import AccrualMonthPanel from '../components/common/AccrualMonthPanel';
import MonthPaceChart from '../components/common/MonthPaceChart';
import InfoIcon from '../components/common/InfoIcon';
import CsvExportButton from '../components/common/CsvExportButton';
import CollapseToggle, { useCollapse } from '../components/common/CollapseToggle';
import CustomerLink from '../components/common/CustomerLink';
import { useCurrentMonth, USD0, fmtIso, fmtPct, monthLabel, pctDelta, type VarianceCategory } from './currentMonth/useCurrentMonth';

export default function CurrentMonth() {
  const { mrrLoading, mrr, view, subscriptionView, activeCategories, toggleCategory } = useCurrentMonth();
  const varianceTable = useCollapse(true);

  if (mrrLoading || !view) {
    return (
      <Box>
        <PageHeader title="Current Month" subtitle="Month-to-date metrics from the latest snapshot." />
        <Skeleton variant="rectangular" height={140} />
      </Box>
    );
  }

  const dataThrough = fmtIso(`${view.asOf}T12:00:00`);
  const elapsedCaveat = `${view.elapsed} of ${view.totalDays} days · data through ${dataThrough}`;

  return (
    <Box>
      <PageHeader
        title={`${monthLabel(view.currentMonth)} · Month-to-date`}
        subtitle={`Live snapshot of the partial current month. Data through ${dataThrough}${view.asOfSource === 'current_month' ? ' (Stripe sync cut-off)' : view.asOfSource === 'transactions' ? ` (latest synced transaction${view.stripeAsOf && view.stripeAsOf > view.asOf ? `; Stripe API data runs to ${fmtIso(`${view.stripeAsOf}T12:00:00`)}` : ''})` : ''}${view.dataStale ? ' — STALE, trails today' : ''} · refreshed ${fmtIso(mrr?.fetchedAt)} · ${view.elapsed} of ${view.totalDays} days elapsed · ${view.remaining} days remaining. All projections use this cut-off.`}
      />

      {/* The accrual answer leads: how MRR moved, and what is billed vs still to come.
          The cash sections below remain for reconciling to the bank. */}
      <AccrualMonthPanel />

      {/* Apples-to-apples: the current bar carries a shaded block for what is still
          expected, so a part-month can be read against completed ones. */}
      <MonthPaceChart />

      {view.elapsed === 0 && (
        <Alert severity="info" sx={{ mb: 2 }}>
          The data snapshot was generated before any day in {monthLabel(view.currentMonth)} elapsed — projections aren't meaningful yet.
        </Alert>
      )}

      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid item xs={12} sm={6} md={2.4}>
          <KPICard
            label="Subscription MRR"
            value={subscriptionView ? USD0.format(subscriptionView.projected) : USD0.format(view.subscription.mtd ?? 0)}
            valueHint={subscriptionView ? `projected month-end (excludes overdue & paused) · data through ${dataThrough}` : undefined}
            sub={
              subscriptionView
                ? `${USD0.format(subscriptionView.postedCur)} posted from ${subscriptionView.postedSubs} subscriptions · ${USD0.format(subscriptionView.expectedDollars)} expected from ${subscriptionView.expectedSubs}`
                : `${view.subscription.currentLogos ?? 0} of ${view.subscription.priorLogos ?? '—'} expected billings posted`
            }
            delta={subscriptionView?.variancePct ?? null}
            deltaLabel={`vs ${monthLabel(view.prior)} apples-to-apples`}
            info={
              <>
                <strong>Headline value:</strong> projected end-of-month subscription MRR. Posted (already billed) + expected (active accounts, still-on-time pending, will bill at prior amount). <em>Expected counts active-status accounts only</em> — overdue, paused, at-risk, non-payment, and cancelled customers are counted as zero in the projection until they actually bill. The <strong>Upcoming expected subscription payments</strong> table at the bottom of the page lists every subscription in the "expected" figure.
                <br /><br />
                <strong>Variance vs {monthLabel(view.prior)}</strong> is the apples-to-apples customer-level comparison: posted-customer changes (contraction/expansion/new logos) <em>plus</em> overdue customers' lost revenue. The Overdue panel below breaks the variance into its two components so the math reconciles.
              </>
            }
          />
        </Grid>
        <Grid item xs={12} sm={6} md={2.4}>
          <KPICard
            label="Services revenue (MTD)"
            value={USD0.format(view.services.mtd ?? 0)}
            sub={view.services.projected != null ? `Projected month-end: ${USD0.format(view.services.projected)}` : 'Projection unavailable'}
            projectionCaveat={elapsedCaveat}
            delta={pctDelta(view.services.projected, view.services.priorTotal)}
            deltaLabel={`projected vs ${monthLabel(view.prior)} full`}
            info={<><strong>What it is:</strong> Services revenue (one-off project work). MTD value is sum of services charges so far this month; the projection assumes the same daily run-rate continues.</>}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={2.4}>
          <KPICard
            label="Connect fees (MTD, net USD)"
            value={view.connect.mtd != null ? USD0.format(view.connect.mtd) : '—'}
            sub={
              view.connect.mtd == null
                ? 'Not yet in the current snapshot'
                : view.connect.projected != null
                  ? `Projected month-end: ${USD0.format(view.connect.projected)}`
                  : 'Projection unavailable'
            }
            projectionCaveat={view.connect.mtd != null ? elapsedCaveat : undefined}
            delta={pctDelta(view.connect.projected, view.connect.priorTotal)}
            deltaLabel={`projected vs ${monthLabel(view.prior)} full`}
            info={<><strong>What it is:</strong> Stripe Connect (affiliate) fees — <strong>net settled in USD</strong>, i.e. what actually hits the bank. Sourced live from Stripe <em>balance transactions</em> (type <code>application_fee</code>), so foreign-currency (CAD) fees are already FX-converted by Stripe and refunds are netted out. This differs from the gross take on the Payments Opportunity page, which reports each fee in its original charge currency. June 2026+ is live; earlier months come from history.</>}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={2.4}>
          <KPICard
            label="Annual payments (amortized)"
            value={USD0.format(subscriptionView?.annualAmort ?? 0)}
            valueHint="annual prepay recognized this month"
            sub={(subscriptionView?.annualAmort ?? 0) > 0 ? 'Spread from lump annual payments' : 'No annual payers this month'}
            info={<><strong>What it is:</strong> The amortized monthly slice of customers who pay <strong>annually upfront</strong> (e.g. B&amp;B Door, Mid Michigan Wood). They have no monthly Stripe charge, so they're excluded from the Subscription MRR card above (which counts actual charges) — this card adds their recognized monthly revenue so Blended reconciles to the MRR-by-Month basis.<br /><br /><strong>Data:</strong> Sum of <code>monthly_history</code> subscription for annual-payer IDs in the reference month.</>}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={2.4}>
          {(() => {
            const subProj = subscriptionView?.projected ?? view.subscription.mtd ?? 0;
            const svcProj = view.services.projected ?? view.services.mtd ?? 0;
            const connProj = view.connect.projected ?? view.connect.mtd ?? 0;
            const annualProj = subscriptionView?.annualAmort ?? 0;
            const blendedProjected = subProj + svcProj + connProj + annualProj;
            // mrr_blended already carries this month's annual amortization (it is part
            // of mrr_by_month.mrr_subscription), so adding annualProj again double-counted it.
            const blendedMtd = view.blended.mtd ?? 0;
            const stillExpected = Math.max(blendedProjected - blendedMtd, 0);
            return (
              <KPICard
                label="Blended revenue"
                value={USD0.format(blendedProjected)}
                valueHint={`projected month-end (all streams + annual) · data through ${dataThrough}`}
                sub={`${USD0.format(blendedMtd)} posted · ${USD0.format(stillExpected)} still expected`}
                projectionCaveat={elapsedCaveat}
                delta={pctDelta(blendedProjected, view.blended.priorTotal)}
                deltaLabel={`projected vs ${monthLabel(view.prior)} full`}
                info={
                  <>
                    <strong>Headline value:</strong> projected end-of-month total revenue across all streams (Subscription + Services + Connect + amortized annual prepay). Combines the per-stream projections from the cards above, so it reconciles to the MRR-by-Month blended figure.
                    <br /><br />
                    <strong>Subscription</strong> contribution = posted + non-overdue pending (billing-cycle aware). <strong>Services</strong> + <strong>Connect</strong> contributions = linear MTD run-rate × days-in-month / days-elapsed.
                    <br /><br />
                    Delta is projected month-end vs. {monthLabel(view.prior)} full — a forward-looking comparison rather than MTD-vs-full.
                  </>
                }
              />
            );
          })()}
        </Grid>
      </Grid>

      <Grid container spacing={2}>
        <Grid item xs={12}>
          <Paper sx={{ p: 3 }}>
            <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between" sx={{ mb: varianceTable.open ? 2 : 0 }}>
              <Stack direction="row" spacing={1} alignItems="center">
                <CollapseToggle open={varianceTable.open} onToggle={varianceTable.toggle} label="variance detail" />
                <Typography variant="subtitle2" sx={{ color: 'text.secondary' }}>
                  Variance vs {monthLabel(view.prior)} · per-customer detail
                </Typography>
                <InfoIcon
                  info={
                    <>
                      Per-customer breakdown of the subscription MRR variance vs {monthLabel(view.prior)}. Each customer falls into one of these categories: <em>new logo</em> (no prior subscription history, billed this month), <em>reactivated</em> (returning after 4+ month gap), <em>reconnected</em> (genuinely not invoiced last month, billing again now), <em>billing timing</em> (invoiced last month on the accrual basis — only the cash landed outside it, so nothing changed commercially), <em>expanded</em> (billed prior month and paid more this month), <em>contracted</em> (billed prior month and paid less), <em>overdue</em> (billed prior month, past their expected day with no charge yet), or <em>cancelled</em> (billed prior month, confirmed cancellation in HubSpot, no charge this month). Category sums reconcile to the total variance.
                      <br /><br />
                      Click chips to filter the table.
                    </>
                  }
                />
              </Stack>
              {subscriptionView && (
                <CsvExportButton
                  filename={`variance_${view.currentMonth}_vs_${view.prior}`}
                  columns={[
                    { key: 'customerId', label: 'Allmoxy ID' },
                    { key: 'customerName', label: 'Customer' },
                    { key: 'subLabel', label: 'Subscription' },
                    { key: 'category', label: 'Category', getValue: (r) => categoryLabel(r.category) },
                    { key: 'priorAmount', label: 'Prior $' },
                    { key: 'currentAmount', label: 'Current $' },
                    { key: 'delta', label: 'Δ' },
                    { key: 'expectedByDay', label: 'Expected day', getValue: (r) => r.expectedByDay ?? '' },
                    { key: 'daysOverdue', label: 'Days overdue', getValue: (r) => r.daysOverdue ?? '' },
                    { key: 'noAttempt', label: 'No Stripe attempt', getValue: (r) => (r.noAttempt ? 'yes' : '') },
                    { key: 'stripeIds', label: 'Stripe customer ID', getValue: (r) => r.stripeIds?.[0] ?? '' },
                  ]}
                  rows={subscriptionView.detail.filter((r) => activeCategories.has(r.category))}
                />
              )}
            </Stack>

            <Collapse in={varianceTable.open} unmountOnExit>
            {!subscriptionView ? (
              <Skeleton variant="rectangular" height={240} />
            ) : (
              <>
                {/* Total variance headline + 5-card category breakdown.
                    Each category card doubles as a filter toggle for the table below.
                    Replaces the old amber reconciliation strip + separate chip row. */}
                <Box sx={{ mb: 2.5, p: 2.5, bgcolor: 'rgba(255, 255, 255, 0.03)', border: '1px solid', borderColor: 'rgba(255,255,255,0.08)', borderRadius: 1.5 }}>
                  <Stack direction="row" spacing={2} alignItems="baseline" justifyContent="space-between" sx={{ mb: 2 }}>
                    <Box>
                      <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 11 }}>
                        Total variance vs {monthLabel(view.prior)}
                      </Typography>
                      <Stack direction="row" spacing={1.5} alignItems="baseline" sx={{ mt: 0.25 }}>
                        <Typography variant="h4" sx={{ fontWeight: 600, color: subscriptionView.varianceAbs < 0 ? '#E53E3E' : subscriptionView.varianceAbs > 0 ? '#1A9E5C' : 'text.primary', fontVariantNumeric: 'tabular-nums' }}>
                          {subscriptionView.varianceAbs > 0 ? '+' : ''}{USD0.format(subscriptionView.varianceAbs)}
                        </Typography>
                        <Typography variant="h6" sx={{ fontWeight: 500, color: 'text.secondary', fontVariantNumeric: 'tabular-nums' }}>
                          {fmtPct(subscriptionView.variancePct)}
                        </Typography>
                      </Stack>
                    </Box>
                    <Typography variant="body2" sx={{ color: 'text.secondary', textAlign: 'right' }}>
                      {subscriptionView.postedSubs.toLocaleString()} subs billed · {subscriptionView.overdueSubs.toLocaleString()} overdue
                      <br />
                      <Box component="span" sx={{ fontSize: 11 }}>Click any card to filter the table</Box>
                    </Typography>
                  </Stack>
                  <Grid container spacing={1.5}>
                    <VarianceCard label="New" count={subscriptionView.counts.new_sub} sum={subscriptionView.sums.new_sub} variance={subscriptionView.varianceAbs} accent="#2C73FF" active={activeCategories.has('new_sub')} onClick={() => toggleCategory('new_sub')} />
                    <VarianceCard label="Reactivated" count={subscriptionView.counts.reactivated} sum={subscriptionView.sums.reactivated} variance={subscriptionView.varianceAbs} accent="#9F7AEA" active={activeCategories.has('reactivated')} onClick={() => toggleCategory('reactivated')} />
                    <VarianceCard label="Reconnected" count={subscriptionView.counts.reconnected} sum={subscriptionView.sums.reconnected} variance={subscriptionView.varianceAbs} accent="#14B8A6" active={activeCategories.has('reconnected')} onClick={() => toggleCategory('reconnected')} />
                    <VarianceCard label="Billing timing" count={subscriptionView.counts.billing_timing} sum={subscriptionView.sums.billing_timing} variance={subscriptionView.varianceAbs} accent="#8B949E" active={activeCategories.has('billing_timing')} onClick={() => toggleCategory('billing_timing')} />
                    <VarianceCard label="Expansion" count={subscriptionView.counts.expanded} sum={subscriptionView.sums.expanded} variance={subscriptionView.varianceAbs} accent="#1A9E5C" active={activeCategories.has('expanded')} onClick={() => toggleCategory('expanded')} />
                    <VarianceCard label="Contraction" count={subscriptionView.counts.contracted} sum={subscriptionView.sums.contracted} variance={subscriptionView.varianceAbs} accent="#E53E3E" active={activeCategories.has('contracted')} onClick={() => toggleCategory('contracted')} />
                    <VarianceCard label="Overdue" count={subscriptionView.counts.overdue} sum={subscriptionView.sums.overdue} variance={subscriptionView.varianceAbs} accent="#F5A623" active={activeCategories.has('overdue')} onClick={() => toggleCategory('overdue')} />
                    <VarianceCard label="Cancelled" count={subscriptionView.counts.cancelled} sum={subscriptionView.sums.cancelled} variance={subscriptionView.varianceAbs} accent="#8B949E" active={activeCategories.has('cancelled')} onClick={() => toggleCategory('cancelled')} />
                  </Grid>
                </Box>

                {/* Per-subscription table — when 2+ chips are active, rows are grouped by category.
                    Each row represents one subscription; a customer with multiple subs has
                    multiple rows. */}
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Customer</TableCell>
                      <TableCell>Subscription</TableCell>
                      <TableCell>Category</TableCell>
                      <TableCell align="right">Prior $</TableCell>
                      <TableCell align="right">Current $</TableCell>
                      <TableCell align="right">Δ</TableCell>
                      <TableCell>Notes</TableCell>
                      <TableCell align="right">Stripe</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {(() => {
                      const visibleRows = subscriptionView.detail.filter((r) => activeCategories.has(r.category));
                      if (visibleRows.length === 0) {
                        return (
                          <TableRow>
                            <TableCell colSpan={8} sx={{ color: 'text.secondary', textAlign: 'center', py: 3 }}>
                              {activeCategories.size === 0
                                ? 'No filters active. Click a chip above to show rows.'
                                : 'No rows match the active filters.'}
                            </TableCell>
                          </TableRow>
                        );
                      }

                      const renderRow = (r: typeof visibleRows[number]) => {
                        const deltaColor = r.delta < 0 ? '#E53E3E' : r.delta > 0 ? '#1A9E5C' : '#8B949E';
                        const sign = r.delta > 0 ? '+' : '';
                        const stripeId = r.stripeIds[0];
                        return (
                          <TableRow key={`row-${r.rowKey}`}>
                            <TableCell>
                              <CustomerLink id={r.customerId} name={r.customerName} />
                            </TableCell>
                            <TableCell sx={{ color: 'text.secondary', fontVariantNumeric: 'tabular-nums' }}>{r.subLabel}</TableCell>
                            <TableCell>
                              <Chip label={categoryLabel(r.category)} size="small" color={categoryChipColor(r.category)} variant="outlined" />
                            </TableCell>
                            <TableCell align="right">{r.priorAmount > 0 ? USD0.format(r.priorAmount) : '—'}</TableCell>
                            <TableCell align="right">{r.currentAmount > 0 ? USD0.format(r.currentAmount) : '—'}</TableCell>
                            <TableCell align="right" sx={{ color: deltaColor, fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>
                              {sign}{USD0.format(r.delta)}
                            </TableCell>
                            <TableCell sx={{ color: 'text.secondary' }}>
                              {r.category === 'overdue' && r.expectedByDay != null
                                ? `expected day ${r.expectedByDay} · ${r.daysOverdue}d overdue${r.noAttempt ? ' · no Stripe attempt yet — not yet synced?' : ''}`
                                : ''}
                            </TableCell>
                            <TableCell align="right">
                              {stripeId ? (
                                <Link
                                  href={`https://dashboard.stripe.com/customers/${stripeId}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  underline="hover"
                                  sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, fontSize: 12 }}
                                >
                                  Open
                                  <OpenInNewIcon sx={{ fontSize: 14 }} />
                                </Link>
                              ) : (
                                <Typography variant="caption" sx={{ color: 'text.secondary' }}>—</Typography>
                              )}
                            </TableCell>
                          </TableRow>
                        );
                      };

                      // Single chip → flat list, already sorted by delta ascending.
                      if (activeCategories.size <= 1) {
                        return visibleRows.map(renderRow);
                      }

                      // Multi-chip → group by category, in chip-strip order:
                      // New logos → Reactivated → Expanded → Contracted → Overdue.
                      // Headers span the full row with a left accent stripe so they
                      // can't be mistaken for data rows.
                      const groupOrder: VarianceCategory[] = ['new_sub', 'reactivated', 'reconnected', 'billing_timing', 'expanded', 'contracted', 'overdue', 'cancelled'];
                      const accentColors: Record<VarianceCategory, string> = {
                        new_sub: '#2C73FF',
                        reactivated: '#9F7AEA',
                        reconnected: '#14B8A6',
                        billing_timing: '#8B949E',
                        expanded: '#1A9E5C',
                        contracted: '#E53E3E',
                        overdue: '#F5A623',
                        cancelled: '#8B949E',
                      };
                      const elements: React.ReactNode[] = [];
                      for (const cat of groupOrder) {
                        if (!activeCategories.has(cat)) continue;
                        const rows = visibleRows.filter((r) => r.category === cat);
                        if (rows.length === 0) continue;
                        const sum = rows.reduce((s, r) => s + r.delta, 0);
                        const sign = sum > 0 ? '+' : '';
                        elements.push(
                          <TableRow
                            key={`hdr-${cat}`}
                            sx={{
                              bgcolor: 'rgba(255,255,255,0.06)',
                              '& > td': { borderBottom: 'none' },
                            }}
                          >
                            <TableCell
                              colSpan={8}
                              sx={{
                                py: 1.25,
                                borderLeft: `3px solid ${accentColors[cat]}`,
                                pl: 2,
                              }}
                            >
                              <Stack direction="row" justifyContent="space-between" alignItems="center">
                                <Typography variant="caption" sx={{ textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 700, fontSize: 11, color: 'text.primary' }}>
                                  {categoryLabel(cat)} <Box component="span" sx={{ color: 'text.secondary', fontWeight: 500 }}>· {rows.length} {rows.length === 1 ? 'subscription' : 'subscriptions'}</Box>
                                </Typography>
                                <Typography variant="caption" sx={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700, fontSize: 11, color: 'text.primary' }}>
                                  {sign}{USD0.format(sum)}
                                </Typography>
                              </Stack>
                            </TableCell>
                          </TableRow>
                        );
                        for (const r of rows) elements.push(renderRow(r));
                      }
                      return elements;
                    })()}
                  </TableBody>
                </Table>
              </>
            )}
            </Collapse>
          </Paper>
        </Grid>

        {subscriptionView && subscriptionView.upcoming.length > 0 && (
          <Grid item xs={12}>
            <Paper sx={{ p: 2.5 }}>
              <Stack direction="row" justifyContent="space-between" alignItems="flex-start" sx={{ mb: 0.5 }} flexWrap="wrap" gap={1}>
                <Typography variant="h6">Upcoming expected subscription payments</Typography>
                <Typography variant="subtitle1" sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                  {USD0.format(subscriptionView.expectedDollars)} from {subscriptionView.expectedSubs}
                </Typography>
              </Stack>
              <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>
                The subscriptions that billed in {monthLabel(view.prior)} but haven't billed yet this month and whose billing day hasn't arrived — the
                line items behind the <em>"{USD0.format(subscriptionView.expectedDollars)} expected from {subscriptionView.expectedSubs}"</em> in Subscription MRR above.
                Active accounts only — paused, at-risk, non-payment, and cancelled subscriptions are excluded (they don't count toward the projection).
              </Typography>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Customer</TableCell>
                    <TableCell align="right">Expected amount</TableCell>
                    <TableCell align="center">Bills on</TableCell>
                    <TableCell align="right">Last billed</TableCell>
                    <TableCell>Notes</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {subscriptionView.upcoming.map((u) => {
                    const inDays = u.expectedDay - view.elapsed;
                    return (
                      <TableRow key={u.rowKey} hover>
                        <TableCell>
                          <CustomerLink id={u.customerId} name={u.customerName} />
                        </TableCell>
                        <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{USD0.format(u.amount)}</TableCell>
                        <TableCell align="center" sx={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                          day {u.expectedDay}
                          <Typography component="span" variant="caption" sx={{ color: 'text.secondary', ml: 0.75 }}>
                            {inDays > 0 ? `(in ${inDays}d)` : '(due)'}
                          </Typography>
                        </TableCell>
                        <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', color: 'text.secondary' }}>{u.lastBilledMonth}</TableCell>
                        <TableCell>
                          <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
                            {u.attempting && <Chip size="small" color="warning" variant="outlined" label="Stripe attempting" />}
                            {u.payStatus && u.payStatus !== 'Active' && <Chip size="small" variant="outlined" label={u.payStatus} />}
                          </Stack>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  <TableRow sx={{ '& > td': { borderBottom: 'none', fontWeight: 700, pt: 1.5 } }}>
                    <TableCell>Total expected</TableCell>
                    <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{USD0.format(subscriptionView.expectedDollars)}</TableCell>
                    <TableCell colSpan={3} sx={{ color: 'text.secondary', fontWeight: 500 }}>
                      {subscriptionView.expectedSubs} subscription{subscriptionView.expectedSubs === 1 ? '' : 's'} still expected this month
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </Paper>
          </Grid>
        )}

      </Grid>
    </Box>
  );
}

type CategoryKey = 'overdue' | 'cancelled' | 'contracted' | 'expanded' | 'new_sub' | 'reactivated' | 'reconnected' | 'billing_timing';
type ChipColor = 'warning' | 'error' | 'success' | 'info' | 'secondary' | 'primary' | 'default';
function categoryLabel(c: CategoryKey): string {
  switch (c) {
    case 'overdue': return 'Overdue';
    case 'cancelled': return 'Cancelled';
    case 'contracted': return 'Contraction';
    case 'expanded': return 'Expansion';
    case 'new_sub': return 'New';
    case 'reactivated': return 'Reactivated';
    case 'reconnected': return 'Reconnected';
    case 'billing_timing': return 'Billing timing';
  }
}
function categoryChipColor(c: CategoryKey): ChipColor {
  switch (c) {
    case 'overdue': return 'warning';
    case 'cancelled': return 'default';
    case 'contracted': return 'error';
    case 'expanded': return 'success';
    case 'new_sub': return 'info';
    case 'reactivated': return 'secondary';
    case 'reconnected': return 'primary';
    case 'billing_timing': return 'default';
  }
}
function VarianceCard({
  label, count, sum, variance, accent, active, onClick,
}: {
  label: string;
  count: number;
  sum: number;
  variance: number;
  accent: string;
  active: boolean;
  onClick: () => void;
}) {
  const sign = sum > 0 ? '+' : '';
  // Share of *absolute total variance*: how much of the gross movement does this
  // category represent? Useful when the variance is small but one category is
  // doing all the work (e.g., new logos +$10K offset by churn -$10K).
  const grossTotal = Math.abs(variance);
  const shareOfTotal = grossTotal > 0 ? Math.abs(sum) / grossTotal : 0;
  const sumColor = sum < 0 ? '#E53E3E' : sum > 0 ? '#1A9E5C' : 'text.secondary';
  return (
    <Grid item xs={6} sm={4} md={2.4}>
      <Box
        onClick={onClick}
        role="button"
        aria-pressed={active}
        sx={{
          p: 1.5,
          borderRadius: 1,
          cursor: 'pointer',
          border: '1px solid',
          borderLeft: `3px solid ${accent}`,
          borderColor: active ? accent : 'rgba(255,255,255,0.1)',
          bgcolor: active ? `${accent}1F` : 'rgba(255,255,255,0.02)',
          transition: 'all 120ms ease',
          opacity: count === 0 ? 0.45 : 1,
          '&:hover': { bgcolor: active ? `${accent}26` : 'rgba(255,255,255,0.05)', borderColor: accent },
        }}
      >
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 0.5 }}>
          <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5, fontWeight: 600 }}>
            {label}
          </Typography>
          <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: 10 }}>
            {count}
          </Typography>
        </Stack>
        <Typography variant="h6" sx={{ fontWeight: 600, color: sumColor, fontVariantNumeric: 'tabular-nums', lineHeight: 1.2 }}>
          {count === 0 ? '—' : `${sign}${USD0.format(sum)}`}
        </Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', fontSize: 10.5, mt: 0.25 }}>
          {count === 0 ? 'no rows' : `${count} ${count === 1 ? 'sub' : 'subs'} · ${(shareOfTotal * 100).toFixed(0)}% of |Δ|`}
        </Typography>
      </Box>
    </Grid>
  );
}

function KPICard({
  label, value, valueHint, sub, delta, deltaLabel, projectionCaveat, info,
}: {
  label: string;
  value: string;
  valueHint?: string;
  sub: string;
  delta?: number | null;
  deltaLabel?: string;
  projectionCaveat?: string;
  info?: React.ReactNode;
}) {
  const deltaColor = delta == null ? 'text.secondary' : delta >= 0 ? 'success.main' : 'error.main';
  return (
    <Paper sx={{ p: 2.5, height: '100%' }}>
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" sx={{ mb: 1 }}>
        <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>
          {label}
        </Typography>
        {info && <InfoIcon info={info} />}
      </Stack>
      <Typography variant="h4" sx={{ fontWeight: 500, mb: valueHint ? 0 : 0.5 }}>{value}</Typography>
      {valueHint && (
        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mb: 0.5, fontStyle: 'italic' }}>
          {valueHint}
        </Typography>
      )}
      <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1 }}>{sub}</Typography>
      {projectionCaveat && (
        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mb: 0.5, fontStyle: 'italic' }}>
          based on {projectionCaveat}
        </Typography>
      )}
      {delta != null && deltaLabel && (
        <Typography variant="caption" sx={{ color: deltaColor }}>
          {fmtPct(delta)} {deltaLabel}
        </Typography>
      )}
    </Paper>
  );
}
