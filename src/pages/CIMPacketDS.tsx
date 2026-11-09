/**
 * CIM Packet on the Allmoxy design system. Assembled from the shared certified parts
 * (src/design-system/parts.tsx). Data logic is the classic page's (CIMPacket.tsx, kept at
 * /cim-packet-classic): same snapshots, same canonical sources (customer_base for customers /
 * MRR / ARPA, mrr_waterfall.ttm_accrual for the waterfall and retention, unit_economics.ttm for
 * revenue and QuickBooks-window figures), same maths. Only the presentation changes.
 *
 * It is a buyer-facing, printable document, so the numbered sections (§1–§21) and the narrative
 * from src/data/cim_narrative.json keep their order. Each section is one card; tables end in a
 * Total row; drill-downs open in a side sheet and never print.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSheetTab } from '../hooks/useSheetTab';
import { segmentLabel, CANONICAL_SEGMENTS } from '../lib/segmentsRegistry';
import narrative from '../data/cim_narrative.json';
import {
  ChartCard, ColumnChart, CustomerLink, DataTable, DsPage, Icon, KpiCard, KpiGrid, Link, Segmented, Select, SideSheet,
  addMonths, downloadCsv, mlabel,
} from '../design-system/parts';

// ---------------------------------------------------------------- types (snapshot projections)
type MonthlyCell = { subscription: number; services: number; connect: number; total: number; annualized?: boolean };
type ProfileRow = {
  allmoxy_customer_id: number; name: string; primary_segment: string | null; sub_segment: string | null;
  pay_status: string | null; status: string; current_subscription_mrr: number; current_services: number; current_connect: number;
  lifetime_total: number; lifetime_subscription: number; first_payment_date: string | null; last_payment_date: string | null;
  years_with_us: number | null; monthly_history: Record<string, MonthlyCell>; latest_month: string; churn_reason: string | null;
};
type MrrMonthlyRow = { month: string; logo_qty: number; mrr_subscription: number; mrr_services: number | null; mrr_connect: number | null; mrr_blended: number | null; avg_mrr_blended: number | null };
type WaterfallTtm = {
  windowStart: string; windowEnd: string; starting_mrr: number; ending_mrr: number; new_mrr: number; reactivated_mrr?: number;
  recovered_mrr?: number; expansion_mrr: number; contraction_mrr: number; churn_mrr: number; voided_mrr?: number;
  delinquent_mrr?: number; paused_mrr?: number; net_new_mrr: number; gross_mrr_churn_ttm: number | null;
  annual_gross_churn_rate: number | null; annual_grr: number | null; annual_nrr: number | null; quick_ratio: number | null;
};
type Named = { name: string; id?: number | null; mrr: number; status?: string | null; pay_status?: string | null };
type Change = { name: string; id?: number | null; prev_mrr: number; new_mrr: number; delta: number };
type WaterfallMonthly = {
  month: string; partial?: boolean; starting_mrr: number; ending_mrr: number; net_new_mrr: number;
  nrr_monthly: number | null; grr_monthly: number | null; quick_ratio: number | null;
  details?: Partial<Record<Bucket, Array<Named | Change>>>;
};
type UnitEconTtm = {
  windowStart: string; windowEnd: string; subscription_revenue: number; services_revenue: number; connect_revenue: number;
  affiliate_revenue: number; total_income: number; cogs: number; gross_profit: number; gross_margin: number;
  subscription_gross_margin: number; snm_expense: number; new_logos: number; cac: number | null; net_op_income: number;
  monthly_churn_rate: number | null; annual_churn_rate: number | null; annual_logo_churn_rate?: number | null;
  annual_revenue_churn_rate?: number | null; ltv_cac_ratio?: number | null; pnl_coverage?: { months: number; start: string; end: string } | null;
  avg_mrr_per_customer: number | null; logo_qty_latest: number; ltv: number | null; cac_payback_months: number | null;
};
type CustomerBaseMember = { allmoxy_customer_id: number; name: string; mrr: number; source: string; status: string };
type CustomerBase = {
  as_of: string; customers: number; mrr: number; arr: number; arpa: number; members: CustomerBaseMember[];
  by_month: Array<{ month: string; customers: number; mrr: number; arpa: number }>;
  logo_flow: Array<{ month: string; new_logos: number; churned_logos: number; ending_logos: number }>;
};
type CohortSummary = { year: number; initial: number; active: number; churned: number; retentionPct: number | null };
type PnlSnapshot = { months: string[]; lineItems: Array<{ key: string; label: string; section: string; isTotal: boolean; parentKey?: string }>; data: Record<string, Record<string, number>> };

// ---------------------------------------------------------------- formatters (identical to classic)
const USD0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const USD_COMPACT = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });
const usd0 = (v: number) => USD0.format(v);
const usdc = (v: number) => USD_COMPACT.format(v);
function pct(v: number | null | undefined, digits = 1): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(digits)}%`;
}
function monthLabelLong(iso: string): string {
  const [y, m] = iso.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}
function monthLabelShort(iso: string): string {
  const [y, m] = iso.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
}
const signedUsd = (v: number) => `${v >= 0 ? '+' : '−'}${usd0(Math.abs(v))}`;

// ---------------------------------------------------------------- waterfall buckets
type Bucket = 'new' | 'reactivated' | 'recovered' | 'expansion' | 'contraction' | 'churn' | 'voided' | 'delinquent' | 'paused';
const BUCKETS: Array<{ k: Bucket; label: string; sign: 1 | -1; field: keyof WaterfallTtm; note: string }> = [
  { k: 'new', label: 'New', sign: 1, field: 'new_mrr', note: 'First-time customers' },
  { k: 'reactivated', label: 'Reactivated', sign: 1, field: 'reactivated_mrr', note: 'Former customers who came back' },
  { k: 'recovered', label: 'Recovered', sign: 1, field: 'recovered_mrr', note: 'Lapses credited back' },
  { k: 'expansion', label: 'Expansion', sign: 1, field: 'expansion_mrr', note: 'Existing customers paying more' },
  { k: 'contraction', label: 'Contraction', sign: -1, field: 'contraction_mrr', note: 'Existing customers paying less' },
  { k: 'churn', label: 'Churn', sign: -1, field: 'churn_mrr', note: 'Customers who left outright' },
  { k: 'voided', label: 'Voided', sign: -1, field: 'voided_mrr', note: 'Invoices voided / non-payment' },
  { k: 'delinquent', label: 'Lapsed (delinquent)', sign: -1, field: 'delinquent_mrr', note: 'Stopped paying, not yet churned' },
  { k: 'paused', label: 'Paused', sign: -1, field: 'paused_mrr', note: 'HubSpot Pause Granted' },
];
const ttmVal = (t: WaterfallTtm, b: Bucket) => Number(t[BUCKETS.find((x) => x.k === b)!.field] ?? 0);

// ---------------------------------------------------------------- local parts
/** One numbered packet section: a card with the § number, title and caption, content stacked. */
function Section({ n, title, sub, children }: { n: string; title: string; sub?: string; children: ReactNode }) {
  return (
    <section className="am-card am-card--outlined am-stack cim-section" aria-label={`Section ${n}: ${title}`}>
      <div className="am-chart__head">
        <span className="am-chart__title">§{n} · {title}</span>
        {sub && <span className="am-chart__caption">{sub}</span>}
      </div>
      {children}
    </section>
  );
}

/** Bold-only inline Markdown (**…**), same as the classic page. */
function md(s: string): ReactNode {
  return s.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : <span key={i}>{part}</span>);
}
function Prose({ text }: { text: string }) {
  return <>{text.split(/\n\n+/).map((p, i) => <p key={i} style={{ margin: 0, lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>{md(p)}</p>)}</>;
}
function SubHead({ children }: { children: ReactNode }) {
  return <span className="am-chart__title" style={{ marginTop: 8 }}>{children}</span>;
}

/** useMonthRange with a chosen opening preset. The shared hook always opens on 1 yr; the packet's
 *  exhibits are 24-month views, so this opens on 2 yr. Same controls, same parts. */
type Preset = '12M' | '24M' | '60M' | 'ALL' | 'CUSTOM';
function useRange(allMonths: string[], initial: Preset) {
  const [preset, setPreset] = useState<Preset>(initial);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const first = allMonths[0], last = allMonths[allMonths.length - 1];
  useEffect(() => {
    if (!first || !last || preset === 'CUSTOM') return;
    const back = preset === 'ALL' ? null : preset === '60M' ? 59 : preset === '24M' ? 23 : 11;
    const start = back == null ? first : addMonths(last, -back);
    setFrom(start < first ? first : start);
    setTo(last);
  }, [preset, first, last]);
  const months = allMonths.filter((m) => m >= from && m <= to);
  const controls = (
    <div className="am-row am-row--wrap cim-noprint">
      <Segmented label="Range" value={preset === 'CUSTOM' ? null : preset} onChange={setPreset}
        options={[['12M', '1 yr'], ['24M', '2 yr'], ['60M', '5 yr'], ['ALL', 'All']]} />
      {(['From', 'To'] as const).map((w) => (
        <div key={w} className="am-row am-row--tight">
          <span className="am-card__text">{w}</span>
          <Select label={`${w} month`} value={w === 'From' ? from : to} options={[...allMonths].reverse().map((m) => [m, mlabel(m)])}
            onPick={(m) => {
              setPreset('CUSTOM');
              if (w === 'From') { setFrom(m); if (to && m > to) setTo(m); } else { setTo(m); if (from && m < from) setFrom(m); }
            }} />
        </div>
      ))}
    </div>
  );
  const rangeText = months.length ? `${mlabel(months[0])} to ${mlabel(months[months.length - 1])}` : '';
  return { months, controls, rangeText };
}

type Drill =
  | { kind: 'wf'; buckets: Bucket[]; title: string }
  | { kind: 'seg'; segment: string | null; title: string }
  | { kind: 'base'; title: string }
  | { kind: 'churn'; reason: string | null; title: string };

// ============================================================================
export default function CIMPacketDS() {
  const { data: mrrData, isLoading: mrrLoading, error: mrrError } = useSheetTab('mrr_by_month');
  const { data: wfData } = useSheetTab('mrr_waterfall');
  const { data: ueData } = useSheetTab('unit_economics');
  const { data: cohortData } = useSheetTab('cohort_retention');
  const { data: profilesData } = useSheetTab('customer_profiles');
  const { data: pnlData } = useSheetTab('pnl_by_month');
  const { data: cbData } = useSheetTab('customer_base');

  const mrr = mrrData as unknown as { rows: MrrMonthlyRow[] } | undefined;
  // Accrual (invoiced) waterfall is canonical; `monthly`/`ttm` are the cash basis and never feed this page.
  const wf = wfData as unknown as { monthly_accrual: WaterfallMonthly[]; ttm_accrual: WaterfallTtm } | undefined;
  const ue = ueData as unknown as { ttm: UnitEconTtm } | undefined;
  const cohort = cohortData as unknown as { cohortSummary: CohortSummary[]; totalCustomers: number; activeToday: number } | undefined;
  const profiles = profilesData as unknown as { rows: ProfileRow[] } | undefined;
  const pnl = pnlData as unknown as PnlSnapshot | undefined;
  const cb = cbData as unknown as CustomerBase | undefined;

  const [drill, setDrill] = useState<Drill | null>(null);
  const [sheetAll, setSheetAll] = useState(false);
  const [showAllTop, setShowAllTop] = useState(false);
  const [showAllReasons, setShowAllReasons] = useState(false);
  const open = (d: Drill) => { setSheetAll(false); setDrill(d); };

  // QuickBooks P&L covers only part of the TTM window; every P&L figure carries this label.
  const qbWindow = useMemo(() => {
    const c = ue?.ttm?.pnl_coverage;
    if (!c || !c.start || !c.end) return { short: 'QB coverage', long: 'QuickBooks P&L coverage months', months: null as number | null };
    const range = `${monthLabelShort(c.start)}–${monthLabelShort(c.end)}`;
    return { short: `${range}, QB`, long: `QuickBooks P&L coverage: ${range} (${c.months} mo)`, months: c.months };
  }, [ue]);

  const newLogosTtm = useMemo(() => (cb?.logo_flow ?? []).slice(-12).reduce((s, r) => s + (r.new_logos ?? 0), 0), [cb]);

  // Latest COMPLETE month: the ETL's TTM window end (the in-progress month is excluded by the builder).
  const headlineMonth = useMemo(() => {
    if (ue?.ttm?.windowEnd) return ue.ttm.windowEnd;
    if (wf?.ttm_accrual?.windowEnd) return wf.ttm_accrual.windowEnd;
    const rows = mrr?.rows ?? [];
    if (rows.length === 0) return '';
    const now = new Date();
    const currentYM = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].month === currentYM) continue;
      if ((rows[i].mrr_subscription ?? 0) > 0) return rows[i].month;
    }
    return rows[rows.length - 1].month;
  }, [mrr, ue, wf]);
  const headlineRow = useMemo(() => mrr?.rows.find((r) => r.month === headlineMonth), [mrr, headlineMonth]);

  // Monthly series: subscription from customer_base.by_month (canonical), services + connect from
  // mrr_by_month. Classic shows the last 24 complete months; the range control opens there.
  const monthSeries = useMemo(() => {
    const byMonth = new Map((mrr?.rows ?? []).map((r) => [r.month, r]));
    return (cb?.by_month ?? []).filter((r) => r.month <= headlineMonth).map((r) => {
      const m = byMonth.get(r.month);
      return { month: r.month, arr: (r.mrr ?? 0) * 12, mrr_sub: r.mrr ?? 0, mrr_svc: m?.mrr_services ?? 0, mrr_connect: m?.mrr_connect ?? 0 };
    });
  }, [mrr, cb, headlineMonth]);
  const seriesBy = useMemo(() => new Map(monthSeries.map((r) => [r.month, r])), [monthSeries]);

  const cbHeadline = useMemo(() => {
    if (!cb) return null;
    const row = cb.by_month?.find((r) => r.month === headlineMonth);
    return row ?? { month: cb.as_of, customers: cb.customers, mrr: cb.mrr, arpa: cb.arpa };
  }, [cb, headlineMonth]);

  const streamComposition = useMemo(() => {
    if (!headlineRow || !cbHeadline) return null;
    const sub = cbHeadline.mrr ?? 0, svc = headlineRow.mrr_services ?? 0, conn = headlineRow.mrr_connect ?? 0;
    const total = sub + svc + conn;
    return { subscription: sub, services: svc, connect: conn, total, subPct: total > 0 ? sub / total : 0, svcPct: total > 0 ? svc / total : 0, connPct: total > 0 ? conn / total : 0 };
  }, [headlineRow, cbHeadline]);

  // Current customer base (customer_base.members, duplicates excluded) joined to profile attributes.
  const baseRows = useMemo(() => {
    const byId = new Map((profiles?.rows ?? []).map((r) => [r.allmoxy_customer_id, r]));
    return (cb?.members ?? []).map((m): ProfileRow => {
      const p = byId.get(m.allmoxy_customer_id);
      return {
        ...(p ?? {
          allmoxy_customer_id: m.allmoxy_customer_id, name: m.name, primary_segment: null, sub_segment: null, pay_status: null,
          status: m.status, current_services: 0, current_connect: 0, lifetime_total: 0, lifetime_subscription: 0,
          first_payment_date: null, last_payment_date: null, years_with_us: null, monthly_history: {}, latest_month: cb?.as_of ?? '', churn_reason: null,
        }),
        name: p?.name ?? m.name,
        current_subscription_mrr: m.mrr ?? 0,
      };
    });
  }, [cb, profiles]);

  const concentration = useMemo(() => {
    const sorted = baseRows.filter((r) => (r.current_subscription_mrr ?? 0) > 0).sort((a, b) => (b.current_subscription_mrr ?? 0) - (a.current_subscription_mrr ?? 0));
    const totalMrr = sorted.reduce((s, r) => s + (r.current_subscription_mrr ?? 0), 0);
    const slice = (n: number) => sorted.slice(0, n).reduce((s, r) => s + (r.current_subscription_mrr ?? 0), 0);
    return {
      sorted, activeBilling: sorted.length, totalMrr,
      top1Pct: totalMrr > 0 ? slice(1) / totalMrr : 0, top5Pct: totalMrr > 0 ? slice(5) / totalMrr : 0,
      top10Pct: totalMrr > 0 ? slice(10) / totalMrr : 0, top20Pct: totalMrr > 0 ? slice(20) / totalMrr : 0,
    };
  }, [baseRows]);

  const segmentMix = useMemo(() => {
    const rows = baseRows.filter((r) => (r.current_subscription_mrr ?? 0) > 0);
    const byPrimary = new Map<string, { count: number; mrr: number; subByName: Map<string, { count: number; mrr: number }> }>();
    for (const r of rows) {
      const seg = (r.primary_segment ?? '').trim() || '(unsegmented)';
      if (!byPrimary.has(seg)) byPrimary.set(seg, { count: 0, mrr: 0, subByName: new Map() });
      const bucket = byPrimary.get(seg)!;
      bucket.count += 1; bucket.mrr += r.current_subscription_mrr ?? 0;
      const sub = (r.sub_segment ?? '').trim() || '(unspecified)';
      if (!bucket.subByName.has(sub)) bucket.subByName.set(sub, { count: 0, mrr: 0 });
      const sb = bucket.subByName.get(sub)!;
      sb.count += 1; sb.mrr += r.current_subscription_mrr ?? 0;
    }
    const primary = [...byPrimary.entries()].map(([name, v]) => ({
      name, count: v.count, mrr: v.mrr,
      subSegments: [...v.subByName.entries()].map(([sname, sv]) => ({ name: sname, count: sv.count, mrr: sv.mrr })).sort((a, b) => b.mrr - a.mrr),
    })).sort((a, b) => b.mrr - a.mrr);
    return { primary, totalMrr: primary.reduce((s, r) => s + r.mrr, 0) };
  }, [baseRows]);

  const churnByReason = useMemo(() => {
    const rows = (profiles?.rows ?? []).filter((r) => r.status === 'churned');
    const buckets = new Map<string, { count: number; lifetime: number }>();
    let totalLifetime = 0;
    for (const r of rows) {
      const lifetime = r.lifetime_subscription ?? 0;
      totalLifetime += lifetime;
      const raw = (r.churn_reason ?? '').trim();
      const reasons = raw ? raw.split(';').map((s) => s.trim()).filter(Boolean) : ['(no reason recorded)'];
      const weight = raw ? lifetime / reasons.length : lifetime;
      for (const reason of reasons) {
        if (!buckets.has(reason)) buckets.set(reason, { count: 0, lifetime: 0 });
        const b = buckets.get(reason)!;
        b.count += 1; b.lifetime += weight;
      }
    }
    return {
      rows, total: rows.length, totalLifetime,
      reasons: [...buckets.entries()].map(([reason, v]) => ({ reason, count: v.count, lifetime: v.lifetime })).sort((a, b) => b.lifetime - a.lifetime),
    };
  }, [profiles]);

  // NRR / GRR monthly, accrual basis, complete months only.
  const retention = useMemo(() => (wf?.monthly_accrual ?? []).filter((m) => !m.partial), [wf]);
  const retentionBy = useMemo(() => new Map(retention.map((r) => [r.month, r])), [retention]);

  const pnlSummary = useMemo(() => {
    if (!pnl) return null;
    const months = pnl.months ?? [];
    const last6 = months.slice(-6);
    const get = (key: string, m: string) => (pnl.data?.[key]?.[m] ?? 0);
    const sumOver = (key: string, ms: string[]) => ms.reduce((s, m) => s + get(key, m), 0);
    return {
      months: last6,
      totalIncome: last6.map((m) => get('total_income', m)),
      grossProfit: last6.map((m) => get('gross_profit', m)),
      totalOpex: last6.map((m) => get('total_expenses', m)),
      netOp: last6.map((m) => get('net_op_income', m)),
      ttm: { income: sumOver('total_income', months.slice(-12)), gp: sumOver('gross_profit', months.slice(-12)), opex: sumOver('total_expenses', months.slice(-12)), netOp: sumOver('net_op_income', months.slice(-12)) },
    };
  }, [pnl]);

  const streamRange = useRange(monthSeries.map((r) => r.month), '24M');
  const arrRange = useRange(monthSeries.map((r) => r.month), '24M');
  const retRange = useRange(retention.map((r) => r.month), '24M');

  const isReady = !!(mrr && wf && ue && cohort && profiles && cb && headlineRow && cbHeadline);
  const t = wf?.ttm_accrual;
  const u = ue?.ttm;
  const ltvCac = u && u.ltv != null && u.cac ? u.ltv / u.cac : null;
  const ttmMonths = useMemo(() => (t ? (wf?.monthly_accrual ?? []).filter((m) => m.month >= t.windowStart && m.month <= t.windowEnd) : []), [wf, t]);

  // ---------------------------------------------------------------- drill content
  const sheet = (() => {
    if (!drill) return null;
    const LIMIT = 25;
    const showAllBtn = (n: number) => !sheetAll && n > LIMIT
      ? <button className="am-btn am-btn--text" onClick={() => setSheetAll(true)}>Show all {n}</button> : null;
    if (drill.kind === 'wf') {
      const rows = [...ttmMonths].reverse().flatMap((m) => drill.buckets.flatMap((b) => {
        const def = BUCKETS.find((x) => x.k === b)!;
        return (m.details?.[b] ?? []).map((x) => {
          const amt = 'delta' in x ? (b === 'contraction' ? -Math.abs(x.delta) : x.delta) : def.sign * (x as Named).mrr;
          return { month: m.month, id: x.id ?? null, name: x.name, label: def.label, detail: 'delta' in x ? `${usd0(x.prev_mrr)} → ${usd0(x.new_mrr)}` : '', amt };
        });
      }));
      const net = rows.reduce((a, r) => a + r.amt, 0);
      return {
        text: `Invoiced (accrual) basis · ${t ? `${mlabel(t.windowStart)} to ${mlabel(t.windowEnd)}` : ''}. The total matches the waterfall line.`,
        body: rows.length ? <>
          <div style={{ overflowX: 'auto' }}><DataTable label={drill.title} cols={[['Month', false], ['Customer', false], ['Movement', false], ['MRR change', true]]}
            rows={rows.map((r) => [monthLabelShort(r.month), <CustomerLink key="c" id={r.id} name={r.name} />, <span key="m">{r.detail ? `${r.label} · ${r.detail}` : r.label}</span>, signedUsd(r.amt)])}
            sortValues={rows.map((r) => [r.month, r.name, r.label, r.amt])}
            limit={sheetAll ? undefined : LIMIT}
            foot={[`Total · ${rows.length} movements`, '', '', signedUsd(net)]} onFoot={() => setSheetAll(true)} footClickable={(c) => c === 0 && !sheetAll && rows.length > LIMIT} /></div>
          {showAllBtn(rows.length)}
        </> : <p className="am-card__text">No customers in this movement for the period.</p>,
      };
    }
    if (drill.kind === 'seg' || drill.kind === 'base') {
      const list = concentration.sorted.filter((r) => drill.kind === 'base'
        || (drill.segment == null ? true : ((r.primary_segment ?? '').trim() || '(unsegmented)') === drill.segment));
      const sum = list.reduce((a, r) => a + r.current_subscription_mrr, 0);
      return {
        text: `Current subscription MRR, ${monthLabelLong(headlineMonth)}, post-amortization (customer_base, duplicates excluded).`,
        body: <>
          <div style={{ overflowX: 'auto' }}><DataTable label={drill.title} cols={[['Customer', false], ['Segment', false], ['Sub-segment', false], ['Current MRR', true], ['% of total', true], ['Lifetime $', true], ['Tenure', true]]}
            rows={list.map((c) => [<CustomerLink key="c" id={c.allmoxy_customer_id} name={c.name} />, c.primary_segment ? segmentLabel(c.primary_segment) : '—', c.sub_segment ?? '—',
              usd0(c.current_subscription_mrr), pct(c.current_subscription_mrr / concentration.totalMrr, 1), usd0(c.lifetime_total ?? 0), c.years_with_us != null ? `${c.years_with_us.toFixed(1)}y` : '—'])}
            sortValues={list.map((c) => [c.name, c.primary_segment ? segmentLabel(c.primary_segment) : null, c.sub_segment, c.current_subscription_mrr, c.current_subscription_mrr, c.lifetime_total ?? 0, c.years_with_us])}
            limit={sheetAll ? undefined : LIMIT}
            foot={[`Total · ${list.length} customers`, '', '', usd0(sum), pct(concentration.totalMrr > 0 ? sum / concentration.totalMrr : null, 1), usd0(list.reduce((a, r) => a + (r.lifetime_total ?? 0), 0)), '']}
            onFoot={() => setSheetAll(true)} footClickable={(c) => c === 0 && !sheetAll && list.length > LIMIT} /></div>
          {showAllBtn(list.length)}
        </>,
      };
    }
    const list = churnByReason.rows.filter((r) => {
      if (drill.reason == null) return true;
      const raw = (r.churn_reason ?? '').trim();
      return drill.reason === '(no reason recorded)' ? !raw : raw.split(';').map((s) => s.trim()).includes(drill.reason);
    }).sort((a, b) => (b.lifetime_subscription ?? 0) - (a.lifetime_subscription ?? 0));
    return {
      text: drill.reason == null ? 'Every churned customer, by lifetime subscription revenue.' : 'Churned customers who gave this reason. Lifetime $ is each customer\'s full lifetime subscription revenue (the reason table splits it across multiple reasons).',
      body: <>
        <div style={{ overflowX: 'auto' }}><DataTable label={drill.title} cols={[['Customer', false], ['Segment', false], ['Churn reason', false], ['Last payment', true], ['Lifetime subscription $', true]]}
          rows={list.map((c) => [<CustomerLink key="c" id={c.allmoxy_customer_id} name={c.name} />, c.primary_segment ? segmentLabel(c.primary_segment) : '—', c.churn_reason?.trim() || '(no reason recorded)', c.last_payment_date ?? '—', usd0(c.lifetime_subscription ?? 0)])}
          sortValues={list.map((c) => [c.name, c.primary_segment ? segmentLabel(c.primary_segment) : null, c.churn_reason, c.last_payment_date, c.lifetime_subscription ?? 0])}
          limit={sheetAll ? undefined : LIMIT}
          foot={[`Total · ${list.length} customers`, '', '', '', usd0(list.reduce((a, r) => a + (r.lifetime_subscription ?? 0), 0))]}
          onFoot={() => setSheetAll(true)} footClickable={(c) => c === 0 && !sheetAll && list.length > LIMIT} /></div>
        {showAllBtn(list.length)}
      </>,
    };
  })();

  const verdict = (ok: boolean, good: string, bad: string) => ({ tag: ok ? good : bad, tagTone: ok ? 'success' as const : 'warning' as const });

  // Segment rows: classic's named segments (top 12 with MRR), plus the unsegmented share so the Total reconciles.
  const segRows = segmentMix.primary.filter((p) => p.name !== '(unsegmented)' && p.mrr > 0).slice(0, 12);
  const unseg = segmentMix.primary.find((p) => p.name === '(unsegmented)' && p.mrr > 0);
  const otherSegs = segmentMix.primary.filter((p) => p.name !== '(unsegmented)' && p.mrr > 0).slice(12);
  const segTable = [...segRows.map((p) => ({ ...p, label: segmentLabel(p.name), key: p.name as string | null })),
    ...(otherSegs.length ? [{ name: '__other', label: `Other segments (${otherSegs.length})`, key: '__other' as string | null, count: otherSegs.reduce((a, p) => a + p.count, 0), mrr: otherSegs.reduce((a, p) => a + p.mrr, 0), subSegments: [] }] : []),
    ...(unseg ? [{ ...unseg, label: 'Unsegmented', key: '(unsegmented)' as string | null }] : [])];

  const reasonsShown = showAllReasons ? churnByReason.reasons : churnByReason.reasons.slice(0, 10);
  const cohorts = (cohort?.cohortSummary ?? []).filter((c) => c.year >= 2015).slice().reverse();
  const retTone = (v: number | null) => (v == null ? null : v >= 60 ? ['Strong', 'success'] : v >= 40 ? ['Fair', 'warning'] : ['Weak', 'error']);

  return (
    <DsPage
      path="/cim-packet"
      title={`${narrative.document.title}`}
      subtitle={isReady ? `${narrative.company.name} · ${narrative.document.classification} · latest complete month ${monthLabelLong(headlineMonth)}` : 'Loading…'}
      actions={<>
        {isReady && <button className="am-btn am-btn--outlined" onClick={() => downloadCsv(`cim_headline_figures_${headlineMonth}`, ['Figure', 'Value', 'Basis'], [
          ['ARR', cbHeadline!.month === cb!.as_of ? cb!.arr : cbHeadline!.mrr * 12, 'customer_base'],
          ['Subscription MRR', cbHeadline!.mrr, 'customer_base'],
          ['Total monthly revenue', streamComposition?.total ?? 0, 'Subscription MRR + Services + Connect'],
          ['Active customers', cbHeadline!.customers, 'customer_base'],
          ['ARPA', cbHeadline!.arpa, 'customer_base'],
          ['NRR (TTM)', t!.annual_nrr ?? '', 'mrr_waterfall ttm_accrual'],
          ['GRR (TTM)', t!.annual_grr ?? '', 'mrr_waterfall ttm_accrual'],
          ['Net new MRR (TTM)', t!.net_new_mrr, 'mrr_waterfall ttm_accrual'],
          ['Quick ratio (TTM)', t!.quick_ratio ?? '', 'mrr_waterfall ttm_accrual'],
          ['Logo churn (TTM)', u!.annual_logo_churn_rate ?? u!.annual_churn_rate ?? '', 'unit_economics'],
          ['LTV', u!.ltv ?? '', 'unit_economics'],
          ['CAC', u!.cac ?? '', qbWindow.long],
          ['LTV : CAC', ltvCac ?? '', qbWindow.long],
          ['Gross margin', u!.gross_margin, qbWindow.long],
          ['Net operating income', u!.net_op_income, qbWindow.long],
          ['Top-10 concentration', concentration.top10Pct, 'customer_base'],
        ])}><Icon name="download" />Headline CSV</button>}
        <button className="am-btn am-btn--outlined" onClick={() => window.print()}><Icon name="print" />Print / PDF</button>
      </>}
      overlays={drill && sheet && (
        <SideSheet open onClose={() => setDrill(null)} title={drill.title} text={sheet.text}>{sheet.body}</SideSheet>
      )}
    >
      <style>{`
        @media print {
          @page { margin: 0.5in; }
          .cim-noprint { display: none; }
          .cim-section .am-card, .cim-section tr, .cim-section figure, .cim-section blockquote { break-inside: avoid; page-break-inside: avoid; }
          .cim-section > .am-chart__head { break-after: avoid; page-break-after: avoid; }
          .cim-packet .am-table .am-btn { display: inline; }
        }
      `}</style>
      <div className="am-stack cim-packet">
        {/* Title block */}
        <section className="am-card am-card--outlined am-stack cim-section" aria-label="Document title">
          <div className="am-row"><span className="am-tag am-tag--neutral">{narrative.document.classification}</span></div>
          <div>
            <p className="am-summary__value" style={{ margin: 0 }}>{narrative.company.name}</p>
            <p className="am-card__title" style={{ margin: '4px 0 0' }}>{narrative.company.tagline}</p>
          </div>
          <div>
            <p style={{ margin: 0 }}>{narrative.document.title}</p>
            <p className="am-card__text">{narrative.document.subtitle}</p>
          </div>
          <div className="am-grid" style={{ ['--am-grid-min' as string]: 'max(180px, calc((100% - 3 * var(--am-space-block)) / 4))' }}>
            {([['Category', narrative.company.category], ['Stage', narrative.company.stage], ['Headquarters', narrative.company.headquarters], ['Year founded', String(narrative.company.year_founded)]] as Array<[string, string]>).map(([k, v]) => (
              <div key={k}><span className="am-card__text">{k}</span><p style={{ margin: '4px 0 0' }}>{v}</p></div>
            ))}
          </div>
          <p className="am-card__text cim-noprint">
            A live, working-draft CIM: every data section re-populates from the latest snapshot refresh. Narrative sections come from
            src/data/cim_narrative.json (edit there and reload). Use Print / PDF for a shareable copy; controls and side sheets do not print.
          </p>
        </section>

        {mrrError ? <p className="am-card__text">Failed to load source data: {String(mrrError)}</p> : null}
        {mrrLoading && <p className="am-card__text">Loading the packet…</p>}

        {isReady && t && u && <>
          {/* §1 */}
          <Section n="1" title="Executive Summary" sub={`Latest complete month: ${monthLabelLong(headlineMonth)}`}>
            <p style={{ margin: 0, lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>{md(narrative.executive_summary_lede)}</p>
            <KpiGrid max={5} min={180}>
              <KpiCard label="ARR" value={usdc(cbHeadline!.month === cb!.as_of ? cb!.arr : cbHeadline!.mrr * 12)} hint={`${usd0(cbHeadline!.mrr)} MRR (subscription)`} />
              <KpiCard label="Total monthly revenue" value={usdc(streamComposition?.total ?? 0)} hint="Subscription MRR + Services + Connect (services are not MRR)" />
              <KpiCard label="Active customers" value={(cbHeadline!.customers ?? 0).toLocaleString()} hint={`${cohort!.activeToday ?? 0} active today / ${cohort!.totalCustomers ?? 0} lifetime`}
                onOpen={() => open({ kind: 'base', title: `Active customers · ${monthLabelLong(headlineMonth)}` })} />
              <KpiCard label="NRR (TTM)" value={pct(t.annual_nrr)} hint={`GRR ${pct(t.annual_grr)}`} {...verdict(t.annual_nrr != null && t.annual_nrr >= 1, '100% or more', 'Below 100%')} />
              <KpiCard label="LTV : CAC" value={ltvCac != null ? `${ltvCac.toFixed(1)}x` : '—'}
                hint={`Payback ${u.cac_payback_months != null ? `${u.cac_payback_months.toFixed(1)} mo` : '—'} · CAC on ${qbWindow.short}`}
                {...verdict(ltvCac != null && ltvCac >= 3, 'Healthy (3x+)', 'Below 3x')} />
              <KpiCard label={`Gross margin (${qbWindow.short})`} value={pct(u.gross_margin)} hint={`Sub GM ${pct(u.subscription_gross_margin)}`} />
              <KpiCard label="Net new MRR (TTM)" value={`${(t.net_new_mrr ?? 0) >= 0 ? '+' : ''}${usdc(t.net_new_mrr ?? 0)}`}
                hint={`Quick ratio ${t.quick_ratio != null ? `${t.quick_ratio.toFixed(1)}x` : '—'}`}
                tag={t.net_new_mrr >= 0 ? 'Growing' : 'Shrinking'} tagTone={t.net_new_mrr >= 0 ? 'success' : 'error'}
                onOpen={() => open({ kind: 'wf', buckets: BUCKETS.map((b) => b.k), title: 'All MRR movements · trailing 12 months' })} />
              <KpiCard label="Logo churn (TTM)" value={pct(u.annual_logo_churn_rate ?? u.annual_churn_rate)} hint={`${usdc(t.churn_mrr ?? 0)} MRR churned outright`} />
              <KpiCard label={`ARPA (${monthLabelShort(cbHeadline!.month)})`} value={usd0(cbHeadline!.arpa)} hint={`${newLogosTtm} new logos (TTM)`} />
              <KpiCard label="Top-10 concentration" value={pct(concentration.top10Pct, 0)} hint={`Top-5 ${pct(concentration.top5Pct, 0)} · Top-20 ${pct(concentration.top20Pct, 0)}`}
                {...(concentration.top10Pct > 0.4 ? { tag: 'Concentrated', tagTone: 'warning' as const } : { tag: 'Diversified', tagTone: 'success' as const })} />
            </KpiGrid>
          </Section>

          {/* §2 */}
          <Section n="2" title="Company Overview"><Prose text={narrative.company_overview} /></Section>

          {/* §3 */}
          <Section n="3" title="Market Opportunity">
            <Prose text={narrative.market_opportunity} />
            <SubHead>The wedge: why nothing else fits</SubHead>
            <div style={{ overflowX: 'auto' }}>
              <DataTable label="Competitive wedge" cols={[['Alternative', false], ['Examples', false], ['Why it breaks', false], ['Where Allmoxy wins', false]]}
                rows={narrative.competitive_wedge.map((r) => [<strong key="a">{r.alternative}</strong>, <span key="e" className="am-table__muted">{r.examples}</span>, <span key="w">{r.why_it_breaks}</span>, <span key="x">{r.where_allmoxy_wins}</span>])} />
            </div>
            <SubHead>The buying committee inside a shop</SubHead>
            <ul style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {narrative.buying_committee.map((p) => (
                <li key={p.persona}><strong>{p.persona}</strong> <span className="am-card__text">· {p.role} ·</span> {p.what_they_want}</li>
              ))}
            </ul>
            <div className="am-card am-card--filled">
              <span className="am-card__text">Allmoxy GTM segments (live, post-amortization)</span>
              <p style={{ margin: '4px 0 0' }}>
                Allmoxy actively sells to <strong>{CANONICAL_SEGMENTS.filter((s) => s.inMotion).length}</strong> of the canonical{' '}
                <strong>{CANONICAL_SEGMENTS.length}</strong> industry segments, with material customer presence today in{' '}
                <strong>{segmentMix.primary.filter((p) => p.name !== '(unsegmented)').length}</strong> of them. The current customer base
                concentrates in Cabinetry (Component Manufacturers + Custom Cabinet Shops), with diversified exposure across Closets,
                Architectural Woodwork, Dealer/Showroom, and Distribution.
              </p>
            </div>
          </Section>

          {/* §4 */}
          <Section n="4" title="Product"><Prose text={narrative.product_overview} /></Section>

          {/* §5 */}
          <Section n="5" title="Financial Highlights" sub={`Revenue: TTM ${u.windowStart} → ${u.windowEnd} (12 mo) · Profitability: ${qbWindow.long}`}>
            <div className="am-grid" style={{ ['--am-grid-min' as string]: 'max(360px, calc((100% - var(--am-space-block)) / 2))' }}>
              <div className="am-stack">
                <SubHead>Trailing-12-month revenue ({u.windowStart} → {u.windowEnd})</SubHead>
                <DataTable label="Trailing 12 month revenue" cols={[['Stream', false], ['Revenue', true], ['Share', true]]}
                  rows={[['Subscription revenue', u.subscription_revenue], ['Services revenue', u.services_revenue], ['Connect (platform-fee) revenue', u.connect_revenue],
                    ...(u.affiliate_revenue ? [['Affiliate revenue', u.affiliate_revenue] as [string, number]] : [])]
                    .map(([k, v]) => [k, usd0(v as number), pct(u.total_income ? (v as number) / u.total_income : null, 1)])}
                  foot={['Total income', usd0(u.total_income), u.total_income ? '100.0%' : '—']} />
              </div>
              <div className="am-stack">
                <SubHead>Profitability: {qbWindow.long}</SubHead>
                <DataTable label="Profitability" cols={[['Line', false], ['Amount', true]]}
                  rows={[
                    [`Gross profit (${qbWindow.short})`, usd0(u.gross_profit)],
                    [`Gross margin (${qbWindow.short})`, pct(u.gross_margin)],
                    [`Subscription gross margin (${qbWindow.short})`, pct(u.subscription_gross_margin)],
                    [`S&M expense (${qbWindow.short})`, usd0(u.snm_expense)],
                  ]}
                  foot={[<span key="n" className="am-row am-row--tight">Net operating income ({qbWindow.short}) <span className={`am-tag am-tag--${u.net_op_income >= 0 ? 'success' : 'error'}`}>{u.net_op_income >= 0 ? 'Profit' : 'Loss'}</span></span>, usd0(u.net_op_income)]} />
                <p className="am-card__text">
                  QuickBooks P&L covers only {qbWindow.months ?? 'part'} of the 12 revenue months. Profitability figures are not
                  comparable to the 12-month revenue at left; do not divide across the two windows.
                </p>
              </div>
            </div>
          </Section>

          {/* §6 */}
          <Section n="6" title="Revenue Composition" sub="Latest complete month, by stream · Subscription = canonical MRR (customer_base); Services are not MRR">
            {streamComposition && (
              <DataTable label="Revenue composition, latest complete month" cols={[['Stream', false], [monthLabelLong(headlineMonth), true], ['Share of total monthly revenue', true], ['Kind', false]]}
                rows={[
                  ['Subscription MRR', usd0(streamComposition.subscription), pct(streamComposition.subPct), <span key="k" className="am-tag am-tag--info">Recurring</span>],
                  ['Services', usd0(streamComposition.services), pct(streamComposition.svcPct), <span key="k" className="am-tag am-tag--neutral">Project-based, not MRR</span>],
                  ['Connect (affiliate fees)', usd0(streamComposition.connect), pct(streamComposition.connPct), <span key="k" className="am-tag am-tag--neutral">Platform fees</span>],
                ]}
                foot={['Total monthly revenue', usd0(streamComposition.total), '100.0%', '']} />
            )}
            <ChartCard title="Monthly revenue by stream" caption={`Subscription (customer_base) + Services + Connect (mrr_by_month) · complete months only · ${streamRange.rangeText}`}>
              {streamRange.controls}
              <ColumnChart months={streamRange.months} stacked legend fmt={(v) => usdc(v)}
                series={[
                  { key: 'sub', label: 'Subscription', tone: 'div-1', values: streamRange.months.map((m) => seriesBy.get(m)?.mrr_sub ?? 0) },
                  { key: 'svc', label: 'Services', tone: 'div-2', values: streamRange.months.map((m) => seriesBy.get(m)?.mrr_svc ?? 0) },
                  { key: 'con', label: 'Connect', tone: 'other', values: streamRange.months.map((m) => seriesBy.get(m)?.mrr_connect ?? 0) },
                ]}
                tipRows={(i) => { const r = seriesBy.get(streamRange.months[i]); return r ? [['Subscription', usd0(r.mrr_sub)], ['Services', usd0(r.mrr_svc)], ['Connect', usd0(r.mrr_connect)], ['Total', usd0(r.mrr_sub + r.mrr_svc + r.mrr_connect)]] : []; }}
                aria={`Monthly revenue by stream, ${streamRange.rangeText}.`} />
            </ChartCard>
          </Section>

          {/* §7 */}
          <Section n="7" title="ARR Trajectory" sub={`Canonical subscription MRR × 12 (customer_base, invoiced basis) · ${arrRange.months.length} months from ${arrRange.months[0] ? monthLabelShort(arrRange.months[0]) : '—'}`}>
            {arrRange.controls}
            <ColumnChart months={arrRange.months} fmt={(v) => usdc(v)}
              series={[{ key: 'arr', label: 'ARR', tone: 'div-1', values: arrRange.months.map((m) => seriesBy.get(m)?.arr ?? 0) }]}
              tipRows={(i) => { const r = seriesBy.get(arrRange.months[i]); return r ? [['ARR', usd0(r.arr)], ['Subscription MRR', usd0(r.mrr_sub)]] : []; }}
              aria={`ARR by month, ${arrRange.rangeText}.`} />
          </Section>

          {/* §8 */}
          <Section n="8" title="MRR Waterfall: Trailing 12 Months" sub={`${t.windowStart} → ${t.windowEnd} · invoiced (accrual) basis · Starting + adds − losses = Ending`}>
            <KpiGrid max={3} min={200}>
              <KpiCard label="Starting MRR" value={usdc(t.starting_mrr)} hint={`${mlabel(t.windowStart)} opening`} />
              <KpiCard label="Net new MRR" value={`${t.net_new_mrr >= 0 ? '+' : ''}${usdc(t.net_new_mrr)}`} hint="Adds − losses over the 12 months"
                tag={t.net_new_mrr >= 0 ? 'Growing' : 'Shrinking'} tagTone={t.net_new_mrr >= 0 ? 'success' : 'error'}
                onOpen={() => open({ kind: 'wf', buckets: BUCKETS.map((b) => b.k), title: 'All MRR movements · trailing 12 months' })} />
              <KpiCard label="Ending MRR" value={usdc(t.ending_mrr)}
                hint={cbHeadline!.month === t.windowEnd ? `Invoiced; + ${usdc(cbHeadline!.mrr - t.ending_mrr)} annual amortization = ${usdc(cbHeadline!.mrr)} MRR` : 'Latest complete month'} />
              <KpiCard label="Quick ratio" value={t.quick_ratio != null ? `${t.quick_ratio.toFixed(2)}x` : '—'} hint="(New + Reactivated + Expansion) ÷ (Churn + Contraction)" />
              <KpiCard label="Gross revenue churn" value={pct(t.annual_grr != null ? 1 - t.annual_grr : null)} hint="1 − GRR · every lost dollar" />
              <KpiCard label="Outright churn rate" value={pct(t.annual_gross_churn_rate)} hint="Churn bucket only, $ basis" />
            </KpiGrid>
            <DataTable label="MRR bridge, trailing 12 months" cols={[['Line', false], ['MRR', true], ['Customer movements', true], ['What it means', false]]}
              rows={[
                ['Starting MRR', usd0(t.starting_mrr), '—', `${mlabel(t.windowStart)} opening, invoiced basis`],
                ...BUCKETS.map((b) => {
                  const v = ttmVal(t, b.k);
                  const n = ttmMonths.reduce((a, m) => a + (m.details?.[b.k]?.length ?? 0), 0);
                  return [`${b.sign > 0 ? '+' : '−'} ${b.label}`, v ? signedUsd(b.sign * v) : '—', n ? n.toLocaleString() : '—', b.note];
                }),
              ]}
              clickable={(col, row) => row > 0 && (col === 1 || col === 2)}
              onCell={(row) => { const b = BUCKETS[row - 1]; if (b) open({ kind: 'wf', buckets: [b.k], title: `${b.label} · trailing 12 months` }); }}
              foot={[`Ending MRR (net new ${signedUsd(t.net_new_mrr)})`, usd0(t.ending_mrr), ttmMonths.reduce((a, m) => a + BUCKETS.reduce((s, b) => s + (m.details?.[b.k]?.length ?? 0), 0), 0).toLocaleString(), mlabel(t.windowEnd)]}
              onFoot={() => open({ kind: 'wf', buckets: BUCKETS.map((b) => b.k), title: 'All MRR movements · trailing 12 months' })}
              footClickable={(c) => c === 1 || c === 2} />
            <p className="am-card__text">Select any movement to see the customers behind it. Starting {usd0(t.starting_mrr)} {signedUsd(t.net_new_mrr)} net new = ending {usd0(t.ending_mrr)}.</p>
          </Section>

          {/* §9 */}
          <Section n="9" title="Net Revenue Retention" sub="Trailing 12 months, accrual basis · monthly NRR / GRR series (complete months only)">
            <KpiGrid max={4}>
              <KpiCard label="NRR (TTM)" value={pct(t.annual_nrr)} {...verdict(t.annual_nrr != null && t.annual_nrr >= 1, '100% or more', 'Below 100%')} />
              <KpiCard label="GRR (TTM)" value={pct(t.annual_grr)} {...verdict(t.annual_grr != null && t.annual_grr >= 0.9, '90% or more', 'Below 90%')} />
              <KpiCard label="Expansion $ (TTM)" value={usdc(t.expansion_mrr)} onOpen={() => open({ kind: 'wf', buckets: ['expansion'], title: 'Expansion · trailing 12 months' })} />
              <KpiCard label="Contraction $ (TTM)" value={usdc(t.contraction_mrr)} onOpen={() => open({ kind: 'wf', buckets: ['contraction'], title: 'Contraction · trailing 12 months' })} />
            </KpiGrid>
            <ChartCard title="Monthly NRR and GRR" caption={`Accrual basis · the month in progress is excluded · ${retRange.rangeText}`}>
              {retRange.controls}
              <ColumnChart months={retRange.months} grouped legend fmt={(v) => `${(v * 100).toFixed(0)}%`}
                series={[
                  { key: 'nrr', label: 'NRR (monthly)', tone: 'div-1', values: retRange.months.map((m) => retentionBy.get(m)?.nrr_monthly ?? 0) },
                  { key: 'grr', label: 'GRR (monthly)', tone: 'div-2', values: retRange.months.map((m) => retentionBy.get(m)?.grr_monthly ?? 0) },
                ]}
                tipRows={(i) => { const r = retentionBy.get(retRange.months[i]); return r ? [['NRR (monthly)', pct(r.nrr_monthly)], ['GRR (monthly)', pct(r.grr_monthly)]] : []; }}
                aria={`Monthly NRR and GRR, ${retRange.rangeText}.`} />
            </ChartCard>
          </Section>

          {/* §10 */}
          <Section n="10" title="Cohort Retention" sub={`${cohort!.totalCustomers} lifetime customers · ${cohort!.activeToday} active today`}>
            {(() => {
              const sum = (k: 'initial' | 'active' | 'churned') => cohorts.reduce((a, c) => a + c[k], 0);
              const ti = sum('initial'), ta = sum('active');
              return <DataTable label="Cohort retention by signup year" cols={[['Cohort year', false], ['Signups', true], ['Active today', true], ['Churned', true], ['Retention %', true], ['Retention', false]]}
                rows={cohorts.map((c) => { const tn = retTone(c.retentionPct); return [String(c.year), c.initial.toLocaleString(), c.active.toLocaleString(), c.churned.toLocaleString(),
                  c.retentionPct != null ? `${c.retentionPct.toFixed(1)}%` : '—', tn ? <span key="t" className={`am-tag am-tag--${tn[1]}`}>{tn[0]}</span> : '—']; })}
                sortValues={cohorts.map((c) => [c.year, c.initial, c.active, c.churned, c.retentionPct, c.retentionPct])}
                foot={[`Total · ${cohorts.length} cohorts${cohorts.length ? ` (${cohorts[cohorts.length - 1].year}–${cohorts[0].year})` : ''}`, ti.toLocaleString(), ta.toLocaleString(), sum('churned').toLocaleString(), ti ? `${(ta / ti * 100).toFixed(1)}%` : '—', '']} />;
            })()}
            <p className="am-card__text">Retention tag: Strong at 60% or more, Fair at 40% to 60%, Weak below 40%. Cohorts before 2015 are left out, as on the classic packet.</p>
          </Section>

          {/* §11 */}
          <Section n="11" title="Unit Economics" sub={`CAC, gross margin and net op income: ${qbWindow.long} · S&M = QuickBooks 6050 + 6300 + 6500 + 5200 · LTV/ARPA on current customer base`}>
            <KpiGrid max={4}>
              <KpiCard label="CAC" value={u.cac != null ? usd0(u.cac) : '—'} hint={`${u.new_logos} new logos · ${usd0(u.snm_expense)} S&M (${qbWindow.short})`} />
              <KpiCard label="LTV" value={u.ltv != null ? usd0(u.ltv) : '—'} hint={`Gross revenue churn ${pct(u.annual_revenue_churn_rate)} (1 − GRR)`} />
              <KpiCard label="LTV : CAC" value={ltvCac != null ? `${ltvCac.toFixed(2)}x` : '—'} hint=">3x healthy · >5x best-in-class" {...verdict(ltvCac != null && ltvCac >= 3, 'Healthy (3x+)', 'Below 3x')} />
              <KpiCard label="CAC payback (months)" value={u.cac_payback_months != null ? u.cac_payback_months.toFixed(1) : '—'} hint="<12 mo healthy · <24 mo acceptable"
                {...verdict(u.cac_payback_months != null && u.cac_payback_months <= 12, 'Healthy (12 mo or less)', 'Over 12 mo')} />
              <KpiCard label={`ARPA (${monthLabelShort(cbHeadline!.month)})`} value={usd0(cbHeadline!.arpa)} hint="Subscription MRR / active customer" />
              <KpiCard label={`Gross margin (${qbWindow.short})`} value={pct(u.gross_margin)} hint={`Sub GM ${pct(u.subscription_gross_margin)}`} />
              <KpiCard label={`Net op income (${qbWindow.short})`} value={usdc(u.net_op_income)} tag={u.net_op_income >= 0 ? 'Profit' : 'Loss'} tagTone={u.net_op_income >= 0 ? 'success' : 'error'} />
              <KpiCard label="Logos (current)" value={(cbHeadline!.customers ?? 0).toLocaleString()} hint={`${u.new_logos} added ${qbWindow.short} · ${newLogosTtm} added TTM`}
                onOpen={() => open({ kind: 'base', title: `Active customers · ${monthLabelLong(headlineMonth)}` })} />
            </KpiGrid>
          </Section>

          {/* §12 */}
          <Section n="12" title="Customer Metrics" sub={`Post-amortization · Reference month: ${monthLabelLong(headlineMonth)}`}>
            <KpiGrid max={4}>
              <KpiCard label="Active customers" value={cbHeadline!.customers.toLocaleString()} hint="Canonical customer base (duplicates excluded)"
                onOpen={() => open({ kind: 'base', title: `Active customers · ${monthLabelLong(headlineMonth)}` })} />
              <KpiCard label="Subscription MRR" value={usdc(cbHeadline!.mrr)} hint="Canonical MRR (customer_base)" />
              <KpiCard label="ARPA" value={usd0(cbHeadline!.arpa)} hint="MRR / active customer" />
              <KpiCard label="Lifetime customers" value={cohort!.totalCustomers.toLocaleString()} hint={`${(cohort!.activeToday / cohort!.totalCustomers * 100).toFixed(0)}% active today`} />
            </KpiGrid>
          </Section>

          {/* §13 */}
          <Section n="13" title="Customer Concentration" sub={`Top customers by current subscription MRR · ${monthLabelLong(headlineMonth)} · post-amortization basis (annual lump-sums spread across coverage months)`}>
            <KpiGrid max={4}>
              <KpiCard label="Top 1" value={pct(concentration.top1Pct, 1)} />
              <KpiCard label="Top 5" value={pct(concentration.top5Pct, 1)} />
              <KpiCard label="Top 10" value={pct(concentration.top10Pct, 1)} {...(concentration.top10Pct > 0.4 ? { tag: 'Concentrated', tagTone: 'warning' as const } : { tag: 'Diversified', tagTone: 'success' as const })} />
              <KpiCard label="Top 20" value={pct(concentration.top20Pct, 1)} />
            </KpiGrid>
            {(() => {
              const list = concentration.sorted;
              const shown = showAllTop ? list : list.slice(0, 10);
              const sum = shown.reduce((a, c) => a + c.current_subscription_mrr, 0);
              return <>
                <div style={{ overflowX: 'auto' }}>
                  <DataTable label="Top customers by current subscription MRR"
                    cols={[['#', true], ['Customer', false], ['Segment', false], ['Sub-segment', false], ['Current MRR', true], ['% of total', true], ['Lifetime $', true], ['Tenure', true]]}
                    rows={shown.map((c, i) => [String(i + 1), <CustomerLink key="c" id={c.allmoxy_customer_id} name={c.name} />,
                      c.primary_segment ? <span key="s" className="am-tag am-tag--neutral">{segmentLabel(c.primary_segment)}</span> : '—',
                      c.sub_segment ?? '—', usd0(c.current_subscription_mrr ?? 0), pct((c.current_subscription_mrr ?? 0) / concentration.totalMrr, 1),
                      usd0(c.lifetime_total ?? 0), c.years_with_us != null ? `${c.years_with_us.toFixed(1)}y` : '—'])}
                    sortValues={shown.map((c, i) => [i + 1, c.name, c.primary_segment ? segmentLabel(c.primary_segment) : null, c.sub_segment, c.current_subscription_mrr, c.current_subscription_mrr, c.lifetime_total ?? 0, c.years_with_us])}
                    foot={[showAllTop ? 'Total' : 'Top 10', `${shown.length} of ${list.length} customers`, '', '', usd0(sum), pct(concentration.totalMrr > 0 ? sum / concentration.totalMrr : null, 1), usd0(shown.reduce((a, c) => a + (c.lifetime_total ?? 0), 0)), '']}
                    onFoot={() => open({ kind: 'base', title: `All billing customers · ${monthLabelLong(headlineMonth)}` })} footClickable={(c) => c === 1 || c === 4} />
                </div>
                <div className="am-row cim-noprint">
                  <button className="am-btn am-btn--text" onClick={() => setShowAllTop(!showAllTop)}>{showAllTop ? 'Show top 10' : `Show all ${list.length}`}</button>
                  <span className="am-card__text">All {list.length} billing customers total {usd0(concentration.totalMrr)} MRR.</span>
                </div>
              </>;
            })()}
          </Section>

          {/* §14 */}
          <Section n="14" title="Segment Mix" sub="Live, by current subscription MRR · canonical Allmoxy segments + sub-segments">
            <div style={{ overflowX: 'auto' }}>
              <DataTable label="Segment mix" cols={[['Primary segment', false], ['Customers', true], ['Current MRR', true], ['% of MRR', true], ['Top sub-segments', false]]}
                rows={segTable.map((p) => {
                  const namedSubs = p.subSegments.filter((s) => s.name !== '(unspecified)').slice(0, 3);
                  return [p.label, p.count.toLocaleString(), usd0(p.mrr), pct(segmentMix.totalMrr ? p.mrr / segmentMix.totalMrr : null, 1),
                    p.key === '__other' || p.key === '(unsegmented)' ? '—'
                      : namedSubs.length === 0 ? <span key="n" className="am-table__muted">(no sub-segment data)</span>
                      : <span key="s" className="am-row am-row--wrap am-row--tight">{namedSubs.map((s) => <span key={s.name} className="am-tag am-tag--neutral">{s.name} ({s.count})</span>)}</span>];
                })}
                clickable={(col, row) => (col === 1 || col === 2) && segTable[row]?.key !== '__other'}
                onCell={(row) => { const p = segTable[row]; open({ kind: 'seg', segment: p.key, title: `${p.label} · customers` }); }}
                foot={['Total', segTable.reduce((a, p) => a + p.count, 0).toLocaleString(), usd0(segTable.reduce((a, p) => a + p.mrr, 0)), pct(segmentMix.totalMrr ? segTable.reduce((a, p) => a + p.mrr, 0) / segmentMix.totalMrr : null, 1), '']}
                onFoot={() => open({ kind: 'seg', segment: null, title: 'All segments · customers' })} footClickable={(c) => c === 1 || c === 2} />
            </div>
            <p className="am-card__text">Named segments with current MRR, largest first{unseg ? '; Unsegmented is the billing customers with no segment recorded, shown so the total matches the customer base' : ''}. Select a count or MRR to see the customers.</p>
          </Section>

          {/* §15 */}
          <Section n="15" title="Customer Proof & Validation" sub="Verbatim from the Allmoxy Proof Library · single-customer results, not base-wide averages">
            <SubHead>Quantified proof points</SubHead>
            <div style={{ overflowX: 'auto' }}>
              <DataTable label="Quantified proof points" cols={[['Metric', false], ['Before', false], ['After', false], ['Source', false], ['Pillar', false]]}
                rows={narrative.customer_proof.quantified.map((p) => [<strong key="m">{p.metric}</strong>, <span key="b" className="am-table__muted">{p.before ?? '—'}</span>, <strong key="a">{p.after}</strong>, <span key="s">{p.source}</span>, <span key="p" className="am-table__muted">{p.pillar}</span>])} />
            </div>
            <SubHead>Customer voice (verbatim quotes)</SubHead>
            {narrative.customer_proof.quotes.map((q, i) => (
              <blockquote key={i} style={{ margin: 0, paddingLeft: 16 }} className="am-card am-card--filled">
                <p style={{ margin: 0, lineHeight: 1.6 }}>“{q.text}”</p>
                <p className="am-card__text" style={{ marginTop: 4 }}>— <strong>{q.attribution}</strong> · {q.theme}</p>
              </blockquote>
            ))}
            <SubHead>Named references / advocates</SubHead>
            <DataTable label="Named references" cols={[['Customer', false], ['Contact', false], ['Notes', false]]}
              rows={narrative.customer_proof.advocates.map((a) => [<strong key="c">{a.customer}</strong>, <span key="p">{a.person}</span>, <span key="n" className="am-table__muted">{a.notes}</span>])} />
            <p className="am-card__text">{narrative.customer_proof.usage_note}</p>
          </Section>

          {/* §16 */}
          <Section n="16" title="Churn Analysis" sub={`Lifetime churned customer base: ${churnByReason.total} customers · ${usdc(churnByReason.totalLifetime)} lifetime $`}>
            <DataTable label="Churn by reason" cols={[['Reason (top clusters)', false], ['Customers', true], ['Weighted lifetime $', true], ['% of churn $', true]]}
              rows={reasonsShown.map((r) => [r.reason === '(no reason recorded)' ? <span key="r" className="am-row am-row--tight">{r.reason}<span className="am-tag am-tag--warning">Not recorded</span></span> : r.reason,
                r.count.toLocaleString(), usd0(r.lifetime), pct(r.lifetime / churnByReason.totalLifetime, 1)])}
              sortValues={reasonsShown.map((r) => [r.reason, r.count, r.lifetime, r.lifetime])}
              clickable={(col) => col === 1 || col === 2}
              onCell={(row) => { const r = reasonsShown[row]; open({ kind: 'churn', reason: r.reason, title: `Churned · ${r.reason}` }); }}
              foot={[showAllReasons ? `Total · all ${churnByReason.reasons.length} reasons` : `Top 10 of ${churnByReason.reasons.length} reasons`,
                showAllReasons ? `${churnByReason.total} customers` : reasonsShown.reduce((a, r) => a + r.count, 0).toLocaleString(),
                usd0(reasonsShown.reduce((a, r) => a + r.lifetime, 0)), pct(churnByReason.totalLifetime ? reasonsShown.reduce((a, r) => a + r.lifetime, 0) / churnByReason.totalLifetime : null, 1)]}
              onFoot={(c) => (c === 0 ? setShowAllReasons(true) : open({ kind: 'churn', reason: null, title: 'All churned customers' }))}
              footClickable={(c) => (c === 0 ? !showAllReasons && churnByReason.reasons.length > 10 : c === 1 || c === 2)} />
            {churnByReason.reasons.length > 10 && (
              <div className="am-row cim-noprint">
                <button className="am-btn am-btn--text" onClick={() => setShowAllReasons(!showAllReasons)}>{showAllReasons ? 'Show top 10' : `Show all ${churnByReason.reasons.length} reasons`}</button>
              </div>
            )}
            <p className="am-card__text">
              A customer who gave several reasons counts once under each, with their lifetime $ split evenly, so reason counts can add to more than {churnByReason.total} customers while the dollars add to {usd0(churnByReason.totalLifetime)}.
              "(no reason recorded)" represents customers whose HubSpot Churn Reason field was empty at churn time. The Churn
              Investigator surface backfills these via AI inference from CSM notes; investors should expect process discipline
              questions on the unattributed share.
            </p>
          </Section>

          {/* §17 */}
          {pnlSummary && (
            <Section n="17" title="Profit & Loss Summary" sub="Last 6 months · TTM totals shown for context">
              <div style={{ overflowX: 'auto' }}>
                <DataTable label="Profit and loss summary"
                  cols={[['Line', false], ...pnlSummary.months.map((m) => [monthLabelShort(m), true] as [string, boolean]), [`TTM to ${pnlSummary.months.length ? monthLabelShort(pnlSummary.months[pnlSummary.months.length - 1]) : '—'}`, true]]}
                  rows={[
                    ['Total income', ...pnlSummary.totalIncome.map(usdc), usdc(pnlSummary.ttm.income)],
                    ['Gross profit', ...pnlSummary.grossProfit.map(usdc), usdc(pnlSummary.ttm.gp)],
                    ['Total operating expense', ...pnlSummary.totalOpex.map(usdc), usdc(pnlSummary.ttm.opex)],
                  ]}
                  foot={['Net operating income', ...pnlSummary.netOp.map(usdc), usdc(pnlSummary.ttm.netOp)]} />
              </div>
              <div className="am-row am-row--wrap am-row--tight">
                {pnlSummary.netOp.map((v, i) => v < 0 ? <span key={i} className="am-tag am-tag--error">{monthLabelShort(pnlSummary.months[i])}: loss</span> : null)}
                <span className={`am-tag am-tag--${pnlSummary.ttm.netOp >= 0 ? 'success' : 'error'}`}>TTM: {pnlSummary.ttm.netOp >= 0 ? 'profit' : 'loss'}</span>
              </div>
              <p className="am-card__text">
                Source: QuickBooks export via the dashboard's pnl_by_month snapshot. For the full line-item P&L, see the <Link to="/profit-loss">Profit & Loss page</Link>.
              </p>
            </Section>
          )}

          {/* §18 */}
          <Section n="18" title="Growth Drivers">
            <ul style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {narrative.growth_drivers.map((g, i) => <li key={i} style={{ lineHeight: 1.7 }}>{md(g)}</li>)}
            </ul>
          </Section>

          {/* §19 */}
          <Section n="19" title="Key Risks">
            <ul style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {narrative.key_risks.map((r, i) => <li key={i} style={{ lineHeight: 1.7 }}>{md(r)}</li>)}
            </ul>
          </Section>

          {/* §20 */}
          <Section n="20" title="Operations"><Prose text={narrative.operations_overview} /></Section>

          {/* §21 */}
          <Section n="21" title="Appendix">
            <SubHead>Definitions</SubHead>
            <DataTable label="Definitions" cols={[['Term', false], ['Definition', false]]}
              rows={Object.entries(narrative.definitions).map(([term, def]) => [<strong key="t">{term}</strong>, <span key="d">{String(def)}</span>])} />
            <SubHead>Data sources</SubHead>
            <ul style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {narrative.data_sources.map((s, i) => <li key={i} style={{ lineHeight: 1.6 }}>{md(s)}</li>)}
            </ul>
            <SubHead>Methodology notes</SubHead>
            <ul style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {narrative.methodology_notes.map((s, i) => <li key={i} style={{ lineHeight: 1.6 }}>{md(s)}</li>)}
            </ul>
          </Section>

          <p className="am-card__text" style={{ textAlign: 'center' }}>End of document · {narrative.document.classification}</p>
        </>}
      </div>
    </DsPage>
  );
}
