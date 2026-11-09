/**
 * Rep Dashboard on the Allmoxy design system. Data logic is the classic page's (RepDashboard.tsx,
 * kept at /rep-dashboard-classic): same snapshots (customer_profiles, churn_risk_matrix,
 * time_to_value, customer_base), the same bid-only overrides read from localStorage
 * ('allmoxy.bid_only.pending', written by Customer Detail; this page only reads it), the same
 * book (customer-base members, active_today and not a duplicate, filtered by owner), the same
 * churn window (customer_base.logo_flow, last 3 complete months, paused separate) and the same
 * trend rules (canonical by_month for All, cash-basis owner history otherwise; the in-progress
 * month never shown). The owner is still carried in ?rep= so links from the classic page work.
 *
 * Order follows what a rep acts on: the book in numbers, today's call list, card failures to fix,
 * then the trend, time to value and the risk signals behind the scores.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useSheetTab } from '../hooks/useSheetTab';
import { hubspotCompanyUrl } from '../lib/hubspot';
import {
  ChartCard, ColumnChart, DataTable, DsPage, Icon, KpiCard, KpiGrid, Select, SideSheet,
  downloadCsv, mlabel, thisMonth, addMonths, usd, usdk, useMonthRange,
} from '../design-system/parts';

type MonthlyCell = { subscription: number; services: number; connect: number; total: number };
type Profile = {
  allmoxy_customer_id: number; name: string; hubspot_company_id: string | null; status: string; pay_status: string | null;
  primary_segment: string | null; instance_owner_first_name: string | null; instance_owner: string | null;
  current_subscription_mrr: number; lifetime_subscription: number; years_with_us: number | null;
  sign_up_date: string | null; last_payment_date: string | null; excluded_from_logo_count?: boolean; active_today?: boolean;
  failed_3mo_count?: number; monthly_history: Record<string, MonthlyCell>;
};
type Tier = 'red' | 'yellow' | 'green' | 'unscored';
type MatrixCustomer = {
  allmoxy_customer_id: number; name: string; owner_name: string | null; tier: Tier; current_subscription_mrr: number;
  arr_at_risk: number; total_score: number; signal_1_orders: number; signal_2_launch: number; signal_3_recency: number;
  signal_4_risk: number; signal_5_tenure: number; days_since_last_contact: number | null; orders_label: string;
  risk_signals: Array<{ keyword: string; category: string; note_date?: string; snippet?: string }>; years_with_us: number | null;
  is_bid_only?: boolean;
};
type MatrixSnap = { customers: MatrixCustomer[] };
type TtvCustomer = { allmoxy_customer_id: number; owner_name: string | null; category: string; months_to_launch: number | null; is_launched: boolean };
type TtvSnap = { customers: TtvCustomer[] };
type FlowDetail = { allmoxy_customer_id: number; name: string; mrr: number };
type BaseSnap = {
  by_month: Array<{ month: string; customers: number; mrr: number }>;
  logo_flow: Array<{ month: string; churned_logos: number; lapsed_logos: number; paused_logos: number;
    details?: { churned?: FlowDetail[]; lapsed?: FlowDetail[]; paused?: FlowDetail[] } }>;
};

const BID_ONLY_STORAGE_KEY = 'allmoxy.bid_only.pending';
function readBidOnlyOverrides(): Record<string, boolean> {
  try { const raw = localStorage.getItem(BID_ONLY_STORAGE_KEY); return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

const TIER: Record<Tier, { word: string; tone: 'error' | 'warning' | 'success' | 'neutral' }> = {
  red: { word: 'Critical', tone: 'error' }, yellow: { word: 'Watch', tone: 'warning' },
  green: { word: 'Healthy', tone: 'success' }, unscored: { word: 'Unscored', tone: 'neutral' },
};
const TIER_RANK: Record<Tier, number> = { red: 0, yellow: 1, green: 2, unscored: 3 };
const SIGNAL: Record<string, { word: string; tone: 'error' | 'warning' | 'info' | 'neutral' }> = {
  cancel_intent: { word: 'Cancel intent', tone: 'error' },
  dissatisfaction: { word: 'Dissatisfaction', tone: 'error' },
  competitor: { word: 'Competitor mention', tone: 'warning' },
  disengagement: { word: 'Disengagement', tone: 'warning' },
  pricing_pressure: { word: 'Pricing pressure', tone: 'info' },
};
const signalOf = (cat: string) => SIGNAL[cat] ?? { word: cat.replace(/_/g, ' '), tone: 'neutral' as const };
const TTV_BUCKETS = ['0-3', '4-6', '7-12', '13-18', '19-24', '25+'];

function repName(p: { instance_owner_first_name: string | null; instance_owner: string | null }): string {
  return p.instance_owner_first_name?.trim() || p.instance_owner?.trim() || '';
}
const tenure = (y: number | null | undefined) => (y != null ? `${y.toFixed(1)}y` : '—');
const LIMIT = 25;

type DrillKey = 'book' | 'at_risk' | 'healthy';
type Sheet = { kind: 'drill'; key: DrillKey } | { kind: 'churn' } | { kind: 'signal'; cat: string | null } | null;
type DrillRow = {
  aid: number; name: string; ownerName: string; tier: Tier | null; status: string; payStatus: string | null;
  mrr: number; arrAtRisk: number; hubspot_company_id: string | null; yearsWithUs: number | null;
};

export default function RepDashboardDS() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: profilesData, isLoading: profilesLoading, error: profilesError } = useSheetTab<Profile>('customer_profiles');
  const matrixQuery = useSheetTab<MatrixSnap>('churn_risk_matrix');
  const ttvQuery = useSheetTab<TtvSnap>('time_to_value');
  const baseQuery = useSheetTab('customer_base');
  const matrixRaw = matrixQuery.data as unknown as MatrixSnap | undefined;
  const ttvRaw = ttvQuery.data as unknown as TtvSnap | undefined;
  const baseRaw = baseQuery.data as unknown as BaseSnap | undefined;

  const [sheet, setSheet] = useState<Sheet>(null);
  const [sheetAll, setSheetAll] = useState(false);
  const [callAll, setCallAll] = useState(false);
  const [cfAll, setCfAll] = useState(false);
  const openSheet = (s: Sheet) => { setSheet(s); setSheetAll(false); };

  // Live bid-only overrides, same listener pattern as the classic page.
  const [bidOnlyOverrides, setBidOnlyOverrides] = useState<Record<string, boolean>>(() => readBidOnlyOverrides());
  useEffect(() => {
    const reload = () => setBidOnlyOverrides(readBidOnlyOverrides());
    window.addEventListener('storage', reload);
    const t = window.setInterval(() => { if (document.visibilityState === 'visible') reload(); }, 1500);
    return () => { window.removeEventListener('storage', reload); window.clearInterval(t); };
  }, []);

  // Bid-only overrides re-score the matrix exactly as the classic page does.
  const matrixCustomers = useMemo<MatrixCustomer[]>(() => {
    if (!matrixRaw?.customers) return [];
    return matrixRaw.customers.map((c) => {
      const localOverride = bidOnlyOverrides[String(c.allmoxy_customer_id)];
      const effectiveBidOnly = localOverride !== undefined ? localOverride : c.is_bid_only;
      const wasBidOnly = c.is_bid_only;
      if (effectiveBidOnly === wasBidOnly) return c;
      const s1New = effectiveBidOnly ? 35 : (wasBidOnly ? 0 : c.signal_1_orders);
      const s2New = effectiveBidOnly ? 25 : (wasBidOnly ? 0 : c.signal_2_launch);
      const s3Effective = effectiveBidOnly ? 20 : c.signal_3_recency;
      const s5 = c.signal_5_tenure;
      const s5Effective = effectiveBidOnly && s5 < 0 ? 0 : s5;
      const newTotal = s1New + s2New + s3Effective + c.signal_4_risk + s5Effective;
      const newTier: Tier = newTotal >= 70 ? 'green' : newTotal >= 40 ? 'yellow' : 'red';
      return { ...c, signal_1_orders: s1New, signal_2_launch: s2New, signal_3_recency: s3Effective, signal_5_tenure: s5Effective,
        total_score: newTotal, tier: newTier, orders_label: effectiveBidOnly ? 'bid_only' : c.orders_label };
    });
  }, [matrixRaw, bidOnlyOverrides]);

  const profiles = useMemo(() => profilesData?.rows ?? [], [profilesData]);
  // The book = canonical customer-base membership (active_today), duplicates never members.
  const baseProfiles = useMemo(() => profiles.filter((p) => p.active_today === true && !p.excluded_from_logo_count), [profiles]);
  const profileByAidAll = useMemo(() => new Map(profiles.map((p) => [p.allmoxy_customer_id, p])), [profiles]);

  const ownerOptions = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of baseProfiles) { const o = repName(p); if (o) m.set(o, (m.get(o) ?? 0) + 1); }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
  }, [baseProfiles]);

  const selectedRep = searchParams.get('rep') ?? '';
  const isAll = selectedRep === 'all';
  useEffect(() => {
    if (!selectedRep && ownerOptions.length > 0) setSearchParams({ rep: 'all' }, { replace: true });
  }, [selectedRep, ownerOptions, setSearchParams]);
  const pickRep = (name: string) => { setSearchParams({ rep: name }, { replace: true }); setCallAll(false); setCfAll(false); };
  const whose = isAll ? 'all reps' : `${selectedRep}'s book`;

  const book = useMemo(() => baseProfiles.filter((p) => isAll || repName(p) === selectedRep), [baseProfiles, selectedRep, isAll]);
  const cardFailureBook = useMemo(() => book.filter((p) => p.pay_status === 'Active - Card Failure'), [book]);
  const bookIds = useMemo(() => new Set(book.map((p) => p.allmoxy_customer_id)), [book]);
  const matrixForRep = useMemo(() => matrixCustomers.filter((c) => bookIds.has(c.allmoxy_customer_id)), [matrixCustomers, bookIds]);
  const matrixByAid = useMemo(() => new Map(matrixForRep.map((c) => [c.allmoxy_customer_id, c])), [matrixForRep]);

  const kpis = useMemo(() => {
    const totalMrr = book.reduce((s, p) => s + (p.current_subscription_mrr || 0), 0);
    const tierCount = (t: string) => matrixForRep.filter((c) => c.tier === t).length;
    const tierMrr = (t: string) => matrixForRep.filter((c) => c.tier === t).reduce((s, c) => s + (c.current_subscription_mrr || 0), 0);
    const arrAtRisk = matrixForRep.reduce((s, c) => s + (c.arr_at_risk || 0), 0);
    // Churned (last 3 mo): customer_base.logo_flow over the last 3 COMPLETE months, churned +
    // lapsed logos, paused reported separately; owner via the profile lookup.
    const curKey = thisMonth();
    const flowLast3 = (baseRaw?.logo_flow ?? []).filter((f) => f.month < curKey).slice(-3);
    const ownerMatch = (d: FlowDetail) => {
      if (isAll) return true;
      const p = profileByAidAll.get(d.allmoxy_customer_id);
      return !!p && repName(p) === selectedRep;
    };
    const lost = flowLast3.flatMap((f) => [
      ...(f.details?.churned ?? []).map((d) => ({ ...d, month: f.month, kind: 'Churned' })),
      ...(f.details?.lapsed ?? []).map((d) => ({ ...d, month: f.month, kind: 'Lapsed (non-payment)' })),
    ]).filter(ownerMatch);
    const paused = flowLast3.flatMap((f) => (f.details?.paused ?? []).map((d) => ({ ...d, month: f.month, kind: 'Paused' }))).filter(ownerMatch);
    const recencies = matrixForRep.map((c) => c.days_since_last_contact).filter((v): v is number => v != null);
    return {
      bookCount: book.length, totalMrr, arr: totalMrr * 12, arrAtRisk,
      redCount: tierCount('red'), redMrr: tierMrr('red'), yellowCount: tierCount('yellow'),
      greenCount: tierCount('green'), greenMrr: tierMrr('green'),
      lost, paused,
      lostMrr: lost.reduce((s, d) => s + (d.mrr || 0), 0),
      pausedMrr: paused.reduce((s, d) => s + (d.mrr || 0), 0),
      churnedWindow: flowLast3.length ? `${mlabel(flowLast3[0].month)} to ${mlabel(flowLast3[flowLast3.length - 1].month)}` : null,
      avgDaysSinceContact: recencies.length === 0 ? null : Math.round(recencies.reduce((a, b) => a + b, 0) / recencies.length),
    };
  }, [book, matrixForRep, baseRaw, profileByAidAll, isAll, selectedRep]);

  // MRR trend: canonical customer_base.by_month for All; otherwise the owner's per-customer
  // subscription history (cash basis, incl. since-churned accounts, duplicates dropped). Ends at
  // the last COMPLETE month; annual prepay amortized forward never shows future months.
  const historicalSet = useMemo(
    () => profiles.filter((p) => !p.excluded_from_logo_count && (p.lifetime_subscription || 0) > 0 && (isAll || repName(p) === selectedRep)),
    [profiles, selectedRep, isAll],
  );
  const trendIsCanonical = isAll && (baseRaw?.by_month?.length ?? 0) > 0;
  const mrrTrend = useMemo(() => {
    const lastCompleteKey = addMonths(thisMonth(), -1);
    if (trendIsCanonical) {
      return (baseRaw?.by_month ?? []).filter((r) => r.month <= lastCompleteKey)
        .map((r) => ({ month: r.month, mrr: Math.round(r.mrr * 100) / 100, logos: r.customers }))
        .sort((a, b) => a.month.localeCompare(b.month));
    }
    const monthAgg = new Map<string, { mrr: number; logos: number }>();
    for (const p of historicalSet) {
      for (const [month, cell] of Object.entries(p.monthly_history || {})) {
        if (month > lastCompleteKey) continue;
        const sub = cell?.subscription || 0;
        if (sub <= 0) continue;
        const e = monthAgg.get(month) ?? { mrr: 0, logos: 0 };
        e.mrr += sub; e.logos += 1;
        monthAgg.set(month, e);
      }
    }
    return [...monthAgg.entries()].map(([month, v]) => ({ month, mrr: Math.round(v.mrr * 100) / 100, logos: v.logos }))
      .sort((a, b) => a.month.localeCompare(b.month));
  }, [historicalSet, trendIsCanonical, baseRaw]);
  const range = useMonthRange(mrrTrend.map((r) => r.month));
  const trendByMonth = useMemo(() => new Map(mrrTrend.map((r) => [r.month, r])), [mrrTrend]);
  const trendShown = range.months.map((m) => trendByMonth.get(m)!).filter(Boolean);

  // Today's call list: Critical + Watch, highest ARR at risk first (classic showed the top 25).
  const attackList = useMemo(() => matrixForRep.filter((c) => c.tier === 'red' || c.tier === 'yellow')
    .sort((a, b) => (b.arr_at_risk || 0) - (a.arr_at_risk || 0)), [matrixForRep]);

  const ttv = useMemo(() => {
    const samples = (ttvRaw?.customers ?? [])
      .filter((c) => bookIds.has(c.allmoxy_customer_id) && c.is_launched && c.months_to_launch != null && c.months_to_launch >= 0)
      .map((c) => c.months_to_launch as number).sort((a, b) => a - b);
    const buckets: Record<string, number> = Object.fromEntries(TTV_BUCKETS.map((b) => [b, 0]));
    for (const m of samples) {
      if (m <= 3) buckets['0-3']++; else if (m <= 6) buckets['4-6']++; else if (m <= 12) buckets['7-12']++;
      else if (m <= 18) buckets['13-18']++; else if (m <= 24) buckets['19-24']++; else buckets['25+']++;
    }
    const n = samples.length;
    const median = n === 0 ? null : n % 2 === 1 ? samples[Math.floor(n / 2)] : Math.round((samples[n / 2 - 1] + samples[n / 2]) / 2);
    const p90 = n === 0 ? null : samples[Math.min(n - 1, Math.floor(0.9 * n))];
    return { counts: TTV_BUCKETS.map((b) => buckets[b]), samples: n, median, p90 };
  }, [ttvRaw, bookIds]);

  const riskBreakdown = useMemo(() => {
    const byCat = new Map<string, { n: number; customers: Set<number> }>();
    let totalSignals = 0;
    for (const c of matrixForRep) {
      for (const s of c.risk_signals || []) {
        const e = byCat.get(s.category) ?? { n: 0, customers: new Set<number>() };
        e.n++; e.customers.add(c.allmoxy_customer_id);
        byCat.set(s.category, e);
        totalSignals++;
      }
    }
    const withAny = matrixForRep.filter((c) => (c.risk_signals || []).length > 0).length;
    return { byCat: [...byCat.entries()].sort((a, b) => b[1].n - a[1].n), totalSignals, withAny };
  }, [matrixForRep]);

  const isLoading = profilesLoading || matrixQuery.isLoading || ttvQuery.isLoading || baseQuery.isLoading;
  const L = (v: string) => (isLoading ? '…' : v);

  // ---- shared cells
  const detailHref = (aid: number) => `/customer-detail?id=${encodeURIComponent(String(aid))}`;
  const nameCell = (aid: number, name: string): ReactNode => (
    <a key="n" className="am-btn am-btn--text" href={detailHref(aid)} style={{ whiteSpace: 'normal', textAlign: 'left', maxWidth: 280 }}
      onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); navigate(detailHref(aid)); }}>{name}</a>
  );
  const tierTag = (t: Tier | null) => (t ? <span key="t" className={`am-tag am-tag--${TIER[t].tone}`}>{TIER[t].word}</span> : '—');
  const hubspotCell = (id: string | null, name: string): ReactNode => {
    const hs = hubspotCompanyUrl(id);
    return hs ? (
      <a key="h" className="am-btn am-btn--text" href={hs} target="_blank" rel="noopener noreferrer" aria-label={`Open ${name} in HubSpot`}>Open<Icon name="open_in_new" /></a>
    ) : '—';
  };

  // ---- drill-down rows (Book / Critical / Healthy), same sources as the classic panel
  const drillRows = (key: DrillKey): DrillRow[] => {
    let source: Array<{ profile?: Profile; matrix?: MatrixCustomer }>;
    if (key === 'book') source = book.map((p) => ({ profile: p, matrix: matrixByAid.get(p.allmoxy_customer_id) }));
    else {
      const tier = key === 'at_risk' ? 'red' : 'green';
      const byAid = new Map(book.map((p) => [p.allmoxy_customer_id, p]));
      source = matrixForRep.filter((c) => c.tier === tier).map((c) => ({ profile: byAid.get(c.allmoxy_customer_id), matrix: c }));
    }
    return source.map(({ profile, matrix }) => ({
      aid: matrix?.allmoxy_customer_id ?? profile!.allmoxy_customer_id,
      name: matrix?.name ?? profile?.name ?? '',
      ownerName: profile ? repName(profile) : (matrix?.owner_name ?? ''),
      tier: matrix?.tier ?? null,
      status: profile?.status ?? '',
      payStatus: profile?.pay_status ?? null,
      mrr: profile?.current_subscription_mrr ?? matrix?.current_subscription_mrr ?? 0,
      arrAtRisk: matrix?.arr_at_risk ?? 0,
      hubspot_company_id: profile?.hubspot_company_id ?? null,
      yearsWithUs: profile?.years_with_us ?? matrix?.years_with_us ?? null,
    }));
  };

  const exportBook = () => downloadCsv(`rep_book_${isAll ? 'all' : selectedRep.replace(/\W+/g, '_')}`,
    ['Allmoxy ID', 'Customer', 'Owner', 'Tier', 'Status', 'Pay status', 'MRR', 'ARR at risk', 'Score', 'Days since contact', 'Tenure (yrs)', 'HubSpot ID'],
    book.map((p) => {
      const m = matrixByAid.get(p.allmoxy_customer_id);
      return [p.allmoxy_customer_id, p.name, repName(p), m ? TIER[m.tier].word : '', p.status ?? '', p.pay_status ?? '',
        p.current_subscription_mrr || 0, m?.arr_at_risk ?? 0, m?.total_score ?? '', m?.days_since_last_contact ?? '', p.years_with_us ?? '', p.hubspot_company_id ?? ''];
    }));

  // ---- side sheet
  let sheetNode: ReactNode = null;
  if (sheet?.kind === 'drill') {
    const rows = drillRows(sheet.key);
    const atRisk = sheet.key === 'at_risk';
    const title = sheet.key === 'book' ? 'Book' : atRisk ? 'Critical' : 'Healthy';
    const totalMrr = rows.reduce((s, r) => s + r.mrr, 0);
    const totalArr = rows.reduce((s, r) => s + r.arrAtRisk, 0);
    const cols: Array<[string, boolean]> = [['Customer', false], ['Owner', false], ['Tier', false], ['Status', false], ['Pay status', false], ['MRR', true],
      ...(atRisk ? [['ARR at risk', true] as [string, boolean]] : []), ['Tenure', true], ['HubSpot', false]];
    sheetNode = (
      <SideSheet open onClose={() => setSheet(null)} title={`${title} · ${isAll ? 'all reps' : `${selectedRep}'s book`}`}
        text={`${rows.length} customer${rows.length === 1 ? '' : 's'} · ${usd(totalMrr)}/mo${atRisk ? ` · ${usd(totalArr)} ARR at risk` : ''}`}>
        {rows.length === 0 ? <p className="am-card__text">No customers in this group.</p> : <>
          <div style={{ overflowX: 'auto' }}>
            <DataTable label={`${title} customers`} cols={cols}
              rows={rows.map((r) => [nameCell(r.aid, r.name), r.ownerName || '—', tierTag(r.tier), r.status || '—', r.payStatus || '—', usd(r.mrr),
                ...(atRisk ? [usd(r.arrAtRisk)] : []), tenure(r.yearsWithUs), hubspotCell(r.hubspot_company_id, r.name)])}
              sortValues={rows.map((r) => [r.name.toLowerCase(), (r.ownerName || '~').toLowerCase(), TIER_RANK[r.tier ?? 'unscored'], r.status, (r.payStatus || '').toLowerCase(), r.mrr,
                ...(atRisk ? [r.arrAtRisk] : []), r.yearsWithUs ?? -1, null])}
              defaultSort={{ col: 5, dir: 'desc' }} limit={sheetAll ? undefined : LIMIT}
              foot={[`Total · ${rows.length} customers`, '', '', '', '', usd(totalMrr), ...(atRisk ? [usd(totalArr)] : []), '', '']}
              onFoot={() => setSheetAll(true)} footClickable={(c) => (c === 0 || c === 5 || (atRisk && c === 6)) && !sheetAll && rows.length > LIMIT} />
          </div>
          {!sheetAll && rows.length > LIMIT && <button className="am-btn am-btn--text" onClick={() => setSheetAll(true)}>Show all {rows.length}</button>}
        </>}
      </SideSheet>
    );
  } else if (sheet?.kind === 'churn') {
    const rows = [...kpis.lost, ...kpis.paused].sort((a, b) => b.month.localeCompare(a.month) || (b.mrr || 0) - (a.mrr || 0));
    sheetNode = (
      <SideSheet open onClose={() => setSheet(null)} title={`Left the base · ${kpis.churnedWindow ?? 'last 3 months'}`}
        text={`Churned and lapsed logos from the canonical logo flow (customer_base.logo_flow) over the last 3 complete months. Paused logos are listed separately: they are expected to return. MRR is each logo's MRR when it left. ${isAll ? 'All reps.' : `Owner = ${selectedRep} (current HubSpot owner).`}`}>
        {rows.length === 0 ? <p className="am-card__text">No logos left the base in this window.</p> : (
          <DataTable label="Logos that left" cols={[['Customer', false], ['Month', false], ['Type', false], ['MRR', true]]}
            rows={rows.map((r) => [nameCell(r.allmoxy_customer_id, r.name), mlabel(r.month),
              <span key="k" className={`am-tag am-tag--${r.kind === 'Paused' ? 'neutral' : r.kind === 'Churned' ? 'error' : 'warning'}`}>{r.kind}</span>, usd(r.mrr || 0)])}
            sortValues={rows.map((r) => [r.name.toLowerCase(), r.month, r.kind, r.mrr || 0])}
            foot={[`Lost · ${kpis.lost.length} logos (+ ${kpis.paused.length} paused)`, '', '', `${usd(kpis.lostMrr)} (+ ${usd(kpis.pausedMrr)})`]} />
        )}
      </SideSheet>
    );
  } else if (sheet?.kind === 'signal') {
    const cat = sheet.cat;
    const rows = matrixForRep.filter((c) => (c.risk_signals || []).some((s) => cat == null || s.category === cat))
      .map((c) => ({ c, sigs: (c.risk_signals || []).filter((s) => cat == null || s.category === cat) }));
    sheetNode = (
      <SideSheet open onClose={() => setSheet(null)} title={cat ? `${signalOf(cat).word} · ${whose}` : `All risk signals · ${whose}`}
        text="Keywords flagged in HubSpot notes over the last 180 days.">
        <div style={{ overflowX: 'auto' }}>
          <DataTable label="Customers with risk signals" cols={[['Customer', false], ['Tier', false], ['Mentions', true], ['Keywords', false], ['MRR', true]]}
            rows={rows.map(({ c, sigs }) => [nameCell(c.allmoxy_customer_id, c.name), tierTag(c.tier), String(sigs.length),
              [...new Set(sigs.map((s) => s.keyword))].join(', '), usd(c.current_subscription_mrr || 0)])}
            sortValues={rows.map(({ c, sigs }) => [c.name.toLowerCase(), TIER_RANK[c.tier], sigs.length, sigs[0]?.keyword ?? '', c.current_subscription_mrr || 0])}
            defaultSort={{ col: 2, dir: 'desc' }}
            foot={[`Total · ${rows.length} customers`, '', String(rows.reduce((s, r) => s + r.sigs.length, 0)), '', usd(rows.reduce((s, r) => s + (r.c.current_subscription_mrr || 0), 0))]} />
        </div>
      </SideSheet>
    );
  }

  const callShown = attackList;
  const callMrr = attackList.reduce((s, c) => s + (c.current_subscription_mrr || 0), 0);
  const callArr = attackList.reduce((s, c) => s + (c.arr_at_risk || 0), 0);
  const cfMrr = cardFailureBook.reduce((s, p) => s + (p.current_subscription_mrr || 0), 0);

  return (
    <DsPage
      path="/rep-dashboard"
      title="Rep Dashboard"
      subtitle="Customer Success dashboard. Pick a rep to see their book, their churn risk picture and their top intervention targets, or All for the rolled-up view."
      actions={<>
        <span className="am-card__text">Rep</span>
        <Select label="Rep" width={240} value={selectedRep}
          options={[['all', `All (${baseProfiles.length})`], ...ownerOptions.map((o) => [o.name, `${o.name} (${o.count})`] as [string, string])]}
          onPick={pickRep} />
        <button className="am-btn am-btn--outlined" onClick={exportBook} disabled={!book.length}><Icon name="download" />Export book</button>
      </>}
      overlays={sheetNode}
    >
      {profilesError ? <p className="am-card__text">Failed to load customer_profiles: {String(profilesError)}</p> : null}
      {!isLoading && ownerOptions.length === 0 && <p className="am-card__text">No reps found in instance_owner data.</p>}
      {!selectedRep && !isLoading && <p className="am-card__text">Pick a rep above (or All) to load the dashboard.</p>}

      {selectedRep && <>
        <KpiGrid max={4}>
          <KpiCard label="Book" value={L(kpis.bookCount.toLocaleString())} hint={`${usd(kpis.totalMrr)}/mo · ${usd(kpis.arr)} ARR`}
            onOpen={() => openSheet({ kind: 'drill', key: 'book' })} />
          <KpiCard label="At risk" value={L(kpis.redCount.toLocaleString())}
            hint={`${usd(kpis.redMrr)}/mo · ${usd(kpis.redMrr * 12)} ARR · ${usd(kpis.arrAtRisk)} ARR at risk across the book`}
            tag="Critical" tagTone="error" onOpen={() => openSheet({ kind: 'drill', key: 'at_risk' })} />
          <KpiCard label="Healthy" value={L(kpis.greenCount.toLocaleString())}
            hint={`${usd(kpis.greenMrr)}/mo · ${usd(kpis.greenMrr * 12)} ARR · ${kpis.yellowCount} watch · ${kpis.greenCount + kpis.yellowCount + kpis.redCount} scored`}
            tag="Healthy" tagTone="success" onOpen={() => openSheet({ kind: 'drill', key: 'healthy' })} />
          <KpiCard label="Time to value" value={L(`${ttv.median ?? '—'} mo`)}
            hint={`Median months from first payment to Live Date · p90 ${ttv.p90 ?? '—'} mo · ${ttv.samples} launched ${isAll ? 'across all reps' : "in this rep's book"}`} />
        </KpiGrid>
        <KpiGrid max={4}>
          <KpiCard label="Avg days since contact" value={L(String(kpis.avgDaysSinceContact ?? '—'))} hint={`Across ${matrixForRep.length} active accounts`} />
          <KpiCard label="Churned (last 3 mo)" value={L(kpis.lost.length.toLocaleString())}
            hint={`${usd(kpis.lostMrr)}/mo lost · + ${kpis.paused.length} paused (${usd(kpis.pausedMrr)}/mo)${kpis.churnedWindow ? ` · ${kpis.churnedWindow}` : ''}`}
            tag={kpis.lost.length > 0 ? 'Lost logos' : 'None lost'} tagTone={kpis.lost.length > 0 ? 'error' : 'success'}
            onOpen={() => openSheet({ kind: 'churn' })} />
          <KpiCard label="Card failures" value={L(cardFailureBook.length.toLocaleString())} hint={`${usd(cfMrr)}/mo MRR at risk until a new card is on file`}
            tag={cardFailureBook.length > 0 ? 'Fix billing' : 'Clear'} tagTone={cardFailureBook.length > 0 ? 'warning' : 'success'}
            onOpen={cardFailureBook.length ? () => document.getElementById('rep-card-failures')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) : undefined} />
          <KpiCard label="Risk signals flagged" value={L(riskBreakdown.totalSignals.toLocaleString())}
            hint={riskBreakdown.totalSignals === 0 ? 'None in HubSpot notes in the last 180 days' : `In HubSpot notes, across ${riskBreakdown.withAny} customers`}
            tag={riskBreakdown.totalSignals > 0 ? 'Review' : 'None'} tagTone={riskBreakdown.totalSignals > 0 ? 'warning' : 'success'}
            onOpen={riskBreakdown.totalSignals ? () => openSheet({ kind: 'signal', cat: null }) : undefined} />
        </KpiGrid>

        {/* Today's call list */}
        <section className="am-card am-card--outlined">
          <div className="am-chart__head">
            <span className="am-chart__title">Today's call list · {attackList.length} customers · {usd(callArr)} ARR at risk</span>
            <span className="am-chart__caption">Critical and Watch customers {isAll ? 'across all reps' : "in this rep's book"}, highest ARR at risk first. Start here every morning; select a name to open the full Customer Detail.</span>
          </div>
          {isLoading ? <p className="am-card__text">Loading…</p> : attackList.length === 0 ? (
            <p className="am-card__text">No Critical or Watch customers {isAll ? 'in the cohort' : "in this rep's book"}.</p>
          ) : <>
            <div style={{ overflowX: 'auto' }}>
              <DataTable label="Today's call list"
                cols={[['Tier', false], ['Customer', false], ['MRR', true], ['ARR at risk', true], ['Score', true], ['Days since contact', true], ['Contact', false], ['Why', false]]}
                rows={callShown.map((c) => [tierTag(c.tier), nameCell(c.allmoxy_customer_id, c.name), usd(c.current_subscription_mrr || 0), usd(c.arr_at_risk || 0),
                  String(c.total_score), c.days_since_last_contact != null ? String(c.days_since_last_contact) : '—',
                  (c.days_since_last_contact ?? 0) > 60 ? <span key="o" className="am-tag am-tag--warning">Over 60 days</span> : '',
                  (c.risk_signals && c.risk_signals.length > 0) ? c.risk_signals.slice(0, 2).map((s) => s.keyword).join(', ') : c.orders_label?.replace('_', ' ') || ''])}
                sortValues={callShown.map((c) => [TIER_RANK[c.tier], c.name.toLowerCase(), c.current_subscription_mrr || 0, c.arr_at_risk || 0, c.total_score,
                  c.days_since_last_contact, (c.days_since_last_contact ?? 0) > 60 ? 1 : 0, c.risk_signals?.[0]?.keyword ?? c.orders_label ?? ''])}
                defaultSort={{ col: 3, dir: 'desc' }} limit={callAll ? undefined : LIMIT}
                foot={[`Total · ${attackList.length} customers`, '', usd(callMrr), usd(callArr), '', '', '', '']}
                onFoot={() => setCallAll(true)} footClickable={(c) => (c === 0 || c === 2 || c === 3) && !callAll && attackList.length > LIMIT} />
            </div>
            {!callAll && attackList.length > LIMIT && <button className="am-btn am-btn--text" onClick={() => setCallAll(true)}>Show all {attackList.length}</button>}
          </>}
        </section>

        {/* Card failures */}
        <section id="rep-card-failures" className="am-card am-card--outlined">
          <div className="am-row am-row--spread">
            <div className="am-chart__head">
              <span className="am-chart__title">Card failures: reach out to fix billing · {cardFailureBook.length} customer{cardFailureBook.length === 1 ? '' : 's'} · {usd(cfMrr)}/mo MRR at risk</span>
              <span className="am-chart__caption">HubSpot pay status "Active - Card Failure". Their last charge bounced: call them and get a new card on file. Easy wins; left alone they roll into churned.</span>
            </div>
            {cardFailureBook.length > 0 && <span className="am-tag am-tag--warning">Needs action</span>}
          </div>
          {cardFailureBook.length === 0 ? <p className="am-card__text">No card failures right now.</p> : <>
            <div style={{ overflowX: 'auto' }}>
              <DataTable label="Card failures"
                cols={[['Customer', false], ['Owner', false], ['MRR', true], ['Last payment', true], ['Failed (3 mo)', true], ['Tenure', true]]}
                rows={cardFailureBook.map((c) => [nameCell(c.allmoxy_customer_id, c.name), repName(c) || '—', usd(c.current_subscription_mrr || 0),
                  c.last_payment_date ?? '—', c.failed_3mo_count != null ? String(c.failed_3mo_count) : '—', tenure(c.years_with_us)])}
                sortValues={cardFailureBook.map((c) => [(c.name || '').toLowerCase(), repName(c).toLowerCase() || '~', c.current_subscription_mrr || 0,
                  c.last_payment_date || '', c.failed_3mo_count ?? -1, c.years_with_us ?? -1])}
                defaultSort={{ col: 2, dir: 'desc' }} limit={cfAll ? undefined : LIMIT}
                foot={[`Total · ${cardFailureBook.length} customers`, '', usd(cfMrr), '', '', '']}
                onFoot={() => setCfAll(true)} footClickable={(c) => (c === 0 || c === 2) && !cfAll && cardFailureBook.length > LIMIT} />
            </div>
            {!cfAll && cardFailureBook.length > LIMIT && <button className="am-btn am-btn--text" onClick={() => setCfAll(true)}>Show all {cardFailureBook.length}</button>}
          </>}
        </section>

        {/* MRR trend */}
        <ChartCard title={`MRR trend${trendIsCanonical ? '' : ' (cash basis)'} · ${whose}`}
          caption={trendIsCanonical
            ? `Canonical customer-base MRR each month (customer_base.by_month: invoiced, annual payers amortized, duplicates excluded), the same series as the Overview. ${range.rangeText}. Ends at the last complete month; ${mlabel(thisMonth())} (in progress) is not shown.`
            : `Subscription collected from customers ${selectedRep} owns, including since-churned accounts so earlier months show the book as it was. Cash basis, because per-owner accrual history isn't published, so it differs from the Book card. Duplicates excluded. ${range.rangeText}. Ends at the last complete month; ${mlabel(thisMonth())} (in progress) is not shown.`}>
          {range.controls}
          {isLoading ? <p className="am-card__text">Loading…</p> : mrrTrend.length === 0 ? <p className="am-card__text">No MRR history available.</p> : (
            <ColumnChart months={trendShown.map((r) => r.month)} fmt={usdk} aria={`Monthly MRR, ${whose}`}
              series={[{ key: 'mrr', label: 'MRR', tone: 'div-1', values: trendShown.map((r) => r.mrr) }]}
              tipRows={(i) => [['MRR', usd(trendShown[i].mrr)], ['Logos', trendShown[i].logos.toLocaleString()]]} />
          )}
        </ChartCard>

        {ttv.samples > 0 ? (
            <ChartCard title={`Time to value · ${whose}`}
              caption={`Months between first payment and Live Date for ${ttv.samples} launched customers. Median ${ttv.median} months · p90 ${ttv.p90} months. Compare with the company-wide Time to Value page.`}>
              <ColumnChart months={TTV_BUCKETS} fmt={(v) => String(Math.round(v))} aria="Launched customers by months to launch"
                catLabel={(k) => `${k} mo`} catTitle={(k) => `${k} months`}
                series={[{ key: 'n', label: 'Customers', tone: 'div-1', values: ttv.counts }]} />
            </ChartCard>
          ) : (
            <section className="am-card am-card--outlined">
              <div className="am-chart__head"><span className="am-chart__title">Time to value · {whose}</span></div>
              <p className="am-card__text">No launched customers with a Live Date {isAll ? 'yet' : "in this rep's book"}.</p>
            </section>
          )}

          <section className="am-card am-card--outlined">
            <div className="am-chart__head">
              <span className="am-chart__title">Risk signals flagged in HubSpot notes</span>
              <span className="am-chart__caption">Keyword mentions over the last 180 days. Select a count to list the customers behind it.</span>
            </div>
            {riskBreakdown.totalSignals === 0 ? <p className="am-card__text">None in the last 180 days.</p> : (
              <DataTable label="Risk signals by type" cols={[['Signal', false], ['Mentions', true], ['Customers', true]]}
                rows={riskBreakdown.byCat.map(([cat, e]) => [<span key="s" className={`am-tag am-tag--${signalOf(cat).tone}`}>{signalOf(cat).word}</span>, e.n.toLocaleString(), e.customers.size.toLocaleString()])}
                sortValues={riskBreakdown.byCat.map(([cat, e]) => [signalOf(cat).word, e.n, e.customers.size])}
                clickable={(c) => c > 0} onCell={(row) => openSheet({ kind: 'signal', cat: riskBreakdown.byCat[row][0] })}
                foot={['Total', riskBreakdown.totalSignals.toLocaleString(), `${riskBreakdown.withAny.toLocaleString()} customers`]}
                onFoot={() => openSheet({ kind: 'signal', cat: null })} />
            )}
          </section>
      </>}
    </DsPage>
  );
}
