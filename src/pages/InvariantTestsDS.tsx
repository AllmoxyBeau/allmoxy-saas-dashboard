/**
 * Invariant Tests on the Allmoxy design system. Same snapshot as the classic page
 * (InvariantTests.tsx, kept at /invariant-tests-classic): invariant_test_results via useSheetTab,
 * the snapshot's own totals for the cards, and the same five filters (default: failed).
 *
 * Failures come first: the run's status, then the counts, then the checks with blocking errors
 * on top, warnings next and passes last. Every result is a word tag, never color alone.
 */
import { useMemo, useState } from 'react';
import { useSheetTab } from '../hooks/useSheetTab';
import { DataTable, DsPage, KpiCard, KpiGrid, Segmented } from '../design-system/parts';

type TestResult = { name: string; severity: 'error' | 'warn' | 'info'; passed: boolean; detail: string; examples: string[] };
type Snapshot = {
  fetched_at: string; total: number; passed: number; errors: number; warnings: number;
  status: 'green' | 'yellow' | 'red'; comment: string; results: TestResult[];
};
type Filter = 'all' | 'failed' | 'errors' | 'warnings' | 'passed';

const STATUS: Record<Snapshot['status'], { word: string; tone: 'success' | 'warning' | 'error'; label: string }> = {
  green: { word: 'All passing', tone: 'success', label: 'All invariants pass' },
  yellow: { word: 'Warnings', tone: 'warning', label: 'Soft warnings outstanding' },
  red: { word: 'Blocking', tone: 'error', label: 'Hard QoE-blocking failures' },
};
const LIMIT = 25;
// Errors first, then warnings, then passes; ties keep the run's order.
const rank = (r: TestResult) => (r.passed ? 2 : r.severity === 'error' ? 0 : 1);
const result = (r: TestResult) => (r.passed
  ? <span className="am-tag am-tag--success">Pass</span>
  : r.severity === 'error' ? <span className="am-tag am-tag--error">Error</span> : <span className="am-tag am-tag--warning">Warning</span>);
const severityWord = (s: TestResult['severity']) => (s === 'error' ? 'Blocking' : s === 'warn' ? 'Punch list' : 'Info');

export default function InvariantTestsDS() {
  const { data, isLoading, error } = useSheetTab('invariant_test_results');
  const snap = data as unknown as Snapshot | undefined;
  const [filter, setFilter] = useState<Filter>('failed');
  const [showAll, setShowAll] = useState(false);

  const filtered = useMemo(() => {
    const rows = snap?.results ?? [];
    let out = rows;
    if (filter === 'failed') out = rows.filter((r) => !r.passed);
    else if (filter === 'errors') out = rows.filter((r) => !r.passed && r.severity === 'error');
    else if (filter === 'warnings') out = rows.filter((r) => !r.passed && r.severity === 'warn');
    else if (filter === 'passed') out = rows.filter((r) => r.passed);
    return out.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i).map((x) => x.r);
  }, [snap, filter]);

  const subtitle = 'Automated self-consistency checks across all snapshots, run as the final step of refresh_all. Errors block QoE handoff; warnings are punch-list items worth resolving before banker review.';
  if (error) return <DsPage path="/invariant-tests" title="Invariant Tests" subtitle={subtitle}><p className="am-card__text"><span className="am-tag am-tag--error">Failed to load</span> invariant_test_results: {String(error)}</p></DsPage>;
  if (isLoading || !snap) return <DsPage path="/invariant-tests" title="Invariant Tests" subtitle={subtitle}><p className="am-card__text">Loading the latest run…</p></DsPage>;

  const st = STATUS[snap.status];
  const failed = snap.errors + snap.warnings;
  const pick = (f: Filter) => { setFilter(f); setShowAll(false); };

  return (
    <DsPage path="/invariant-tests" title="Invariant Tests" subtitle={subtitle}>
      <section className="am-card am-card--outlined">
        <div className="am-row am-row--wrap">
          <span className={`am-tag am-tag--${st.tone}`}>{st.word}</span>
          <p className="am-card__text">
            <strong>{st.label}</strong> · {snap.passed}/{snap.total} passed · {snap.errors} error(s) · {snap.warnings} warning(s). Last run: {new Date(snap.fetched_at).toLocaleString()}.
          </p>
        </div>
      </section>

      <KpiGrid max={4}>
        <KpiCard label="Errors (blocking)" value={String(snap.errors)} hint="Must be resolved before any banker handoff"
          tag={snap.errors > 0 ? 'Blocking' : 'None'} tagTone={snap.errors > 0 ? 'error' : 'success'}
          onOpen={snap.errors > 0 ? () => pick('errors') : undefined} />
        <KpiCard label="Warnings (punch list)" value={String(snap.warnings)} hint="Resolve or explain before diligence"
          tag={snap.warnings > 0 ? 'Open' : 'None'} tagTone={snap.warnings > 0 ? 'warning' : 'success'}
          onOpen={snap.warnings > 0 ? () => pick('warnings') : undefined} />
        <KpiCard label="Passed" value={String(snap.passed)} hint={`of ${snap.total} checks`}
          tag={snap.passed === snap.total ? 'All passing' : `${snap.total - snap.passed} not passing`} tagTone={snap.passed === snap.total ? 'success' : 'neutral'}
          onOpen={() => pick('passed')} />
        <KpiCard label="Tests run" value={String(snap.total)} hint="Every check in the latest refresh"
          tag="Latest run" tagTone="neutral" onOpen={() => pick('all')} />
      </KpiGrid>

      <section className="am-card am-card--outlined">
        <div className="am-stack">
          <div className="am-row am-row--spread am-row--wrap">
            <div className="am-chart__head">
              <span className="am-chart__title">Checks</span>
              <span className="am-chart__caption">Errors first, then warnings, then passes. Up to 10 examples are listed under each failure.</span>
            </div>
            <Segmented label="Show" value={filter} onChange={pick} options={[
              ['all', `All (${snap.results.length})`], ['failed', `Failed (${failed})`], ['errors', `Errors (${snap.errors})`],
              ['warnings', `Warnings (${snap.warnings})`], ['passed', `Passed (${snap.passed})`],
            ]} />
          </div>
          {filtered.length === 0 ? (
            <p className="am-card__text">{filter === 'failed' ? 'No failed tests. Green run.' : 'No tests match the current filter.'}</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <DataTable label="Invariant checks"
                cols={[['Result', false], ['Check', false], ['Severity', false], ['Detail', false]]}
                sortValues={filtered.map((r) => [rank(r), r.name, r.severity === 'error' ? 0 : 1, r.detail])}
                limit={showAll ? undefined : LIMIT}
                rows={filtered.map((r) => [
                  result(r),
                  <span key="n" style={{ display: 'block', minWidth: 200, maxWidth: 320 }}>{r.name}</span>,
                  severityWord(r.severity),
                  <div key="d" className="am-stack" style={{ gap: 4, minWidth: 280 }}>
                    <span>{r.detail}</span>
                    {!r.passed && r.examples.length > 0 && (
                      <ul style={{ margin: 0, paddingLeft: 18 }}>
                        {r.examples.slice(0, 10).map((ex, i) => <li key={i} className="am-card__text"><code>{ex}</code></li>)}
                      </ul>
                    )}
                  </div>,
                ])} />
            </div>
          )}
          {filtered.length > LIMIT && (
            <div><button className="am-btn am-btn--text" onClick={() => setShowAll(!showAll)}>{showAll ? `Show the first ${LIMIT}` : `Show all ${filtered.length}`}</button></div>
          )}
          <p className="am-card__text">
            <strong>Error</strong>: hard inconsistencies that must be resolved before any banker handoff; the refresh script exits non-zero so CI and hooks can detect them.{' '}
            <strong>Warning</strong>: punch-list items, known or expected drift (transaction reclassifications, placeholder EBITDA add-backs, missing contract links). These don't block, but should be resolved or explicitly explained before diligence.
          </p>
        </div>
      </section>

      <section className="am-card am-card--outlined">
        <div className="am-chart__head"><span className="am-chart__title">Adding new invariants</span></div>
        <p className="am-card__text" style={{ lineHeight: 1.6 }}>
          Tests live in <code>_etl_scripts/run_invariant_tests.mjs</code>. Each test is a single function returning <code>{'{ passed, detail, examples }'}</code>. Add a new <code>test('name', 'error|warn', fn)</code> call and re-run. Tests run automatically as the final step of <code>refresh_all.mjs</code>; the script exits non-zero if any error-severity test fails so CI hooks can catch it.
        </p>
      </section>
    </DsPage>
  );
}
