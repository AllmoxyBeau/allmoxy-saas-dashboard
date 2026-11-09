/**
 * Overview on the Allmoxy design system (pilot approved by Beau 2026-11-09). Assembled from the
 * shared certified parts in src/design-system/parts.tsx.
 *
 * Data logic matches the classic Overview (NorthStar.tsx, kept at /overview-classic): headline
 * figures from customer_base (canonical), stream series from mrr_by_month with the Services /
 * Connect tab totals overriding the stale stacked rows, and the subscription and customer
 * series on the canonical base wherever its accrual window covers the month.
 */
import { useMemo, useState } from 'react';
import { useSheetTab } from '../hooks/useSheetTab';
import {
  ChartCard, ColumnChart, DataTable, DsPage, FilterChip, KpiCard, SideSheet,
  addMonths, mlabel, mshort, thisMonth, usd, usdk, useMonthRange,
} from '../design-system/parts';

type MRRRow = { month: string; logo_qty: number | null; mrr_subscription: number | null; mrr_services: number | null; mrr_connect: number | null };
type PerCustomer = { customer_name: string } & Record<string, number | null>;
type Member = { allmoxy_customer_id: number; name: string; mrr: number; source?: string };
type Base = { customers: number; mrr: number; as_of: string; by_month: Array<{ month: string; customers: number; mrr: number }>; members: Member[] };

export default function OverviewDS() {
  const { data: mrrData, isLoading, error } = useSheetTab<MRRRow>('mrr_by_month');
  const { data: servicesData } = useSheetTab<PerCustomer>('services_by_month');
  const { data: connectData } = useSheetTab('connect_by_month');
  const { data: connectByCustData } = useSheetTab<PerCustomer>('connect_by_customer_month');
  const { data: baseData } = useSheetTab('customer_base');
  const { data: cmData } = useSheetTab('current_month');
  const base = baseData as unknown as Base | undefined;
  const dataThrough = (cmData as unknown as { as_of?: string } | undefined)?.as_of;
  const [openSheet, setOpenSheet] = useState<string | null>(null);

  const currentMonth = thisMonth();
  const rows = useMemo<MRRRow[]>(() => {
    if (!mrrData?.rows) return [];
    const svcT = (servicesData?.monthlyTotals ?? {}) as Record<string, number>;
    const conT = ((connectData as unknown as { monthlyTotals?: Record<string, number> })?.monthlyTotals ?? {}) as Record<string, number>;
    return mrrData.rows.map((r) => ({ ...r, mrr_services: svcT[r.month] ?? r.mrr_services ?? 0, mrr_connect: conT[r.month] ?? r.mrr_connect ?? 0 }));
  }, [mrrData, servicesData, connectData]);
  const complete = useMemo(() => rows.filter((r) => r.month < currentMonth).map((r) => r.month), [rows, currentMonth]);
  const baseBy = useMemo(() => new Map((base?.by_month ?? []).map((r) => [r.month, r])), [base]);
  const rowBy = useMemo(() => new Map(rows.map((r) => [r.month, r])), [rows]);
  const customersAt = (m: string) => baseBy.get(m)?.customers ?? rowBy.get(m)?.logo_qty ?? 0;
  const subAt = (m: string) => baseBy.get(m)?.mrr ?? rowBy.get(m)?.mrr_subscription ?? 0;
  const svcAt = (m: string) => rowBy.get(m)?.mrr_services ?? 0;
  const conAt = (m: string) => rowBy.get(m)?.mrr_connect ?? 0;
  const totalAt = (m: string) => subAt(m) + svcAt(m) + conAt(m);

  const asOf = base?.as_of ?? complete[complete.length - 1];
  const prev = asOf ? addMonths(asOf, -1) : undefined;
  const annualAmort = useMemo(() => (base?.members ?? []).filter((x) => x.source === 'annual_amortized').reduce((s, x) => s + x.mrr, 0), [base]);
  const custRange = useMonthRange(complete);
  const revRange = useMonthRange(complete);
  const spark12 = useMemo(() => complete.slice(-12), [complete]);
  const [streams, setStreams] = useState({ Subscription: true, Connect: true, Services: true });

  const change = (cur: number, before: number, money = true) => {
    if (!prev) return '';
    const d = cur - before;
    if (Math.abs(d) < 0.5) return `Flat vs ${mshort(prev)}`;
    return `${d > 0 ? 'Up' : 'Down'} ${money ? usd(Math.abs(d)) : Math.abs(d).toLocaleString()} from ${mshort(prev)}`;
  };
  const ready = !isLoading && !!asOf && !!prev && !!base;
  const total = ready ? base!.mrr + svcAt(asOf!) + conAt(asOf!) : 0;

  const members = useMemo(() => [...(base?.members ?? [])].sort((a, b) => b.mrr - a.mrr), [base]);
  const memberRows = members.map((x) => [x.name, x.source === 'annual_amortized' ? 'Annual (amortized)' : 'Monthly', usd(x.mrr)]);
  const perCustomer = (d: { rows?: PerCustomer[] } | undefined) =>
    asOf ? (d?.rows ?? []).map((r) => [r.customer_name, Number(r[asOf] ?? 0)] as [string, number]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([n, v]) => [n, usd(v)]) : [];
  const m = asOf ? mlabel(asOf) : '';
  const sheets: Record<string, { title: string; text: string; body: JSX.Element }> = ready ? {
    customers: { title: `Active paying customers · ${m}`, text: `${members.length} customers billed for a subscription in ${m} (invoiced basis). Annual payers count at their amortized monthly amount; duplicate records count once.`, body: <DataTable cols={[['Customer', false], ['Billing', false], ['MRR', true]]} rows={memberRows} label="Active paying customers" /> },
    subscription: { title: `Subscription MRR · ${m}`, text: `${usd(base!.mrr)} a month from the same ${members.length} customers: what was invoiced in ${m}, plus ${usd(annualAmort)} of annual payments spread across their twelve months.`, body: <DataTable cols={[['Customer', false], ['Billing', false], ['MRR', true]]} rows={memberRows} label="Subscription MRR by customer" /> },
    services: { title: `Services revenue · ${m}`, text: `Implementation and support work billed in ${m}. Project revenue, not recurring, so it is kept out of MRR.`, body: <DataTable cols={[['Customer', false], ['Billed', true]]} rows={perCustomer(servicesData as never)} label="Services revenue by customer" /> },
    connect: { title: `Connect revenue · ${m}`, text: `Platform fees Allmoxy earned on payments customers processed through Stripe Connect in ${m}.`, body: <DataTable cols={[['Customer', false], ['Fees', true]]} rows={perCustomer(connectByCustData as never)} label="Connect revenue by customer" /> },
    total: { title: `Total monthly revenue · ${m}`, text: 'Subscription MRR plus Services plus Connect. Services is not recurring, so this total is revenue, not MRR.', body: <DataTable cols={[['Stream', false], ['Amount', true], ['Share', true]]} rows={([['Subscription MRR', base!.mrr], ['Services revenue', svcAt(asOf!)], ['Connect revenue', conAt(asOf!)]] as Array<[string, number]>).map(([n, v]) => [n, usd(v), `${((v / total) * 100).toFixed(1)}%`]).concat([['Total', usd(total), '100%']])} label="Total monthly revenue by stream" /> },
  } : {};

  const revSeries = [
    { key: 'Subscription', label: 'Subscription', values: revRange.months.map(subAt), tone: 'cat-1' },
    { key: 'Connect', label: 'Connect', values: revRange.months.map(conAt), tone: 'cat-2' },
    { key: 'Services', label: 'Services', values: revRange.months.map(svcAt), tone: 'cat-3' },
  ].filter((s) => streams[s.key as keyof typeof streams]);

  return (
    <DsPage
      path="/overview"
      title="Overview"
      subtitle={<>
        {asOf ? `${mlabel(asOf)}, the latest complete month` : 'Loading…'}
        {dataThrough ? ` · Stripe data through ${new Date(`${dataThrough}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}` : ''}
      </>}
      overlays={Object.entries(sheets).map(([id, s]) => (
        <SideSheet key={id} open={openSheet === id} onClose={() => setOpenSheet(null)} title={s.title} text={s.text}>{s.body}</SideSheet>
      ))}
    >
      {error ? <p className="am-card__text">Could not load the monthly data: {String(error)}</p> : null}
      <div className="am-grid" style={{ ['--am-grid-min' as string]: '240px' }}>
        {ready && <>
          <KpiCard label="Active paying customers" value={base!.customers.toLocaleString()} hint={change(base!.customers, customersAt(prev!), false)} spark={spark12.map(customersAt)} onOpen={() => setOpenSheet('customers')} />
          <KpiCard label="Subscription MRR" value={usd(base!.mrr)} hint={change(base!.mrr, subAt(prev!))} tag={annualAmort > 0 ? `incl. ${usd(annualAmort)} annual` : undefined} spark={spark12.map(subAt)} onOpen={() => setOpenSheet('subscription')} />
          <KpiCard label="Services revenue" value={usd(svcAt(asOf!))} hint={change(svcAt(asOf!), svcAt(prev!))} tag="Not recurring" spark={spark12.map(svcAt)} onOpen={() => setOpenSheet('services')} />
          <KpiCard label="Connect revenue" value={usd(conAt(asOf!))} hint={change(conAt(asOf!), conAt(prev!))} spark={spark12.map(conAt)} onOpen={() => setOpenSheet('connect')} />
          <KpiCard label="Total monthly revenue" value={usd(total)} hint={change(total, totalAt(prev!))} spark={spark12.map(totalAt)} onOpen={() => setOpenSheet('total')} />
        </>}
      </div>

      <ChartCard title="Active paying customers" caption={`Customers billed for a subscription each month · ${custRange.rangeText}`}>
        {custRange.controls}
        <ColumnChart months={custRange.months} series={[{ key: 'c', label: 'Customers', values: custRange.months.map(customersAt), tone: 'cat-1' }]}
          fmt={(v) => Math.round(v).toLocaleString()} aria={`Active paying customers by month, ${custRange.rangeText}.`} />
      </ChartCard>

      <ChartCard title="Revenue by stream" caption={`Monthly revenue in USD; Services is project work, not recurring · ${revRange.rangeText}`}>
        {revRange.controls}
        <div className="am-row am-row--wrap" role="group" aria-label="Streams shown">
          {(Object.keys(streams) as Array<keyof typeof streams>).map((k) => (
            <FilterChip key={k} checked={streams[k]} onChange={() => setStreams((s) => ({ ...s, [k]: !s[k] }))}>{k}</FilterChip>
          ))}
        </div>
        <ColumnChart months={revRange.months} series={revSeries} fmt={usdk} stacked legend
          tipRows={(i) => [...revSeries].reverse().map((s) => [s.label, usd(s.values[i])] as [string, string]).concat([['Total', usd(revSeries.reduce((a, s) => a + s.values[i], 0))]])}
          aria={`Revenue by stream by month, ${revRange.rangeText}.`} />
      </ChartCard>
    </DsPage>
  );
}
