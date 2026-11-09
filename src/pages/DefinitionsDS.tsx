/**
 * Definitions on the Allmoxy design system. Same snapshot as the classic page (Definitions.tsx,
 * kept at /definitions-classic): metric_definitions via useSheetTab, with the same search (name,
 * id, definition, formula) and the same single-category filter. Nothing is computed here.
 *
 * Layout: a searchable reference. Each metric is a card showing its name, category, sign-off and
 * plain-English definition; "Formula and sources" opens the rest (formula, window, source files,
 * lineage, pages it appears on, adjustments). A search expands every match so a hit inside a
 * formula is visible without another click.
 */
import { useMemo, useState } from 'react';
import { useSheetTab } from '../hooks/useSheetTab';
import { DsPage, Link, SearchField, Select } from '../design-system/parts';

type Metric = {
  id: string; name: string; category: string; definition: string; formula: string;
  source_files: string[]; source_lineage: string; window: string;
  adjustments: string[] | string; displayed_on: string[];
  verified_by: string | null; verified_at: string | null;
};
type Category = { key: string; label: string; description: string };
type DefinitionsSnapshot = { comment: string; updated_at: string; fetched_at?: string; verified_by: string; categories: Category[]; metrics: Metric[] };

const LIMIT = 20;
const shortPath = (sf: string) => sf.replace('public/snapshots/', '').replace('_etl_scripts/', '').replace('src/data/', '');
// One metric stores its adjustments as a single sentence rather than a list; show it as one item.
const adjList = (a: Metric['adjustments']) => (Array.isArray(a) ? a : a ? [a] : []);

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="am-stack" style={{ gap: 4 }}>
      <span className="am-chart__caption">{label}</span>
      {children}
    </div>
  );
}

export default function DefinitionsDS() {
  const { data, isLoading, error } = useSheetTab('metric_definitions');
  const snap = data as unknown as DefinitionsSnapshot | undefined;

  const [query, setQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState(false);

  const filtered = useMemo(() => {
    if (!snap) return [];
    const q = query.trim().toLowerCase();
    let rows = snap.metrics;
    if (categoryFilter !== 'all') rows = rows.filter((m) => m.category === categoryFilter);
    if (q) {
      rows = rows.filter((m) =>
        m.name.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q) ||
        m.definition.toLowerCase().includes(q) ||
        m.formula.toLowerCase().includes(q));
    }
    return rows;
  }, [snap, query, categoryFilter]);

  const categoryCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const metric of snap?.metrics ?? []) m.set(metric.category, (m.get(metric.category) ?? 0) + 1);
    return m;
  }, [snap]);

  const subtitle = 'Canonical definitions for every metric on the dashboard. The first document a banker, buyer or QoE reviewer should read: every other artifact flows from these definitions.';
  if (error) return <DsPage path="/definitions" title="Definitions" subtitle={subtitle}><p className="am-card__text"><span className="am-tag am-tag--error">Failed to load</span> metric_definitions: {String(error)}</p></DsPage>;
  if (isLoading || !snap) return <DsPage path="/definitions" title="Definitions" subtitle={subtitle}><p className="am-card__text">Loading definitions…</p></DsPage>;

  const catLabel = (k: string) => snap.categories.find((c) => c.key === k)?.label ?? k;
  const searching = query.trim() !== '';
  const allOpen = filtered.length > 0 && filtered.every((m) => open.has(m.id));
  const shown = showAll || searching ? filtered : filtered.slice(0, LIMIT);
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const activeCat = snap.categories.find((c) => c.key === categoryFilter);

  return (
    <DsPage path="/definitions" title="Definitions" subtitle={subtitle}>
      <section className="am-card am-card--outlined">
        <div className="am-row am-row--wrap">
          <span className="am-tag am-tag--success">Signed off</span>
          <p className="am-card__text">
            <strong>{snap.metrics.length} metric definitions</strong> across <strong>{snap.categories.length}</strong> categories. Sign-off: {snap.verified_by}. Last updated: {snap.updated_at}.
          </p>
        </div>
      </section>

      <section className="am-card am-card--outlined">
        <div className="am-stack">
          <div className="am-row am-row--spread am-row--wrap">
            <div className="am-row am-row--wrap">
              <SearchField label="Search definitions, formulas" value={query} width={320} onChange={(v) => setQuery(v)} />
              <Select label="Category" width={240} value={categoryFilter} onPick={(v) => { setCategoryFilter(v); setShowAll(false); }}
                options={[['all', `All categories (${snap.metrics.length})`], ...snap.categories.map((c) => [c.key, `${c.label} (${categoryCounts.get(c.key) ?? 0})`] as [string, string])]} />
            </div>
            <div className="am-row">
              <span className="am-card__text">{filtered.length === snap.metrics.length ? `${filtered.length} definitions` : `${filtered.length} of ${snap.metrics.length} definitions`}</span>
              {!searching && filtered.length > 0 && (
                <button className="am-btn am-btn--text" onClick={() => setOpen(allOpen ? new Set() : new Set(filtered.map((m) => m.id)))}>
                  {allOpen ? 'Collapse all' : 'Expand all'}
                </button>
              )}
            </div>
          </div>
          {activeCat && (
            <div className="am-card am-card--filled">
              <div className="am-chart__head">
                <span className="am-chart__title">About {activeCat.label}</span>
                <span className="am-chart__caption">{activeCat.description}</span>
              </div>
            </div>
          )}
        </div>
      </section>

      {filtered.length === 0 && (
        <section className="am-card am-card--outlined"><p className="am-card__text">No definitions match your search.</p></section>
      )}

      {shown.map((m) => {
        const expanded = searching || open.has(m.id);
        const adj = adjList(m.adjustments);
        return (
          <section key={m.id} className="am-card am-card--outlined" aria-labelledby={`def-${m.id}`}>
            <div className="am-stack" style={{ gap: 12 }}>
              <div className="am-row am-row--spread am-row--wrap" style={{ alignItems: 'flex-start' }}>
                <div className="am-stack" style={{ gap: 6, flex: '1 1 480px', minWidth: 0 }}>
                  <div className="am-row am-row--wrap am-row--tight">
                    <h2 id={`def-${m.id}`} className="am-card__title" style={{ margin: 0 }}>{m.name}</h2>
                    <span className="am-tag am-tag--neutral">{catLabel(m.category)}</span>
                    <code className="am-chart__caption">{m.id}</code>
                  </div>
                  <p className="am-card__text" style={{ lineHeight: 1.6 }}>{m.definition}</p>
                </div>
                <div className="am-stack" style={{ gap: 4, flex: '0 1 260px', alignItems: 'flex-end', textAlign: 'right' }}>
                  {m.verified_by
                    ? <><span className="am-tag am-tag--success">Verified</span><span className="am-chart__caption">{m.verified_by}{m.verified_at ? ` · ${m.verified_at}` : ''}</span></>
                    : <span className="am-tag am-tag--warning">Not verified</span>}
                </div>
              </div>

              {!searching && (
                <div>
                  <button className="am-btn am-btn--text" aria-expanded={expanded} onClick={() => toggle(m.id)}>
                    {expanded ? 'Hide formula and sources' : 'Formula and sources'}
                  </button>
                </div>
              )}

              {expanded && (
                <div className="am-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
                  <Field label="Formula"><p className="am-card__text" style={{ lineHeight: 1.55 }}>{m.formula}</p></Field>
                  <Field label="Window"><p className="am-card__text">{m.window}</p></Field>
                  <Field label="Source files">
                    <div className="am-row am-row--wrap am-row--tight">
                      {m.source_files.map((sf) => <code key={sf} className="am-tag am-tag--neutral">{shortPath(sf)}</code>)}
                    </div>
                    <p className="am-card__text" style={{ lineHeight: 1.5 }}>{m.source_lineage}</p>
                  </Field>
                  <Field label="Displayed on">
                    <div className="am-row am-row--wrap am-row--tight">
                      {m.displayed_on.map((p) => (p.startsWith('/')
                        ? <Link key={p} to={p}>{p}</Link>
                        : <span key={p} className="am-card__text">{p}</span>))}
                    </div>
                  </Field>
                  <div style={{ gridColumn: '1 / -1' }}>
                    <Field label="Adjustments applied">
                      {adj.length === 0
                        ? <p className="am-card__text"><em>None. Straight from source.</em></p>
                        : <ul style={{ margin: 0, paddingLeft: 20 }}>{adj.map((a, i) => <li key={i} className="am-card__text" style={{ marginBottom: 4, lineHeight: 1.5 }}>{a}</li>)}</ul>}
                    </Field>
                  </div>
                </div>
              )}
            </div>
          </section>
        );
      })}

      {!searching && filtered.length > LIMIT && (
        <div>
          <button className="am-btn am-btn--text" onClick={() => setShowAll(!showAll)}>{showAll ? `Show the first ${LIMIT}` : `Show all ${filtered.length}`}</button>
        </div>
      )}

      <section className="am-card am-card--outlined">
        <div className="am-chart__head"><span className="am-chart__title">Adding or editing a definition</span></div>
        <p className="am-card__text" style={{ lineHeight: 1.6 }}>
          Definitions live in <code>_etl_scripts/metric_definitions.json</code>. Each metric needs: <strong>definition</strong> (plain English), <strong>formula</strong> (exact computation), <strong>source_files</strong>, <strong>source_lineage</strong> (where the raw data comes from), <strong>window</strong> (point-in-time, YTD, TTM or rolling), <strong>adjustments</strong> (every override applied), <strong>displayed_on</strong> (dashboard routes), and <strong>verified_by / verified_at</strong> (owner sign-off). Re-run <code>node _etl_scripts/refresh_all.mjs</code> to publish.
        </p>
      </section>
    </DsPage>
  );
}
