import { useMemo } from 'react';
import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Skeleton from '@mui/material/Skeleton';
import Chip from '@mui/material/Chip';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip, Legend, ReferenceLine } from 'recharts';

import InfoIcon from './InfoIcon';
import { useSheetTab } from '../../hooks/useSheetTab';

type MrrRow = { month: string; mrr_subscription: number | null; mrr_services: number | null; mrr_connect: number | null };
type CurrentMonth = {
  month: string; day_of_month: number; days_in_month: number; elapsed_pct: number;
  mrr: { billed_so_far: number; still_to_bill: number; expected_ending: number };
};

const USD0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
function monthLabel(m: string) {
  const [y, mo] = m.split('-').map(Number);
  return new Date(y, mo - 1, 1).toLocaleString('en-US', { month: 'short', year: '2-digit' });
}

export default function MonthPaceChart() {
  const { data: mrrData, isLoading } = useSheetTab<MrrRow>('mrr_by_month');
  const { data: cmData } = useSheetTab('current_month');
  const cm = cmData as unknown as CurrentMonth | undefined;

  const { rows, projected, actualSoFar, priorAvg } = useMemo(() => {
    const all = (mrrData?.rows ?? []) as MrrRow[];
    if (!all.length || !cm) return { rows: [], projected: 0, actualSoFar: 0, priorAvg: 0 };
    const cur = cm.month;
    const window = all.filter((r) => r.month <= cur).slice(-13);

    const out = window.map((r) => {
      const sub = r.mrr_subscription || 0;
      const svc = r.mrr_services || 0;
      const con = r.mrr_connect || 0;
      if (r.month !== cur) {
        return { month: monthLabel(r.month), actual: Math.round(sub + svc + con), remaining: 0, isCurrent: false };
      }
      // SUBSCRIPTION IS NOT PACED. Billing dates cluster early in the month, so at 73%
      // elapsed roughly 88% of subscription has already billed — a linear projection
      // reads $275,507 against a real $226,987, overstating by $48,520. The accrual
      // build already knows what is still scheduled to bill, so use that.
      const subEom = cm.mrr.expected_ending;
      // Services and Connect ARE transaction-driven and accrue through the month, so a
      // pace projection is the right estimator for those two.
      const elapsed = cm.elapsed_pct > 0 ? cm.elapsed_pct : 1;
      const svcEom = svc / elapsed;
      const conEom = con / elapsed;
      const actual = Math.round(sub + svc + con);
      const eom = Math.round(subEom + svcEom + conEom);
      return { month: monthLabel(r.month), actual, remaining: Math.max(0, eom - actual), isCurrent: true };
    });

    const curRow = out.find((r) => r.isCurrent);
    const complete = out.filter((r) => !r.isCurrent);
    return {
      rows: out,
      projected: curRow ? curRow.actual + curRow.remaining : 0,
      actualSoFar: curRow?.actual ?? 0,
      priorAvg: complete.length ? Math.round(complete.slice(-3).reduce((s, r) => s + r.actual, 0) / Math.min(3, complete.length)) : 0,
    };
  }, [mrrData, cm]);

  if (!isLoading && !cm) return null;
  const pace = priorAvg > 0 ? projected / priorAvg - 1 : null;

  return (
    <Paper sx={{ p: 3, mb: 3 }}>
      <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 1.5 }} flexWrap="wrap" useFlexGap>
        <Typography variant="h6" sx={{ fontWeight: 500 }}>Month-end pace</Typography>
        <InfoIcon info={<><strong>Solid</strong> is revenue booked so far this month; the <strong>shaded block on top</strong> is what is still expected, so the current bar can be compared like for like against completed months.<br /><br /><strong>Subscription is not extrapolated.</strong> Billing dates cluster early in the month — at {cm ? Math.round(cm.elapsed_pct * 100) : 0}% elapsed most of it has already billed, so a straight-line projection overstates it badly. The estimate uses what is actually still scheduled to bill.<br /><br /><strong>Services and Connect are paced</strong>, because those accrue through the month with transaction volume rather than landing on a billing date.</>} />
        <Box sx={{ flexGrow: 1 }} />
        {cm && (
          <>
            <Chip size="small" label={`day ${cm.day_of_month} of ${cm.days_in_month}`} sx={{ height: 20, fontSize: 11 }} />
            {pace != null && (
              <Chip
                size="small"
                color={pace >= 0 ? 'success' : 'warning'}
                label={`${pace >= 0 ? '+' : ''}${(pace * 100).toFixed(1)}% vs prior 3-month average`}
                sx={{ height: 20, fontSize: 11 }}
              />
            )}
          </>
        )}
      </Stack>

      {isLoading ? <Skeleton variant="rectangular" height={260} /> : (
        <ResponsiveContainer width="100%" height={280}>
          <BarChart data={rows} margin={{ top: 8, right: 16, bottom: 4, left: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" vertical={false} />
            <XAxis dataKey="month" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
            <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `$${Math.round(Number(v) / 1000)}k`} />
            <RTooltip
              contentStyle={{ background: '#161b22', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6, fontSize: 12, color: '#FFFFFF' }}
              labelStyle={{ color: '#FFFFFF' }}
              itemStyle={{ color: '#FFFFFF' }}
              formatter={(v: number, n: string) => [USD0.format(v), n === 'remaining' ? 'Still expected' : 'Booked so far']}
            />
            <Legend
              wrapperStyle={{ fontSize: 11 }}
              formatter={(v: string) => (v === 'remaining' ? 'Still expected (estimate)' : 'Booked so far')}
            />
            {priorAvg > 0 && (
              <ReferenceLine y={priorAvg} stroke="#8B949E" strokeDasharray="4 4" label={{ value: 'prior 3-mo avg', position: 'insideTopRight', fill: '#8B949E', fontSize: 10 }} />
            )}
            <Bar dataKey="actual" stackId="m" fill="#2C73FF" name="actual" />
            {/* A translucent tint of the same blue was invisible against the dark
                ground. The projected block now uses a distinct hue with a dashed
                outline: different colour so it reads at a glance, dashed so it still
                says "estimate" rather than "booked". */}
            <Bar
              dataKey="remaining"
              stackId="m"
              fill="#D69E2E"
              fillOpacity={0.75}
              stroke="#F0B849"
              strokeWidth={1}
              strokeDasharray="3 2"
              name="remaining"
            />
          </BarChart>
        </ResponsiveContainer>
      )}

      {cm && (
        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 1 }}>
          {monthLabel(cm.month)}: {USD0.format(actualSoFar)} booked · {USD0.format(projected - actualSoFar)} still expected ·
          {' '}<strong>{USD0.format(projected)} estimated month-end</strong>, against a prior three-month average of {USD0.format(priorAvg)}.
        </Typography>
      )}
    </Paper>
  );
}
