import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RTooltip,
} from 'recharts';
import InfoIcon from './InfoIcon';

// Shared row + trend point shapes — kept narrow so this component is reusable.
// Pages that load the renewal_management snapshot pass a row directly; the
// type is intentionally a subset of the full snapshot row.
export type RenewalTrendPoint = {
  month: string;
  subscription: number;
  orders_dollars: number;
  cost_ratio_pct: number | null;
};

export type RenewalQuote = {
  id: string;
  title: string | null;
  status: string | null; // 'DRAFT' | 'APPROVAL_NOT_NEEDED' | ...
  amount: number | null;
  currency: string;
  created_date: string | null;
  expiration_date: string | null;
  last_modified_date: string | null;
  quote_number: string | null;
  payment_status: string | null;
  hubspot_url: string;
};

export type RenewalPanelRow = {
  renewal_date: string | null;
  days_to_renewal: number | null;
  contract_status: string | null;
  contract_length_months: number | null;
  monthly_flat_fee_hubspot: number | null;
  current_mrr: number;
  arr_up_for_renewal: number;
  last_renewal_expansion: string | null;
  last_no_expansion_reason: string | null;
  action_tag: string;
  action_reason: string;
  lifetime_subscription: number;
  lifetime_orders_dollars: number;
  cost_ratio_lifetime_pct: number | null;
  cost_ratio_annualized_pct: number | null;
  orders_monthly_avg_current_year: number;
  orders_monthly_avg_prior_year: number;
  monthly_trend: RenewalTrendPoint[];
  dropoff_pct: number | null;
  cs_pulse: string | null;
  implementation_status: string | null;
  pay_status: string;
  vip_legacy: string | null;
  quotes?: RenewalQuote[];
  // Proposed renewal pricing. 'growth' = orders-growth Expansion Opportunity;
  // 'underpriced' = healthy/in-contract account below the value-based target ratio
  // (orders flat) — surfaced on the customer panel only, not the page.
  proposed_mrr?: number | null;
  proposed_arr?: number | null;
  proposed_uplift_pct?: number | null;
  proposed_basis?: 'growth' | 'underpriced' | null;
  expansion_rationale?: string | null;
  expansion_confidence?: 'high' | 'low' | null;
  current_arr?: number;
};

const USD0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

const ACTION_COLOR: Record<string, string> = {
  'Expansion Opportunity': '#1A9E5C',
  'Contraction Risk': '#D63A4D',
  Watch: '#F5A623',
  Stable: '#8B949E',
  Paused: '#2C73FF',
};

// Two-column panel: cost-ratio monthly trend on the left, renewal context
// table on the right. Used as the expansion-row content on the Renewal
// Management page AND as a standalone collapsible section on Customer Detail.
export default function RenewalPanelContent({ row, hideQuotes = false, showUnderpriced = false }: { row: RenewalPanelRow; hideQuotes?: boolean; showUnderpriced?: boolean }) {
  const dropoffWorse = row.dropoff_pct != null && row.dropoff_pct >= 0.25;
  const dropoffBetter = row.dropoff_pct != null && row.dropoff_pct <= -0.25;
  // Show the proposed-price callout for tagged expansions everywhere; for
  // underpriced (orders-flat) accounts only where the caller opts in (the
  // customer panel), so Renewal Management page stays growth-expansion only.
  const isUnderpriced = row.proposed_basis === 'underpriced';
  const showProposed = row.proposed_mrr != null &&
    (row.action_tag === 'Expansion Opportunity' || (showUnderpriced && isUnderpriced));
  return (
    <Grid container spacing={2} alignItems="stretch">
      {/* Proposed renewal price — full-width callout so the rep sees a ready
          number without doing the math. */}
      {showProposed && (
        <Grid item xs={12}>
          <Box sx={{ p: 1.5, borderRadius: 1, border: '1px solid', borderColor: 'rgba(26,158,92,0.4)', bgcolor: 'rgba(26,158,92,0.08)' }}>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }} flexWrap="wrap" useFlexGap>
              <Typography variant="caption" sx={{ color: '#1A9E5C', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10, fontWeight: 700 }}>Proposed renewal price</Typography>
              <InfoIcon info="Suggested new price. Logic: realign the cost ratio (subscription ÷ verified orders) to the higher of this customer's lifetime ratio or the base median, applied to their current order run-rate — then cap the increase at +15% per renewal. A starting point, not a mandate; adjust as needed." />
              {isUnderpriced && <Chip label="underpriced vs peers" size="small" sx={{ height: 16, fontSize: 9, bgcolor: 'rgba(26,158,92,0.18)', color: '#1A9E5C' }} />}
              {row.expansion_confidence === 'low' && <Chip label="low confidence" size="small" sx={{ height: 16, fontSize: 9, bgcolor: 'rgba(245,166,35,0.18)', color: '#B07206' }} />}
            </Stack>
            <Stack direction="row" spacing={3} alignItems="baseline" flexWrap="wrap" useFlexGap>
              <Box>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>MRR</Typography>
                <Typography variant="h6" sx={{ fontWeight: 600 }}>
                  {USD0.format(row.current_mrr)} <Box component="span" sx={{ color: 'text.secondary', fontWeight: 400 }}>→</Box> <Box component="span" sx={{ color: '#1A9E5C' }}>{USD0.format(row.proposed_mrr ?? 0)}</Box>
                  {row.proposed_uplift_pct != null && <Box component="span" sx={{ fontSize: 12, color: '#1A9E5C', ml: 0.5 }}>({row.proposed_uplift_pct >= 0 ? '+' : ''}{row.proposed_uplift_pct}%)</Box>}
                </Typography>
              </Box>
              {row.proposed_arr != null && (
                <Box>
                  <Typography variant="caption" sx={{ color: 'text.secondary' }}>ARR</Typography>
                  <Typography variant="h6" sx={{ fontWeight: 600 }}>
                    {USD0.format(row.current_arr ?? row.arr_up_for_renewal ?? 0)} <Box component="span" sx={{ color: 'text.secondary', fontWeight: 400 }}>→</Box> <Box component="span" sx={{ color: '#1A9E5C' }}>{USD0.format(row.proposed_arr ?? 0)}</Box>
                  </Typography>
                </Box>
              )}
            </Stack>
            {row.expansion_rationale && (
              <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 0.5 }}>{row.expansion_rationale}</Typography>
            )}
          </Box>
        </Grid>
      )}
      <Grid item xs={12} md={5} sx={{ display: 'flex' }}>
        {/* Stretch the cost-ratio chart to fill the column height so it
            visually balances the renewal-context table on the right and no
            dead space sits below either. A minHeight keeps the chart legible
            when the right column is short. */}
        <Box sx={{ display: 'flex', flexDirection: 'column', width: '100%' }}>
          <Stack direction="row" spacing={0.5} alignItems="center">
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10 }}>Cost ratio · monthly trend</Typography>
            <InfoIcon info="Per-month cost ratio = (subscription $ / orders verified $) × 100. Lower is better. Only complete months are shown — the current partial month is excluded so we don't false-flag a contraction. A rising line means orders are falling faster than subscription." />
          </Stack>
          {row.monthly_trend.length === 0 ? (
            <Typography variant="body2" sx={{ color: 'text.disabled', py: 2 }}>No monthly history</Typography>
          ) : (
            <Box sx={{ flex: 1, minHeight: 160, mt: 1 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={row.monthly_trend} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(139,148,158,0.12)" vertical={false} />
                  <XAxis dataKey="month" stroke="#8B949E" fontSize={10} interval={3} />
                  <YAxis stroke="#8B949E" fontSize={10} width={40} tickFormatter={(v) => `${Number(v).toFixed(1)}%`} />
                  <RTooltip
                    formatter={(v: number) => `${Number(v).toFixed(2)}%`}
                    contentStyle={{ background: '#161B22', border: '1px solid #21262D', borderRadius: 6, color: '#FFFFFF' }}
                    labelStyle={{ color: '#FFFFFF' }}
                    itemStyle={{ color: '#FFFFFF' }}
                  />
                  <Line type="monotone" dataKey="cost_ratio_pct" stroke="#2C73FF" strokeWidth={2} dot={{ r: 2 }} connectNulls />
                </LineChart>
              </ResponsiveContainer>
            </Box>
          )}
        </Box>
      </Grid>
      <Grid item xs={12} md={7}>
        <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10 }}>Renewal Context</Typography>
        <Box component="table" sx={{ width: '100%', borderCollapse: 'collapse', mt: 1, '& td': { py: 0.5, fontSize: 12, verticalAlign: 'top' } }}>
          <tbody>
            <tr>
              <td style={{ color: '#6B7280', width: '38%' }}>Renewal date</td>
              <td>
                {row.renewal_date ? (
                  <>
                    <strong>{row.renewal_date}</strong>
                    {row.days_to_renewal != null && (
                      <Typography component="span" variant="caption" sx={{ ml: 0.75, color: 'text.secondary' }}>
                        {row.days_to_renewal >= 0 ? `in ${row.days_to_renewal}d` : `${Math.abs(row.days_to_renewal)}d ago`}
                      </Typography>
                    )}
                  </>
                ) : <Typography component="span" variant="caption" sx={{ color: 'text.disabled', fontStyle: 'italic' }}>not set in HubSpot</Typography>}
              </td>
            </tr>
            <tr>
              <td style={{ color: '#6B7280' }}>Contract</td>
              <td>{row.contract_status || '—'}{row.contract_length_months ? ` · ${row.contract_length_months} mo term` : ''}</td>
            </tr>
            <tr>
              <td style={{ color: '#6B7280' }}>ARR up for renewal</td>
              <td>{USD0.format(row.arr_up_for_renewal)}</td>
            </tr>
            <tr>
              <td style={{ color: '#6B7280' }}>HubSpot monthly fee</td>
              <td>
                {row.monthly_flat_fee_hubspot != null ? USD0.format(row.monthly_flat_fee_hubspot) : '—'}
                <Typography component="span" variant="caption" sx={{ color: 'text.disabled', ml: 0.5 }}>(Stripe MRR: {USD0.format(row.current_mrr)})</Typography>
              </td>
            </tr>
            <tr>
              <td style={{ color: '#6B7280' }}>Cost ratio · lifetime</td>
              <td>
                <strong style={{ color: '#2C73FF' }}>{row.cost_ratio_lifetime_pct != null ? `${row.cost_ratio_lifetime_pct.toFixed(2)}%` : '—'}</strong>
                <Typography component="span" variant="caption" sx={{ color: 'text.secondary', ml: 0.75 }}>
                  ({USD0.format(row.lifetime_subscription)} paid / {USD0.format(row.lifetime_orders_dollars)} verified)
                </Typography>
              </td>
            </tr>
            <tr>
              <td style={{ color: '#6B7280' }}>Cost ratio · annualized</td>
              <td>
                <strong style={{ color: '#2C73FF' }}>{row.cost_ratio_annualized_pct != null ? `${row.cost_ratio_annualized_pct.toFixed(2)}%` : '—'}</strong>
                <Typography component="span" variant="caption" sx={{ color: 'text.secondary', ml: 0.75 }}>
                  ({USD0.format(row.orders_monthly_avg_current_year)}/mo now vs {USD0.format(row.orders_monthly_avg_prior_year)}/mo prior year)
                </Typography>
              </td>
            </tr>
            {row.dropoff_pct != null && (
              <tr>
                <td style={{ color: '#6B7280' }}>Recent 3mo cost ratio vs trailing 9mo</td>
                <td style={{ color: dropoffWorse ? '#F59E0B' : undefined }}>
                  {row.dropoff_pct >= 0 ? '+' : ''}{Math.round(row.dropoff_pct * 100)}%
                  {dropoffWorse && ' (worse — orders falling)'}
                  {dropoffBetter && ' (better — orders growing)'}
                </td>
              </tr>
            )}
            <tr>
              <td style={{ color: '#6B7280' }}>Last renewal expansion</td>
              <td>
                {row.last_renewal_expansion || '—'}
                {row.last_no_expansion_reason && (
                  <Typography component="div" variant="caption" sx={{ color: 'text.secondary' }}>reason: {row.last_no_expansion_reason}</Typography>
                )}
              </td>
            </tr>
            <tr>
              <td style={{ color: '#6B7280' }}>Action</td>
              <td>
                <Chip
                  label={row.action_tag}
                  size="small"
                  sx={{ height: 20, fontSize: 10.5, bgcolor: (ACTION_COLOR[row.action_tag] ?? '#8B949E') + '22', color: ACTION_COLOR[row.action_tag] ?? '#8B949E', fontWeight: 600, mr: 0.5 }}
                />
                <Typography component="span" variant="caption" sx={{ color: 'text.secondary' }}>{row.action_reason}</Typography>
              </td>
            </tr>
            {row.cs_pulse && (
              <tr><td style={{ color: '#6B7280' }}>CS Pulse</td><td>{row.cs_pulse}</td></tr>
            )}
            {row.implementation_status && (
              <tr><td style={{ color: '#6B7280' }}>Implementation</td><td>{row.implementation_status}</td></tr>
            )}
            <tr><td style={{ color: '#6B7280' }}>Pay status</td><td>{row.pay_status}{row.vip_legacy === 'Yes' && <Chip label="VIP" size="small" sx={{ ml: 0.5, height: 16, fontSize: 9, bgcolor: 'rgba(44, 115, 255, 0.18)', color: 'primary.main' }} />}</td></tr>
          </tbody>
        </Box>
      </Grid>

      {/* Quotes — full-width section spanning both columns, below the chart
          and context table. Lists every quote attached to this customer's
          HubSpot Company association(s), newest first. */}
      {!hideQuotes && (row.quotes?.length ?? 0) > 0 && (
        <Grid item xs={12}>
          <Stack direction="row" spacing={0.5} alignItems="center" sx={{ mb: 0.5 }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10, fontWeight: 600 }}>
              Quotes ({row.quotes!.length})
            </Typography>
            <InfoIcon info="Every HubSpot Quote attached to this customer's Company. Click 'Open in HubSpot' to jump to the quote. Status comes from HubSpot's workflow — APPROVAL_NOT_NEEDED is HubSpot's term for 'sent/active', DRAFT is in-progress." />
          </Stack>
          <Box component="table" sx={{ width: '100%', borderCollapse: 'collapse', '& th, & td': { py: 0.5, fontSize: 12, textAlign: 'left', borderBottom: '1px solid', borderColor: 'divider' }, '& th': { fontWeight: 600, color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.04em', fontSize: 10 } }}>
            <thead>
              <tr>
                <th>Title</th>
                <th>Status</th>
                <th style={{ textAlign: 'right' }}>Amount</th>
                <th>Created</th>
                <th>Expires</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {row.quotes!.map((q) => (
                <tr key={q.id}>
                  <td style={{ fontWeight: 500 }}>{q.title || '(untitled)'}</td>
                  <td>
                    <Chip
                      label={q.status === 'APPROVAL_NOT_NEEDED' ? 'SENT' : (q.status || '—')}
                      size="small"
                      sx={{
                        height: 18,
                        fontSize: 10,
                        bgcolor: q.status === 'DRAFT' ? 'rgba(245, 166, 35, 0.18)' : q.status === 'APPROVAL_NOT_NEEDED' ? 'rgba(26, 158, 92, 0.18)' : 'rgba(139, 148, 158, 0.18)',
                        color: q.status === 'DRAFT' ? '#B07206' : q.status === 'APPROVAL_NOT_NEEDED' ? '#1A9E5C' : '#475569',
                        fontWeight: 600,
                      }}
                    />
                  </td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    {q.amount != null ? `${q.currency === 'USD' ? '$' : (q.currency + ' ')}${Math.round(q.amount).toLocaleString()}` : '—'}
                  </td>
                  <td style={{ color: '#6B7280' }}>{q.created_date ? q.created_date.slice(0, 10) : '—'}</td>
                  <td style={{ color: '#6B7280' }}>{q.expiration_date ? q.expiration_date.slice(0, 10) : '—'}</td>
                  <td style={{ textAlign: 'right' }}>
                    <Box
                      component="a"
                      href={q.hubspot_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      sx={{ fontSize: 11, color: 'primary.light', textDecoration: 'none', '&:hover': { textDecoration: 'underline' } }}
                    >
                      Open in HubSpot ↗
                    </Box>
                  </td>
                </tr>
              ))}
            </tbody>
          </Box>
        </Grid>
      )}
    </Grid>
  );
}
