/**
 * Unit Economics on the Allmoxy design system. Assembled from the shared certified parts
 * (src/design-system/parts.tsx). Data logic is the classic page's (UnitEconomics.tsx, kept at
 * /unit-economics-classic): same snapshots (unit_economics, mrr_waterfall, services_by_month,
 * connect_volume, customer_base) and the same maths, including today's audit fixes:
 *  - headline NRR / GRR from mrr_waterfall.ttm_accrual; LTV:CAC, payback and logo churn from
 *    unit_economics.ttm; the rolling series supplies only the trend bars and the 6-month change;
 *  - QuickBooks-derived figures (margin, CAC, LTV, payback, operating income) carry their P&L
 *    coverage window and hard-stop where it ends;
 *  - Connect revenue is the canonical TTM (connect_by_month) with gross application fees as a
 *    labelled secondary; customer denominators come from customer_base.
 *
 * UI changes only: line and area charts became column charts (bar values on the bars, exact
 * figures on hover); the four trend panels share one month range; per-stream economics became a
 * table with a Total row; benchmark colours became word-and-tone tags.
 */
import { useMemo, useState } from 'react';
import { useSheetTab } from '../hooks/useSheetTab';
import {
  ChartCard, ColumnChart, CustomerLink, DataTable, DsPage, Icon, KpiCard, KpiGrid, Link, Segmented, SideSheet,
  downloadCsv, mlabel, pct, thisMonth, usd, usdk, useMonthRange,
} from '../design-system/parts';

type WaterfallMonthlyRow = {
  month: string;
  partial?: boolean;
  gross_churn_rate_monthly?: number | null;
  nrr_monthly?: number | null;
  grr_monthly?: number | null;
};
type WaterfallSnap = {
  monthly: WaterfallMonthlyRow[];
  monthly_accrual?: WaterfallMonthlyRow[];
  ttm_accrual?: { windowStart: string; windowEnd: string; annual_nrr: number | null; annual_grr: number | null } | null;
};
type CustomerBaseSnap = {
  customers: number;
  logo_flow?: Array<{ month: string; starting_logos: number; churned_logos: number; lapsed_logos: number }>;
};
type ServicesRow = { customer_name: string } & Record<string, number | null>;
type ServicesSnap = { rows: ServicesRow[] };

type MonthlyRow = {
  month: string;
  subscription_revenue: number;
  services_revenue: number;
  connect_revenue: number;
  total_income: number;
  cogs: number;
  gross_profit: number;
  gross_margin: number | null;
  subscription_gross_margin: number | null;
  snm_expense: number;
  new_logos: number;
  cac: number | null;
  logo_qty: number | null;
  avg_mrr_per_customer: number | null;
  net_op_income: number;
  qb_total_income?: number | null;
};
type UnitEconSnapshot = {
  monthly: MonthlyRow[];
  ttm: {
    windowStart: string; windowEnd: string;
    subscription_revenue: number; services_revenue: number; connect_revenue: number; affiliate_revenue: number;
    total_income: number; cogs: number; gross_profit: number; gross_margin: number | null; subscription_gross_margin: number | null;
    snm_expense: number; new_logos: number; cac: number | null; net_op_income: number;
    pnl_coverage?: { months: number; start: string | null; end: string | null } | null;
    monthly_churn_rate: number | null; annual_churn_rate: number | null;
    annual_logo_churn_rate?: number | null; annual_revenue_churn_rate?: number | null; monthly_revenue_churn_rate?: number | null;
    avg_mrr_per_customer: number | null; logo_qty_latest: number | null;
    ltv: number | null; cac_payback_months: number | null; ltv_cac_ratio: number | null;
  };
  services: { total_customers_ever: number; customers_bought_services: number; attach_rate: number | null; avg_services_revenue_per_attached_customer: number | null };
  connect?: { customers_using_connect: number; active_logos: number | null; attach_rate: number | null; connect_revenue_ttm: number; avg_connect_revenue_per_connect_customer: number | null; avg_monthly_connect_revenue: number };
  notes: string;
};
type ConnectVolume = {
  annualized?: { gross_volume: number; fee_revenue: number; txn_count: number; blended_take_rate: number | null; basis: string };
  attach?: { active_customers: number; active_customers_on_connect: number; attach_rate: number | null; connected_accounts: number };
  penetration?: { processing_now: number; attach_target_fee_potential: number };
  scenarios?: Array<{ take_rate: number; annual_fee_revenue: number; delta_vs_current: number; multiple_vs_current: number | null }>;
};

type TtmRow = {
  month: string;
  cac: number | null; ltv: number | null; ltv_cac_ratio: number | null; cac_payback_months: number | null;
  monthly_revenue_churn_rate: number | null; annual_revenue_churn_rate: number | null; annual_logo_churn_rate: number | null;
  gross_margin: number | null; subscription_gross_margin: number | null; avg_mrr_per_customer: number | null;
  new_logos: number; snm_expense: number;
  subscription_revenue: number; services_revenue: number; connect_revenue: number; total_revenue: number;
  net_op_income: number | null; nrr: number | null; grr: number | null; logos: number | null; pnl_complete: boolean;
};

type Tone = 'success' | 'warning' | 'error' | 'info' | 'neutral';
const mo = (v: number | null) => (v == null ? '—' : `${v.toFixed(1)} mo`);
const ratio = (v: number | null) => (v == null ? '—' : `${v.toFixed(2)}x`);
// Benchmark bands, the classic page's colour rules as a word and a tone.
const band = (v: number | null, good: (x: number) => boolean, ok: (x: number) => boolean): [string, Tone] | [undefined, undefined] =>
  v == null ? [undefined, undefined] : good(v) ? ['On target', 'success'] : ok(v) ? ['Watch', 'warning'] : ['Below target', 'error'];

const TABLE_LIMIT = 24;
const SVC_LIMIT = 25;

type Drill = { kind: 'services' } | { kind: 'streams' } | { kind: 'inputs' };

export default function UnitEconomicsDS() {
  const { data, isLoading, error } = useSheetTab('unit_economics');
  const { data: wfData } = useSheetTab('mrr_waterfall');
  const { data: svcData } = useSheetTab('services_by_month');
  const { data: connectData } = useSheetTab('connect_volume');
  const { data: baseData } = useSheetTab('customer_base');
  const base = baseData as unknown as CustomerBaseSnap | undefined;
  const cv = connectData as unknown as ConnectVolume | undefined;
  const snap = data as unknown as UnitEconSnapshot | undefined;
  const wf = wfData as unknown as WaterfallSnap | undefined;
  const svcSheet = svcData as unknown as ServicesSnap | undefined;
  const ttm = snap?.ttm;
  const svc = snap?.services;

  // ONE Connect processing count (classic): base members processing on Connect over the
  // canonical customer_base count; falls back to the unit_economics TTM count.
  const activeCustomers = base?.customers ?? snap?.connect?.active_logos ?? null;
  const connectProcessing = cv?.attach?.active_customers_on_connect ?? cv?.penetration?.processing_now ?? snap?.connect?.customers_using_connect ?? null;
  const connectAttach = connectProcessing != null && activeCustomers ? connectProcessing / activeCustomers : null;
  const connectRevTtm = snap?.connect?.connect_revenue_ttm ?? snap?.ttm.connect_revenue ?? null;

  const [drill, setDrill] = useState<Drill | null>(null);
  const [streamBasis, setStreamBasis] = useState<'annual' | 'monthly'>('annual');
  const [showAllMonths, setShowAllMonths] = useState(false);
  const [showAllSvc, setShowAllSvc] = useState(false);
  const [svcOrder, setSvcOrder] = useState<number[] | null>(null);

  // ---- per-stream economics (classic, verbatim)
  const currentMonth = thisMonth();
  const streams = useMemo(() => {
    if (!snap?.ttm) return null;
    const t = snap.ttm;
    const total = (t.subscription_revenue || 0) + (t.services_revenue || 0) + (t.connect_revenue || 0);
    const share = (v: number) => (total > 0 ? v / total : 0);
    const cards = [
      {
        key: 'mrr', label: 'Subscription (MRR)', revenue: t.subscription_revenue, share: share(t.subscription_revenue), recurring: true,
        customers: t.logo_qty_latest, customersLabel: 'active customers',
        arpu: t.avg_mrr_per_customer != null ? t.avg_mrr_per_customer * 12 : null, arpuNoun: 'customer', lifetimeArpu: false,
        margin: t.subscription_gross_margin, note: t.logo_qty_latest != null ? 'latest complete month' : null,
      },
      {
        key: 'services', label: 'Services', revenue: t.services_revenue, share: share(t.services_revenue), recurring: false,
        customers: snap.services?.customers_bought_services ?? null, customersLabel: 'ever bought services',
        arpu: snap.services?.avg_services_revenue_per_attached_customer ?? null, arpuNoun: 'attached customer', lifetimeArpu: true,
        margin: null as number | null, note: snap.services?.attach_rate != null ? `${(snap.services.attach_rate * 100).toFixed(0)}% of all customers attach` : null,
      },
      {
        key: 'connect', label: 'Stripe Connect', revenue: t.connect_revenue, share: share(t.connect_revenue), recurring: true,
        customers: connectProcessing, customersLabel: 'processing on Connect',
        arpu: connectProcessing ? t.connect_revenue / connectProcessing : null, arpuNoun: 'processing customer', lifetimeArpu: false,
        margin: null as number | null, note: connectAttach != null ? `${(connectAttach * 100).toFixed(0)}% of ${activeCustomers} active customers process on Connect` : null,
      },
    ];
    const trendRows = snap.monthly
      .filter((m) => m.month < currentMonth && m.subscription_revenue > 0)
      .map((m) => ({ month: m.month, Subscription: m.subscription_revenue, Services: m.services_revenue, Connect: m.connect_revenue }));
    return { cards, total, trendRows };
  }, [snap, connectProcessing, connectAttach, activeCustomers, currentMonth]);

  // ---- rolling trailing-12-month unit economics, anchored at each month (classic, verbatim)
  const monthlyTtm = useMemo(() => {
    if (!snap || snap.monthly.length < 12) return [] as TtmRow[];
    const endMonth = snap.ttm?.windowEnd ?? snap.monthly[snap.monthly.length - 1].month;
    const completeRows = snap.monthly.filter((r) => r.month <= endMonth);
    const wfByMonth = new Map((wf?.monthly ?? []).filter((r) => !r.partial).map((r) => [r.month, r]));
    for (const r of wf?.monthly_accrual ?? []) if (!r.partial) wfByMonth.set(r.month, r);
    const wfMonthly = [...wfByMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
    const flowByMonth = new Map((base?.logo_flow ?? []).filter((f) => f.starting_logos > 0).map((f) => [f.month, f]));
    const out: TtmRow[] = [];
    for (let i = 11; i < completeRows.length; i++) {
      const rows = completeRows.slice(i - 11, i + 1);
      const last = rows[rows.length - 1];
      const sum = (k: keyof MonthlyRow) => rows.reduce((a, r) => a + (typeof r[k] === 'number' ? (r[k] as number) : 0), 0);
      const total_income = sum('total_income');
      const gross_profit = sum('gross_profit');
      const snm_expense = sum('snm_expense');
      const new_logos = sum('new_logos');
      const subscription_revenue = sum('subscription_revenue');
      const services_revenue = sum('services_revenue');
      const connect_revenue = sum('connect_revenue');
      const total_revenue = subscription_revenue + services_revenue + connect_revenue;
      const pnl_complete = rows.every((r) => r.cogs != null);
      const net_op_income = pnl_complete ? sum('net_op_income') : null;
      const retRows = wfMonthly.filter((r) => r.month >= rows[0].month && r.month <= last.month);
      const meanRate = (k: 'nrr_monthly' | 'grr_monthly') =>
        retRows.length === 12 && retRows.every((r) => r[k] != null) ? retRows.reduce((a, r) => a + (r[k] as number), 0) / 12 : null;
      const nrrMean = meanRate('nrr_monthly');
      const grrMean = meanRate('grr_monthly');
      const nrr = nrrMean != null ? Math.pow(nrrMean, 12) : null;
      const grr = grrMean != null ? Math.pow(grrMean, 12) : null;
      const logos = last.logo_qty;
      const qbIncome = rows.every((r) => r.qb_total_income != null) ? sum('qb_total_income') : total_income;
      const gross_margin = pnl_complete && qbIncome > 0 ? gross_profit / qbIncome : null;
      let subGmNum = 0, subGmDen = 0;
      for (const r of rows) {
        if (r.subscription_gross_margin != null && r.subscription_revenue > 0) {
          subGmNum += r.subscription_gross_margin * r.subscription_revenue;
          subGmDen += r.subscription_revenue;
        }
      }
      const subscription_gross_margin = subGmDen > 0 ? subGmNum / subGmDen : null;
      const cac = pnl_complete && new_logos > 0 ? snm_expense / new_logos : null;
      const avg_mrr_per_customer = last.avg_mrr_per_customer;
      const monthlyRevChurn = grrMean != null ? 1 - grrMean : null;
      const annual_revenue_churn_rate = grr != null ? 1 - grr : null;
      const flows = rows.map((r) => flowByMonth.get(r.month));
      const annual_logo_churn_rate = flows.every((f) => f != null)
        ? (() => {
            const lost = flows.reduce((a, f) => a + f!.churned_logos + f!.lapsed_logos, 0);
            const starting = flows.reduce((a, f) => a + f!.starting_logos, 0);
            return starting > 0 ? 1 - Math.pow(1 - lost / starting, 12) : null;
          })()
        : null;
      const ltv = avg_mrr_per_customer != null && subscription_gross_margin != null && monthlyRevChurn != null && monthlyRevChurn > 0
        ? (avg_mrr_per_customer * subscription_gross_margin) / monthlyRevChurn : null;
      const cac_payback_months = cac != null && avg_mrr_per_customer != null && subscription_gross_margin != null && avg_mrr_per_customer * subscription_gross_margin > 0
        ? cac / (avg_mrr_per_customer * subscription_gross_margin) : null;
      const ltv_cac_ratio = ltv != null && cac != null && cac > 0 ? ltv / cac : null;
      out.push({
        month: last.month, cac, ltv, ltv_cac_ratio, cac_payback_months,
        monthly_revenue_churn_rate: monthlyRevChurn, annual_revenue_churn_rate, annual_logo_churn_rate,
        gross_margin, subscription_gross_margin, avg_mrr_per_customer, new_logos, snm_expense,
        subscription_revenue, services_revenue, connect_revenue, total_revenue, net_op_income, nrr, grr, logos, pnl_complete,
      });
    }
    return out;
  }, [snap, wf, base]);

  const latest = monthlyTtm.length ? monthlyTtm[monthlyTtm.length - 1] : null;
  const lastPnlMonth = useMemo(() => {
    for (let i = monthlyTtm.length - 1; i >= 0; i--) if (monthlyTtm[i].pnl_complete) return monthlyTtm[i].month;
    return null;
  }, [monthlyTtm]);
  const pnlEnd = ttm?.pnl_coverage?.end ?? null;
  const pnlThrough = pnlEnd ? `QuickBooks P&L through ${mlabel(pnlEnd)}` : 'QuickBooks P&L pending';

  // Headline value = canonical snapshot; the series supplies the change against 6 anchors earlier.
  const kpiVal = (key: keyof TtmRow): { cur: number | null; prev: number | null; month: string | null } => {
    let ci = -1;
    for (let i = monthlyTtm.length - 1; i >= 0; i--) if (monthlyTtm[i][key] != null) { ci = i; break; }
    if (ci < 0) return { cur: null, prev: null, month: null };
    const cur = monthlyTtm[ci][key] as number;
    const prev = ci - 6 >= 0 ? (monthlyTtm[ci - 6][key] as number | null) : null;
    return { cur, prev, month: monthlyTtm[ci].month };
  };
  const spark = (key: keyof TtmRow) => monthlyTtm.slice(-24).map((r) => r[key]).filter((v): v is number => typeof v === 'number');

  // ---- trend charts share one month range over the anchor months (all complete)
  const range = useMonthRange(monthlyTtm.map((r) => r.month));
  const byAnchor = useMemo(() => new Map(monthlyTtm.map((r) => [r.month, r])), [monthlyTtm]);
  const vis = range.months.map((m) => byAnchor.get(m)!).filter(Boolean);
  const visWith = (pred: (r: TtmRow) => boolean) => vis.filter(pred);
  const retRows = visWith((r) => r.nrr != null && r.grr != null);
  const gmRows = visWith((r) => r.gross_margin != null);
  const noiRows = visWith((r) => r.net_op_income != null);
  const pbRows = visWith((r) => r.cac_payback_months != null);
  const lcRows = visWith((r) => r.ltv_cac_ratio != null);
  const pnlCut = lastPnlMonth ? `stops at ${mlabel(lastPnlMonth)}, the last 12-month window fully covered by the QuickBooks P&L` : 'waits for the QuickBooks P&L';

  const streamRange = useMonthRange((streams?.trendRows ?? []).map((r) => r.month));
  const streamByMonth = useMemo(() => new Map((streams?.trendRows ?? []).map((r) => [r.month, r])), [streams]);
  const streamVis = streamRange.months.map((m) => streamByMonth.get(m)!).filter(Boolean);

  // ---- services customers (classic drill, verbatim)
  const svcRows = useMemo(() => {
    if (!svcSheet) return [];
    return svcSheet.rows
      .map((r) => {
        let lifetime = 0, monthsActive = 0;
        let firstMonth: string | null = null, lastMonth: string | null = null;
        for (const [k, v] of Object.entries(r)) {
          if (k === 'customer_name') continue;
          if (typeof v === 'number' && v > 0) {
            lifetime += v; monthsActive += 1;
            if (firstMonth == null || k < firstMonth) firstMonth = k;
            if (lastMonth == null || k > lastMonth) lastMonth = k;
          }
        }
        return { name: r.customer_name, first: firstMonth, last: lastMonth, months: monthsActive, lifetime: Math.round(lifetime * 100) / 100 };
      })
      .filter((r) => r.lifetime > 0)
      .sort((a, b) => b.lifetime - a.lifetime);
  }, [svcSheet]);

  // ---- CSV (classic "Export full series")
  const exportSeries = () => downloadCsv(
    `unit_economics_monthly_ttm_${latest ? latest.month : 'empty'}`,
    ['Anchor month', 'CAC', 'LTV', 'LTV:CAC', 'CAC payback (months)', 'Monthly gross revenue churn (1 − mean monthly GRR)', 'Annual gross revenue churn (1 − GRR)', 'Annual logo churn (churned + lapsed)', 'Gross margin', 'Subscription gross margin', 'Avg MRR per customer (anchor month)', 'New logos in window', 'S&M spend in window'],
    monthlyTtm.map((r) => [r.month, r.cac ?? '', r.ltv ?? '', r.ltv_cac_ratio ?? '', r.cac_payback_months ?? '', r.monthly_revenue_churn_rate ?? '', r.annual_revenue_churn_rate ?? '', r.annual_logo_churn_rate ?? '', r.gross_margin ?? '', r.subscription_gross_margin ?? '', r.avg_mrr_per_customer ?? '', r.new_logos, r.snm_expense]),
  );

  if (isLoading || !snap || !ttm) {
    return (
      <DsPage path="/unit-economics" title="Unit Economics" subtitle={error ? undefined : 'Loading…'}>
        <p className="am-card__text">{error ? `Could not load unit_economics: ${String(error)}` : 'Loading the unit economics snapshots…'}</p>
      </DsPage>
    );
  }

  // ---- headline KPIs (classic order and sources)
  const kpis: Array<{ label: string; key: keyof TtmRow; headline: number | null | undefined; fmt: (v: number) => string; good: 'up' | 'down'; deltaFmt: (d: number) => string; bench: string; band: (v: number | null) => ReturnType<typeof band> }> = [
    { label: 'Net revenue retention', key: 'nrr', headline: wf?.ttm_accrual?.annual_nrr, fmt: (v) => pct(v), good: 'up', deltaFmt: (d) => `${Math.abs(d * 100).toFixed(1)} pts`,
      bench: `Target 100% or more · accrual, ${wf?.ttm_accrual ? `${mlabel(wf.ttm_accrual.windowStart)} to ${mlabel(wf.ttm_accrual.windowEnd)}` : 'trailing 12 months'}`, band: (v) => band(v, (x) => x >= 1, (x) => x >= 0.9) },
    { label: 'Gross revenue retention', key: 'grr', headline: wf?.ttm_accrual?.annual_grr, fmt: (v) => pct(v), good: 'up', deltaFmt: (d) => `${Math.abs(d * 100).toFixed(1)} pts`,
      bench: 'Target 90% or more · accrual, same window', band: (v) => band(v, (x) => x >= 0.9, (x) => x >= 0.8) },
    { label: 'LTV : CAC', key: 'ltv_cac_ratio', headline: ttm.ltv_cac_ratio, fmt: ratio, good: 'up', deltaFmt: (d) => `${Math.abs(d).toFixed(1)}x`,
      bench: `Target 3x or more · CAC from ${pnlThrough}`, band: (v) => band(v, (x) => x >= 3, (x) => x >= 1) },
    { label: 'CAC payback', key: 'cac_payback_months', headline: ttm.cac_payback_months, fmt: mo, good: 'down', deltaFmt: (d) => `${Math.abs(d).toFixed(1)} mo`,
      bench: `Good at 12 months or less · ${pnlThrough}`, band: (v) => band(v, (x) => x <= 12, (x) => x <= 18) },
    { label: 'Gross margin', key: 'gross_margin', headline: undefined, fmt: (v) => pct(v), good: 'up', deltaFmt: (d) => `${Math.abs(d * 100).toFixed(1)} pts`,
      bench: '', band: (v) => band(v, (x) => x >= 0.75, (x) => x >= 0.6) },
    { label: 'Annual logo churn', key: 'annual_logo_churn_rate', headline: ttm.annual_logo_churn_rate, fmt: (v) => pct(v), good: 'down', deltaFmt: (d) => `${Math.abs(d * 100).toFixed(1)} pts`,
      bench: 'Churned plus lapsed customers · lower is better', band: (v) => band(v, (x) => x <= 0.1, (x) => x <= 0.2) },
  ];

  // ---- Connect
  const an = cv?.annualized;
  const processing = connectProcessing ?? 0;
  const feeRev = an ? connectRevTtm ?? an.fee_revenue : null;
  const s1 = (cv?.scenarios || []).find((s) => Math.abs(s.take_rate - 0.01) < 1e-6);
  const attachPotential = cv?.penetration?.attach_target_fee_potential ?? null;

  const monthly = streamBasis === 'monthly';
  const ttmWindow = `${mlabel(ttm.windowStart)} to ${mlabel(ttm.windowEnd)}`;
  const ttmMonths = snap.monthly.filter((m) => m.month >= ttm.windowStart && m.month <= ttm.windowEnd);

  // ---- by-month table (newest first)
  const tableRows = [...monthlyTtm].reverse();
  const tag = (t: [string, Tone] | [undefined, undefined]) => (t[0] ? <span className={`am-tag am-tag--${t[1]}`}>{t[0]}</span> : '—');

  const overlays = drill && (
    drill.kind === 'services' ? (
      <SideSheet open onClose={() => setDrill(null)} title={`Services customers · ${svcRows.length} attached`}
        text={`${usd(svcRows.reduce((a, r) => a + r.lifetime, 0))} lifetime services revenue · from services_by_month`}>
        <div className="am-row am-row--spread">
          <span className="am-card__text">Biggest first; every header sorts.</span>
          <button className="am-btn am-btn--text" onClick={() => {
            const order = svcOrder ?? svcRows.map((_, i) => i);
            downloadCsv('services_customers', ['Customer', 'First services month', 'Last services month', 'Months active', 'Lifetime services $'],
              order.map((i) => svcRows[i]).map((r) => [r.name, r.first ?? '', r.last ?? '', r.months, r.lifetime]));
          }}><Icon name="download" />Download CSV</button>
        </div>
        {svcRows.length ? (
          <>
            <DataTable label="Services customers" cols={[['Customer', false], ['First month', false], ['Last month', false], ['Months active', true], ['Lifetime services', true]]}
              rows={svcRows.map((r) => [<CustomerLink name={r.name} />, r.first ? mlabel(r.first) : '—', r.last ? mlabel(r.last) : '—', String(r.months), usd(r.lifetime)])}
              sortValues={svcRows.map((r) => [r.name, r.first, r.last, r.months, r.lifetime])}
              onSortChange={(order) => setSvcOrder(order)}
              limit={showAllSvc ? undefined : SVC_LIMIT}
              foot={[`Total · ${svcRows.length} customers`, '', '', String(svcRows.reduce((a, r) => a + r.months, 0)), usd(svcRows.reduce((a, r) => a + r.lifetime, 0))]}
              onFoot={() => setShowAllSvc(true)} footClickable={(c) => !showAllSvc && svcRows.length > SVC_LIMIT && (c === 0 || c === 3 || c === 4)} />
            {!showAllSvc && svcRows.length > SVC_LIMIT && <button className="am-btn am-btn--text" onClick={() => setShowAllSvc(true)}>Show all {svcRows.length}</button>}
          </>
        ) : <p className="am-card__text">No services customers in the snapshot.</p>}
      </SideSheet>
    ) : drill.kind === 'streams' ? (
      <SideSheet open onClose={() => setDrill(null)} title={`Revenue by stream · ${ttmWindow}`}
        text="The twelve months the stream figures sum. Subscription and Services from the Stripe MRR snapshots, Connect from connect_by_month.">
        <DataTable label="Revenue by stream by month" cols={[['Month', false], ['Subscription', true], ['Services', true], ['Connect', true], ['Total', true]]}
          rows={[...ttmMonths].reverse().map((m) => [mlabel(m.month), usd(m.subscription_revenue), usd(m.services_revenue), usd(m.connect_revenue), usd(m.subscription_revenue + m.services_revenue + m.connect_revenue)])}
          sortValues={[...ttmMonths].reverse().map((m) => [m.month, m.subscription_revenue, m.services_revenue, m.connect_revenue, m.subscription_revenue + m.services_revenue + m.connect_revenue])}
          foot={[`Total · ${ttmMonths.length} months`, usd(ttm.subscription_revenue), usd(ttm.services_revenue), usd(ttm.connect_revenue), usd(streams?.total ?? 0)]} />
      </SideSheet>
    ) : (
      <SideSheet open onClose={() => setDrill(null)} title={`How LTV and CAC are built · ${ttmWindow}`}
        text={`From unit_economics.ttm. CAC, and therefore LTV:CAC and payback, use sales and marketing spend from the ${pnlThrough}${ttm.pnl_coverage ? ` (${ttm.pnl_coverage.months} months)` : ''}.`}>
        <DataTable label="LTV and CAC inputs" cols={[['Input', false], ['Value', true]]}
          rows={[
            ['Sales and marketing spend', usd(ttm.snm_expense)],
            ['New customers', String(ttm.new_logos)],
            ['CAC (spend ÷ new customers)', ttm.cac != null ? usd(ttm.cac) : '—'],
            ['Average MRR per customer', ttm.avg_mrr_per_customer != null ? usd(ttm.avg_mrr_per_customer) : '—'],
            ['Subscription gross margin', pct(ttm.subscription_gross_margin)],
            ['Monthly gross revenue churn', pct(ttm.monthly_revenue_churn_rate ?? null, 2)],
            ['LTV (MRR × margin ÷ churn)', ttm.ltv != null ? usd(ttm.ltv) : '—'],
            ['LTV : CAC', ratio(ttm.ltv_cac_ratio)],
            ['CAC payback', mo(ttm.cac_payback_months)],
            ['Annual gross revenue churn', pct(ttm.annual_revenue_churn_rate ?? null)],
          ]} />
      </SideSheet>
    )
  );

  return (
    <DsPage
      path="/unit-economics"
      title="Unit Economics"
      subtitle="What it costs to win a customer and what they return over their lifetime · every metric is a trailing 12 months"
      actions={<button className="am-btn am-btn--outlined" onClick={exportSeries}><Icon name="download" />Export CSV</button>}
      overlays={overlays}
    >
      {error ? <p className="am-card__text">Could not load unit_economics: {String(error)}</p> : null}

      <div className="am-row am-row--wrap">
        <span className="am-tag am-tag--success">Retention and revenue: live through {latest ? mlabel(latest.month) : '—'}</span>
        <span className="am-tag am-tag--warning">Margin, LTV and CAC: QuickBooks P&amp;L through {lastPnlMonth ? mlabel(lastPnlMonth) : '—'}</span>
      </div>

      <KpiGrid>
        {kpis.map((k) => {
          const s = kpiVal(k.key);
          const cur = k.headline !== undefined ? (k.headline ?? null) : s.cur;
          const delta = cur != null && s.prev != null ? cur - s.prev : null;
          const better = delta == null ? null : k.good === 'up' ? delta > 0 : delta < 0;
          const change = delta == null ? '' : delta === 0 ? ' · unchanged on 6 months earlier' : ` · ${delta > 0 ? 'up' : 'down'} ${k.deltaFmt(delta)} on 6 months earlier (${better ? 'better' : 'worse'})`;
          const bench = k.key === 'gross_margin' ? `Target 75% or more · 12 months to ${s.month ? mlabel(s.month) : '—'}, ${pnlThrough}` : k.bench;
          const [t, tone] = k.band(cur);
          const onOpen = k.key === 'ltv_cac_ratio' || k.key === 'cac_payback_months' ? () => setDrill({ kind: 'inputs' }) : undefined;
          return <KpiCard key={k.label} label={k.label} value={cur != null ? k.fmt(cur) : '—'} hint={bench + change} tag={t} tagTone={tone}
            spark={spark(k.key)} sparkTone="div-1" onOpen={onOpen} />;
        })}
      </KpiGrid>
      <p className="am-card__text">Headlines come from the canonical snapshots: retention from the accrual MRR waterfall, LTV, CAC and logo churn from unit_economics. The small bars track the same metric over the last 24 trailing windows. Open LTV : CAC or CAC payback to see the inputs.</p>

      {/* trend charts: one range for all */}
      <section className="am-card am-card--outlined">
        <div className="am-chart__head">
          <span className="am-chart__title">Trends</span>
          <span className="am-chart__caption">Each column is the trailing 12 months ending that month · {range.rangeText}</span>
        </div>
        {range.controls}
      </section>

      <ChartCard title="Net and gross revenue retention" caption={`Annualized, trailing 12 months, accrual basis (cash only before invoicing coverage) · label is NRR / GRR · 100% means no net change`}>
        <ColumnChart months={retRows.map((r) => r.month)} grouped legend fmt={(v) => pct(v, 0)}
          series={[
            { key: 'nrr', label: 'Net revenue retention', tone: 'div-1', values: retRows.map((r) => r.nrr as number) },
            { key: 'grr', label: 'Gross revenue retention', tone: 'div-2', values: retRows.map((r) => r.grr as number) },
          ]}
          labelFor={(i) => `${Math.round((retRows[i].nrr as number) * 100)} / ${Math.round((retRows[i].grr as number) * 100)}%`}
          tipRows={(i) => [['NRR', pct(retRows[i].nrr)], ['GRR', pct(retRows[i].grr)]]}
          aria={`Net and gross revenue retention, ${range.rangeText}.`} />
      </ChartCard>

      <ChartCard title="Revenue by stream" caption="Trailing 12 months, stacked · subscription is the durable base, Connect the fastest-growing lever">
        <ColumnChart months={vis.map((r) => r.month)} stacked legend fmt={usdk}
          series={[
            { key: 'sub', label: 'Subscription', tone: 'div-1', values: vis.map((r) => r.subscription_revenue) },
            { key: 'svc', label: 'Services', tone: 'div-2', values: vis.map((r) => r.services_revenue) },
            { key: 'con', label: 'Connect', tone: 'other', values: vis.map((r) => r.connect_revenue) },
          ]}
          tipRows={(i) => [['Subscription', usd(vis[i].subscription_revenue)], ['Services', usd(vis[i].services_revenue)], ['Connect', usd(vis[i].connect_revenue)], ['Total', usd(vis[i].total_revenue)]]}
          aria={`Trailing 12 month revenue by stream, ${range.rangeText}.`} />
      </ChartCard>

      <div className="am-grid" style={{ ['--am-grid-min' as string]: '720px' }}>
        <ChartCard title="Gross margin" caption={`Trailing 12 months · target 75% · ${pnlCut}`}>
          <ColumnChart months={gmRows.map((r) => r.month)} fmt={(v) => pct(v, 0)}
            series={[{ key: 'gm', label: 'Gross margin', tone: 'div-1', values: gmRows.map((r) => r.gross_margin as number) }]}
            labelFor={(i) => pct(gmRows[i].gross_margin, gmRows.length > 12 ? 0 : 1)}
            tipRows={(i) => [['Gross margin', pct(gmRows[i].gross_margin)], ['Subscription gross margin', pct(gmRows[i].subscription_gross_margin)]]}
            aria="Trailing 12 month gross margin." />
        </ChartCard>
        <ChartCard title="Net operating income" caption={`Trailing 12 months, an EBITDA stand-in · ${pnlCut}`}>
          <ColumnChart months={noiRows.map((r) => r.month)} fmt={usdk} stacked legend
            series={[
              { key: 'noi', label: 'Operating profit', tone: 'div-1', values: noiRows.map((r) => Math.max(0, r.net_op_income as number)) },
              { key: 'loss', label: 'Operating loss', tone: 'div-5', values: noiRows.map((r) => Math.min(0, r.net_op_income as number)) },
            ]}
            labelFor={(i) => usdk(noiRows[i].net_op_income as number)}
            tipRows={(i) => [['Net operating income', usd(noiRows[i].net_op_income as number)]]}
            aria="Trailing 12 month net operating income." />
        </ChartCard>
        <ChartCard title="CAC payback" caption={`Months of gross profit to recover the cost of winning a customer · good at 12 or less · ${pnlCut}`}>
          <ColumnChart months={pbRows.map((r) => r.month)} fmt={(v) => `${Math.round(v * 10) / 10}`}
            series={[{ key: 'pb', label: 'CAC payback (months)', tone: 'div-1', values: pbRows.map((r) => r.cac_payback_months as number) }]}
            labelFor={(i) => (pbRows[i].cac_payback_months as number).toFixed(1)}
            tipRows={(i) => [['CAC payback', mo(pbRows[i].cac_payback_months)], ['CAC', pbRows[i].cac != null ? usd(pbRows[i].cac as number) : '—']]}
            aria="Trailing 12 month CAC payback in months." />
        </ChartCard>
        <ChartCard title="LTV : CAC" caption={`Lifetime value per dollar spent to win a customer · target 3x or more · ${pnlCut}`}>
          <ColumnChart months={lcRows.map((r) => r.month)} fmt={(v) => `${Math.round(v * 10) / 10}x`}
            series={[{ key: 'lc', label: 'LTV : CAC', tone: 'div-1', values: lcRows.map((r) => r.ltv_cac_ratio as number) }]}
            labelFor={(i) => `${(lcRows[i].ltv_cac_ratio as number).toFixed(1)}x`}
            tipRows={(i) => [['LTV : CAC', ratio(lcRows[i].ltv_cac_ratio)], ['LTV', lcRows[i].ltv != null ? usd(lcRows[i].ltv as number) : '—'], ['CAC', lcRows[i].cac != null ? usd(lcRows[i].cac as number) : '—']]}
            aria="Trailing 12 month LTV to CAC ratio." />
        </ChartCard>
      </div>

      {/* revenue streams */}
      {streams && (
        <section className="am-card am-card--outlined">
          <div className="am-row am-row--spread am-row--wrap">
            <div className="am-chart__head">
              <span className="am-chart__title">Revenue streams</span>
              <span className="am-chart__caption">{monthly ? 'Average per month over the' : 'Trailing'} 12 months · {ttmWindow} · total {usdk(monthly ? streams.total / 12 : streams.total)}{monthly ? ' a month' : ''} · margins from the {pnlThrough}</span>
            </div>
            <Segmented label="Basis" value={streamBasis} onChange={setStreamBasis} options={[['annual', 'Annual (12 months)'], ['monthly', 'Monthly average']]} />
          </div>
          <div style={{ overflowX: 'auto' }}>
            <DataTable label="Per-stream economics"
              cols={[['Stream', false], [monthly ? 'Revenue a month' : 'Revenue a year', true], ['Share', true], ['Customers', true], ['Revenue per customer', true], ['Gross margin', true], ['How it is counted', false]]}
              rows={streams.cards.map((c) => {
                const rev = monthly ? c.revenue / 12 : c.revenue;
                const arpu = c.arpu == null ? null : monthly && c.recurring && !c.lifetimeArpu ? c.arpu / 12 : c.arpu;
                const arpuLabel = c.lifetimeArpu ? `per ${c.arpuNoun}, lifetime average` : `per ${c.arpuNoun} a ${monthly ? 'month' : 'year'}`;
                return [c.label, usd(rev), pct(c.share), c.customers != null ? c.customers.toLocaleString() : '—', arpu != null ? usd(arpu) : '—', c.margin != null ? pct(c.margin) : '—',
                  `${c.customersLabel}${c.note ? ` (${c.note})` : ''}; revenue ${arpuLabel}`];
              })}
              sortValues={streams.cards.map((c) => [c.label, c.revenue, c.share, c.customers, c.arpu, c.margin, null])}
              clickable={(col) => col === 1} onCell={() => setDrill({ kind: 'streams' })}
              foot={['Total · 3 streams', usd(monthly ? streams.total / 12 : streams.total), pct(1), '', '', '', '']}
              footClickable={(c) => c === 1} onFoot={() => setDrill({ kind: 'streams' })} />
          </div>
          <div className="am-chart__head" style={{ marginTop: 16 }}>
            <span className="am-chart__title">Monthly revenue by stream</span>
            <span className="am-chart__caption">Actual months, stacked · {streamRange.rangeText} · {mlabel(currentMonth)} (in progress) is left out</span>
          </div>
          {streamRange.controls}
          <ColumnChart months={streamVis.map((r) => r.month)} stacked legend fmt={usdk}
            series={[
              { key: 'sub', label: 'Subscription', tone: 'div-1', values: streamVis.map((r) => r.Subscription) },
              { key: 'svc', label: 'Services', tone: 'div-2', values: streamVis.map((r) => r.Services) },
              { key: 'con', label: 'Connect', tone: 'other', values: streamVis.map((r) => r.Connect) },
            ]}
            tipRows={(i) => [['Subscription', usd(streamVis[i].Subscription)], ['Services', usd(streamVis[i].Services)], ['Connect', usd(streamVis[i].Connect)], ['Total', usd(streamVis[i].Subscription + streamVis[i].Services + streamVis[i].Connect)]]}
            aria={`Monthly revenue by stream, ${streamRange.rangeText}.`} />
        </section>
      )}

      {/* Connect economics */}
      {an && (
        <>
          <div className="am-chart__head">
            <span className="am-chart__title">Connect economics</span>
            <span className="am-chart__caption">Platform fee on payments processed through Stripe Connect · near 100% contribution margin (no added cost of sales) · processing volume, take rate and fee per transaction are Stripe gross application fees, {an.basis}</span>
          </div>
          <KpiGrid>
            <KpiCard label="Processing volume" value={usdk(an.gross_volume)} hint="Annualized, last 12 months" />
            <KpiCard label="Blended take rate" value={an.blended_take_rate != null ? `${(an.blended_take_rate * 100).toFixed(2)}%` : '—'} hint="Gross application fees ÷ processing volume" />
            <KpiCard label="Connect revenue (12 months)" value={feeRev != null ? usd(feeRev) : '—'} hint={`Canonical, connect_by_month · gross application fees (Stripe): ${usd(an.fee_revenue)}`} />
            <KpiCard label="Attach rate" value={connectAttach != null ? `${(connectAttach * 100).toFixed(0)}%` : '—'} hint={`${connectProcessing ?? '—'} of ${activeCustomers ?? '—'} active customers`} />
            <KpiCard label="Revenue per processing customer" value={processing > 0 && feeRev != null ? `${usd(feeRev / processing)}/yr` : '—'} hint={`${processing} processing now`} />
            <KpiCard label="Fee per transaction" value={an.txn_count > 0 ? `$${(an.fee_revenue / an.txn_count).toFixed(2)}` : '—'}
              hint={an.txn_count > 0 ? `Gross application fee · ${an.txn_count.toLocaleString()} transactions · ${usd(an.gross_volume / an.txn_count)} average charge` : ''} />
          </KpiGrid>
          <div className="am-grid" style={{ ['--am-grid-min' as string]: 'max(420px, calc((100% - var(--am-space-block)) / 2))' }}>
            <section className="am-card am-card--outlined">
              <div className="am-chart__head">
                <span className="am-chart__title">Lever 1 · standardize the take rate</span>
                <span className="am-chart__caption">At zero acquisition cost</span>
              </div>
              <p className="am-card__text">
                The book is priced at about 0.5%. Standardizing to the 1.0% some accounts already pay would lift Connect fee revenue to {s1 ? `${usd(s1.annual_fee_revenue)} a year` : '—'}
                {s1 ? ` (${s1.multiple_vs_current}x today, +${usd(s1.delta_vs_current)} a year)` : ''}.
              </p>
            </section>
            <section className="am-card am-card--outlined">
              <div className="am-chart__head">
                <span className="am-chart__title">Lever 2 · grow attach</span>
                <span className="am-chart__caption">Capture-adjusted estimate</span>
              </div>
              <p className="am-card__text">
                Only {connectAttach != null ? `${(connectAttach * 100).toFixed(0)}%` : '—'} of active customers process on Connect. Attaching the customers not processing is an estimated {attachPotential != null ? `+${usd(attachPotential)} a year` : '—'} in fee revenue. See <Link to="/payments-opportunity">Payments Opportunity</Link> for the per-customer targets.
              </p>
            </section>
          </div>
        </>
      )}

      {/* unit economics by month */}
      <section className="am-card am-card--outlined">
        <div className="am-row am-row--spread am-row--wrap">
          <div className="am-chart__head">
            <span className="am-chart__title">Unit economics by month</span>
            <span className="am-chart__caption">Each row is the trailing 12 months ending that month (smoother than single months, where a month with no new customers sends CAC to infinity) · newest first · status uses the headline benchmarks</span>
          </div>
          <button className="am-btn am-btn--text" onClick={exportSeries}><Icon name="download" />Export full series</button>
        </div>
        {tableRows.length === 0 ? <p className="am-card__text">Not enough monthly data to build a trailing 12 month window yet.</p> : (
          <div style={{ overflowX: 'auto' }}>
            <DataTable label="Unit economics by month"
              cols={[['Month', false], ['CAC', true], ['LTV', true], ['LTV : CAC', true], ['Efficiency', false], ['Payback', true], ['Revenue churn', true], ['Logo churn', true], ['Gross margin', true], ['Sub margin', true], ['MRR / customer', true], ['New customers', true], ['S&M spend', true]]}
              rows={tableRows.map((r) => [
                mlabel(r.month), r.cac != null ? usd(r.cac) : '—', r.ltv != null ? usd(r.ltv) : '—', ratio(r.ltv_cac_ratio),
                tag(band(r.ltv_cac_ratio, (x) => x >= 3, (x) => x >= 1)), mo(r.cac_payback_months),
                pct(r.annual_revenue_churn_rate), pct(r.annual_logo_churn_rate), pct(r.gross_margin), pct(r.subscription_gross_margin),
                r.avg_mrr_per_customer != null ? usd(r.avg_mrr_per_customer) : '—', String(r.new_logos), usdk(r.snm_expense),
              ])}
              sortValues={tableRows.map((r) => [r.month, r.cac, r.ltv, r.ltv_cac_ratio, r.ltv_cac_ratio, r.cac_payback_months, r.annual_revenue_churn_rate, r.annual_logo_churn_rate, r.gross_margin, r.subscription_gross_margin, r.avg_mrr_per_customer, r.new_logos, r.snm_expense])}
              limit={showAllMonths ? undefined : TABLE_LIMIT} />
            {tableRows.length > TABLE_LIMIT && (
              <button className="am-btn am-btn--text" onClick={() => setShowAllMonths(!showAllMonths)}>
                {showAllMonths ? `Show the latest ${TABLE_LIMIT}` : `Show all ${tableRows.length} (back to ${mlabel(monthlyTtm[0].month)})`}
              </button>
            )}
          </div>
        )}
        <p className="am-card__text">No Total row: every figure is already a 12-month window, so adding rows would count months many times over. Margin, CAC, LTV and payback are blank where the window runs past the QuickBooks P&amp;L.</p>
      </section>

      {/* services add-on */}
      <div className="am-chart__head">
        <span className="am-chart__title">Services add-on economics</span>
        <span className="am-chart__caption">Project-based, not recurring, so kept apart from subscription LTV · from Stripe transactions classified as services</span>
      </div>
      <KpiGrid max={4}>
        <KpiCard label="Services attach rate" value={pct(svc?.attach_rate ?? null)} hint={svc ? `${svc.customers_bought_services} of ${svc.total_customers_ever} customers ever · open for the list` : ''}
          onOpen={() => setDrill({ kind: 'services' })} />
        <KpiCard label="Average services per attached customer" value={svc?.avg_services_revenue_per_attached_customer != null ? usd(svc.avg_services_revenue_per_attached_customer) : '—'}
          hint="Lifetime services revenue among customers who bought any" />
        <KpiCard label="Services revenue (12 months)" value={usdk(ttm.services_revenue)} hint={`${((ttm.services_revenue / ttm.total_income) * 100).toFixed(1)}% of total revenue · ${ttmWindow}`} />
        <KpiCard label="LTV uplift from services" value={svc?.avg_services_revenue_per_attached_customer != null && svc.attach_rate != null ? usd(svc.avg_services_revenue_per_attached_customer * svc.attach_rate) : '—'}
          hint="Average services × attach rate, added to blended LTV" />
      </KpiGrid>
    </DsPage>
  );
}
