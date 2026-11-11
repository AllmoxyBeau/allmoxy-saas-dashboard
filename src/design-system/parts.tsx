/**
 * React renderings of certified Allmoxy design-system parts, shared by every converted page.
 * Markup and class names follow the showroom exactly; React supplies the behavior the
 * showroom's behaviors.js would (menus, sheets, pressed states, theme), so the two never
 * compete for the DOM. A page assembles these; it does not style them.
 */
import './styles';
import { Children, Fragment, createContext, isValidElement, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useViewMode } from '../config/features';

// ---------------------------------------------------------------- formatting
const USD0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
export const usd = (v: number) => USD0.format(v);
export const usdk = (v: number) => {
  const a = Math.abs(v), sign = v < 0 ? '−' : '';
  if (a < 0.5) return '$0';
  if (a < 1000) return `${sign}$${Math.round(a)}`;
  if (a < 1e6) return `${sign}$${Math.round(a / 1000).toLocaleString()}k`;
  if (a < 1e9) return `${sign}$${(a / 1e6).toFixed(2)}M`;
  return `${sign}$${(a / 1e9).toFixed(2)}B`;
};
export const pct = (v: number | null | undefined, d = 1) => (v == null ? '—' : `${(v * 100).toFixed(d)}%`);
const ML = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric' });
const MS = new Intl.DateTimeFormat('en-US', { month: 'short' });
const MSY = new Intl.DateTimeFormat('en-US', { month: 'short', year: '2-digit' });
export const toDate = (m: string) => { const [y, mo] = m.split('-').map(Number); return new Date(y, mo - 1, 1); };
export const mlabel = (m: string) => ML.format(toDate(m));
export const mshort = (m: string) => MS.format(toDate(m));
export const addMonths = (m: string, d: number) => { const t = toDate(m); t.setMonth(t.getMonth() + d); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}`; };
export const thisMonth = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };

// ---------------------------------------------------------------- small parts
export function Icon({ name, className = '' }: { name: string; className?: string }) {
  return <span className={`am-icon ${className}`.trim()} data-icon={name} aria-hidden="true" />;
}

/** Closes when the pointer goes down outside `ref`, or on Escape. */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open, close]);
  return ref;
}

/** Segmented buttons: two to five peer views or modes, all visible. */
export function Segmented<T extends string>({ options, value, onChange, label }: { options: Array<[T, string]>; value: T | null; onChange: (v: T) => void; label: string }) {
  return (
    <div className="am-segmented" role="group" aria-label={label}>
      {options.map(([k, l]) => (
        <button key={k} className="am-segmented__seg" aria-pressed={value === k} onClick={() => onChange(k)}>
          <Icon name="check" className="am-seg-check" />{l}
        </button>
      ))}
    </div>
  );
}

/** Select: one value from a known set, opening the certified menu. */
export function Select({ value, options, onPick, label, width = 150 }: { value: string; options: Array<[string, string]>; onPick: (v: string) => void; label: string; width?: number }) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const current = options.find(([k]) => k === value)?.[1] ?? '';
  return (
    <div ref={ref} className={`am-menu-anchor am-select${open ? ' is-open' : ''}`} style={{ width }}>
      <label className="am-field am-field--outlined" onClick={() => setOpen(!open)}>
        <input className="am-field__input" placeholder=" " value={current} readOnly aria-label={label} />
        <Icon name="arrow_drop_down" className="am-field__trail" />
        <span className="am-field__box" aria-hidden="true"><i /><i className="am-field__gap" /><i /></span>
      </label>
      <div className="am-menu" role="menu" style={{ maxHeight: 320, overflowY: 'auto' }}>
        {options.map(([k, l]) => (
          <button key={k} className="am-menu__item" role="menuitem" aria-selected={k === value} onClick={() => { onPick(k); setOpen(false); }}>
            <span className="am-menu__label">{l}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Link: the certified inline text link (navigation inside text or a table cell). In-app paths
 *  route without a reload; external URLs open in a new tab. Ctrl/Cmd-click keeps browser habits. */
export function Link({ to, href, children, quiet }: { to?: string; href?: string; children: ReactNode; quiet?: boolean }) {
  const navigate = useNavigate();
  const cls = `am-link${quiet ? ' am-link--quiet' : ''}`;
  if (href) return <a className={cls} href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
  return (
    <a className={cls} href={to} onClick={(e) => { if (!to || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); navigate(to); }}>{children}</a>
  );
}

/** A customer's name linking to their detail page (by id when known, else by name). */
export function CustomerLink({ id, name }: { id?: number | null; name: string }) {
  const to = id != null ? `/customer-detail?id=${encodeURIComponent(String(id))}` : `/customer-detail?name=${encodeURIComponent(name)}`;
  return <Link to={to}>{name}</Link>;
}

/** Multi-select: several values from a known set; the certified field + menu, with a check on
 *  each chosen item, staying open while picking. Empty selection means "all". */
export function MultiSelect({ label, allText = 'All', options, value, onChange, width = 240 }: {
  label: string; allText?: string; options: Array<[string, string]>; value: string[]; onChange: (v: string[]) => void; width?: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  if (!options.length) return null;
  const shown = value.length === 0 ? allText : value.length === 1 ? (options.find(([k]) => k === value[0])?.[1] ?? value[0]) : `${value.length} selected`;
  return (
    <div ref={ref} className={`am-menu-anchor am-select${open ? ' is-open' : ''}`} style={{ width }}>
      <label className="am-field am-field--outlined" style={{ width: '100%', minWidth: 0 }} onClick={() => setOpen(!open)}>
        <input className="am-field__input" placeholder=" " value={shown} readOnly aria-label={label} />
        <span className="am-field__label">{label}</span>
        <Icon name="arrow_drop_down" className="am-field__trail" />
        <span className="am-field__box" aria-hidden="true"><i /><i className="am-field__gap" /><i /></span>
      </label>
      <div className="am-menu" role="menu" style={{ maxHeight: 320, overflowY: 'auto' }}>
        {value.length > 0 && (
          <button className="am-menu__item" role="menuitem" onClick={() => onChange([])}><span className="am-menu__label">{allText}</span></button>
        )}
        {options.map(([k, l]) => {
          const on = value.includes(k);
          return (
            <button key={k} className="am-menu__item" role="menuitemcheckbox" aria-checked={on} aria-selected={on}
              onClick={() => onChange(on ? value.filter((x) => x !== k) : [...value, k])}>
              <span style={on ? undefined : { visibility: 'hidden' }}><Icon name="check" /></span>
              <span className="am-menu__label">{l}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Search field: the certified outlined field with a leading search icon. */
export function SearchField({ value, onChange, label = 'Search', width = 280 }: { value: string; onChange: (v: string) => void; label?: string; width?: number }) {
  return (
    <label className="am-field am-field--outlined" style={{ width }}>
      <Icon name="search" className="am-field__lead" />
      <input className="am-field__input" placeholder=" " value={value} aria-label={label} onChange={(e) => onChange(e.target.value)} />
      <span className="am-field__label">{label}</span>
      <span className="am-field__box" aria-hidden="true"><i /><i className="am-field__gap">{label}</i><i /></span>
    </label>
  );
}

/** Switch: a single setting that takes effect immediately. */
export function Switch({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label className="am-switch">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="am-switch__track"><span className="am-switch__handle"><Icon name="check" /></span></span>
      {children}
    </label>
  );
}

/** Filter chip: an interactive token holding its own checked state. */
export function FilterChip({ checked, onChange, children }: { checked: boolean; onChange: () => void; children: ReactNode }) {
  return (
    <label className="am-chip am-chip--filter">
      <input type="checkbox" checked={checked} onChange={onChange} />
      {checked && <Icon name="check" className="am-chip__check" />}
      <span className="am-chip__label">{children}</span>
    </label>
  );
}

export function Sparkline({ values, tone = 'cat-1' }: { values: number[]; tone?: string }) {
  if (values.length < 2) return null;
  const lo = Math.min(...values), hi = Math.max(...values), rng = hi - lo || 1;
  const pts = values.map((v, i) => [2 + (i * 96) / (values.length - 1), 22 - ((v - lo) / rng) * 16]);
  const p = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const [lx, ly] = pts[pts.length - 1];
  const trend = values[values.length - 1] > values[0] ? 'rising' : values[values.length - 1] < values[0] ? 'easing down' : 'flat';
  return (
    <svg className="am-sparkline" viewBox="0 0 100 26" preserveAspectRatio="none" role="img" aria-label={`Trend, ${trend}.`} style={{ width: '100%', height: 40 }}>
      <polygon className={`am-line__area am-series--${tone}`} points={`${p} 98,24 2,24`} />
      <polyline className={`am-line am-series--${tone}`} points={p} vectorEffect="non-scaling-stroke" />
      <circle className={`am-line__marker am-series--${tone}`} cx={lx} cy={ly} r={2.4} />
    </svg>
  );
}

/** KPI tile. Interactive (opens its detail) when `onOpen` is given.
 *
 *  ALIGNMENT RULE (Beau, 2026-11-09, applies app-wide): every slot lines up across a row of
 *  tiles. Label, value and hint stack from the top; the status tag and the trend are pinned
 *  to the card's foot, tag above trend. Tiles in a grid row are equal height, so tags share
 *  one line and trends share one baseline whatever the hint's length or whether a neighbour
 *  carries a tag. Pages never place a tag or trend inside the hint; they pass it here. */
/** Which footer slots any card in this row uses. A card without one reserves the space, so a
 *  tag-only card's tag sits on the same line as a neighbour's tag-above-trend. */
const KpiRowSlots = createContext<{ tag: boolean; spark: boolean } | null>(null);

/** A row of KPI cards. Use it instead of a bare am-grid: it fills the row (one column per card
 *  up to `max`, never an empty column) and lines every card's footer slots up. */
export function KpiGrid({ children, max = 6, min = 200 }: { children: ReactNode; max?: number; min?: number }) {
  // Count real cards: fragments (e.g. `{ready && <>…</>}`) are opened up, so the row gets one
  // column per card rather than one per fragment.
  const flatten = (nodes: ReactNode): React.ReactElement[] =>
    Children.toArray(nodes).flatMap((n) => (isValidElement(n) && n.type === Fragment ? flatten((n.props as { children?: ReactNode }).children) : isValidElement(n) ? [n] : []));
  const kids = flatten(children) as Array<React.ReactElement<{ tag?: string; spark?: number[] }>>;
  const slots = useMemo(() => ({ tag: kids.some((k) => !!k.props.tag), spark: kids.some((k) => !!k.props.spark) }), [kids]);
  const cols = Math.max(1, Math.min(max, kids.length));
  return (
    <KpiRowSlots.Provider value={slots}>
      <div className="am-grid" style={{ ['--am-grid-min' as string]: `max(${min}px, calc((100% - ${cols - 1} * var(--am-space-block)) / ${cols}))` }}>{children}</div>
    </KpiRowSlots.Provider>
  );
}

export function KpiCard({ label, value, hint, tag, tagTone, spark, sparkTone, onOpen }: { label: string; value: string; hint?: string; tag?: string; tagTone?: 'success' | 'warning' | 'error' | 'info' | 'neutral'; spark?: number[]; sparkTone?: string; onOpen?: () => void }) {
  const interactive = !!onOpen;
  const row = useContext(KpiRowSlots);
  const wantTag = !!tag || !!row?.tag, wantSpark = !!spark || !!row?.spark;
  return (
    <div className={`am-card am-card--outlined${interactive ? ' am-card--interactive' : ''}`}
      {...(interactive ? { role: 'button', tabIndex: 0, 'aria-label': `${label}: open the detail`, onClick: onOpen, onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen!(); } } } : {})}
      style={{ display: 'flex', flexDirection: 'column' }}>
      <span className="am-card__text">{label}</span>
      <p className="am-summary__value">{value}</p>
      {hint && <p className="am-card__text">{hint}</p>}
      {(wantTag || wantSpark) && (
        <div style={{ marginTop: 'auto', paddingTop: 8 }}>
          {wantTag && <div className="am-row" style={tag ? undefined : { visibility: 'hidden' }} aria-hidden={!tag}><span className={`am-tag${tagTone ? ` am-tag--${tagTone}` : ''}`}>{tag || 'placeholder'}</span></div>}
          {spark ? <Sparkline values={spark} tone={sparkTone} /> : wantSpark ? <div style={{ height: 40 }} aria-hidden="true" /> : null}
        </div>
      )}
    </div>
  );
}

/** Data table. `foot` adds the certified totals row (tfoot, title-small weight, out of the body);
 *  with `onFoot`, a total is selectable and opens everything it sums (Beau, 2026-11-09: every
 *  table with movement columns ends in a Total row that opens all of its data). */
/*  Sorting: pass `sortValues` (one raw number/string per cell, same shape as `rows`) and every
 *  header becomes a sort control (the design system's rule: every column sorts). `onCell` always
 *  receives the ORIGINAL row index, so callers never see the sorted order. `clickable(col, row)`
 *  may decide per row. */
export function DataTable({ cols, rows, label, onCell, clickable, foot, onFoot, footClickable, sortValues, defaultSort, limit, onSortChange, sortedBy, onHeaderSort, expandedRow }: {
  cols: Array<[string, boolean]>; rows: Array<Array<ReactNode>>; label: string;
  onCell?: (row: number, col: number) => void; clickable?: (col: number, row: number) => boolean;
  foot?: Array<ReactNode>; onFoot?: (col: number) => void; footClickable?: (col: number) => boolean;
  sortValues?: Array<Array<number | string | null | undefined>>; defaultSort?: { col: number; dir: 'asc' | 'desc' };
  /** Show only the first N rows AFTER sorting the full list (pass every row, not a slice). */
  limit?: number;
  /** Told the sorted order (original indices) whenever it changes, so a CSV can follow it. */
  onSortChange?: (order: number[], sort: { col: number; dir: 'asc' | 'desc' } | null) => void;
  /** Controlled sorting: the page sorts `rows` itself; headers call onHeaderSort(col) and show sortedBy's arrow. */
  sortedBy?: { col: number; dir: 'asc' | 'desc' } | null;
  onHeaderSort?: (col: number) => void;
  /** Content shown in a full-width row directly under row i (original index), or null. */
  expandedRow?: (row: number) => ReactNode | null;
}) {
  const [sort, setSort] = useState<{ col: number; dir: 'asc' | 'desc' } | null>(defaultSort ?? null);
  const order = useMemo(() => {
    const idx = rows.map((_, i) => i);
    if (!sort || !sortValues) return idx;
    const val = (i: number) => sortValues[i]?.[sort.col];
    return idx.sort((a, b) => {
      const x = val(a), y = val(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
      return sort.dir === 'asc' ? c : -c;
    });
  }, [rows, sortValues, sort]);
  // Only report a genuinely new order: a page that rebuilds `rows` every render would otherwise
  // get a fresh callback each render and loop if it stores the order in state.
  const lastOrder = useRef('');
  useEffect(() => {
    const key = `${sort?.col ?? ''}:${sort?.dir ?? ''}:${order.join(',')}`;
    if (key === lastOrder.current) return;
    lastOrder.current = key;
    onSortChange?.(order, sort);
  }, [order, sort]); // eslint-disable-line react-hooks/exhaustive-deps
  const shownOrder = limit != null ? order.slice(0, limit) : order;
  const controlled = !!onHeaderSort;
  const shownSort = controlled ? (sortedBy ?? null) : sort;
  const clickSort = (j: number) => controlled ? onHeaderSort!(j) : setSort((s) => (s && s.col === j ? { col: j, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { col: j, dir: cols[j][1] ? 'desc' : 'asc' }));
  return (
    <table className="am-table" aria-label={label}>
      <thead><tr>{cols.map(([c, n], j) => (
        <th key={c} className={n ? 'am-table__num' : undefined} style={{ whiteSpace: 'nowrap' }}
          aria-sort={shownSort?.col === j ? (shownSort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
          {sortValues || controlled ? (
            <span className="am-table__sort" role="button" tabIndex={0} onClick={() => clickSort(j)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); clickSort(j); } }}>
              {c}<span className="am-table__sortarrow" aria-hidden="true">{shownSort?.col === j && shownSort.dir === 'asc' ? '▲' : '▼'}</span>
            </span>
          ) : c}
        </th>
      ))}</tr></thead>
      <tbody>{shownOrder.map((i) => { const r = rows[i]; const ex = expandedRow?.(i); return (
        <Fragment key={i}>
          <tr>{r.map((v, j) => (
            <td key={j} className={cols[j][1] ? 'am-table__num' : undefined} style={cols[j][1] ? { whiteSpace: 'nowrap' } : undefined}>
              {onCell && (clickable ? clickable(j, i) : j > 0) && v !== '—' ? <button className="am-btn am-btn--text" onClick={() => onCell(i, j)}>{v}</button> : v}
            </td>
          ))}</tr>
          {ex != null && <tr><td colSpan={cols.length} style={{ whiteSpace: 'normal' }}><div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--am-space-3, 12px)', padding: 'var(--am-space-2, 8px) 0' }}>{ex}</div></td></tr>}
        </Fragment>
      ); })}</tbody>
      {foot && (
        <tfoot><tr>{foot.map((v, j) => (
          <td key={j} className={cols[j]?.[1] ? 'am-table__num' : undefined} style={{ whiteSpace: 'nowrap' }}>
            {onFoot && (footClickable ? footClickable(j) : j > 0) && v !== '—' && v !== '' ? <button className="am-btn am-btn--text" onClick={() => onFoot(j)}>{v}</button> : v}
          </td>
        ))}</tr></tfoot>
      )}
    </table>
  );
}

export function SideSheet({ open, onClose, title, text, children }: { open: boolean; onClose: () => void; title: string; text?: ReactNode; children?: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  return (
    <div className={`am-sheet-host${open ? ' is-open' : ''}`}>
      <div className="am-scrim" onClick={onClose} />
      <div className="am-sidesheet am-sidesheet--wide" role="dialog" aria-modal="true" aria-label={title}>
        <div className="am-sidesheet__head">
          <h2 className="am-sidesheet__title">{title}</h2>
          <button className="am-sidesheet__close" aria-label="Close" onClick={onClose}><Icon name="close" /></button>
        </div>
        {/* Content stacks with the system's block spacing, so sections never crowd. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--am-space-block)', overflowX: 'auto', minWidth: 0 }}>
          {text && <p className="am-sidesheet__text">{text}</p>}
          {children}
        </div>
      </div>
    </div>
  );
}

/** A titled chart card: card + chart head (title, caption), then controls and the chart. */
export function ChartCard({ title, caption, children }: { title: string; caption?: string; children: ReactNode }) {
  return (
    <section className="am-card am-card--outlined">
      <figure className="am-chart" aria-label={title}>
        <div className="am-chart__head">
          <span className="am-chart__title">{title}</span>
          {caption && <span className="am-chart__caption">{caption}</span>}
        </div>
        {children}
      </figure>
    </section>
  );
}

// ---------------------------------------------------------------- column chart
export type ColumnSeries = { key: string; label: string; values: number[]; tone: string };

/** Certified column chart. Plain (one series), stacked, or diverging-stacked when values are
 *  signed (gains stack up from zero, losses stack down). Columns anchor at zero. A label sits
 *  above each column while there is room (24 months or fewer); hover or focus reveals the
 *  month's exact figures in the certified rich tooltip (chart hover ruled 2026-08-15). */
/*  `months` are category keys. They render as months unless `catLabel` (axis text) and
 *  `catTitle` (tooltip / screen-reader title) are given, e.g. years or segments. */
export function ColumnChart({ months, series, fmt, aria, stacked, grouped, labelFor, tipRows, onSegment, legend, catLabel, catTitle }: {
  months: string[]; series: ColumnSeries[]; fmt: (v: number) => string; aria: string; stacked?: boolean; grouped?: boolean;
  catLabel?: (key: string, i: number) => string; catTitle?: (key: string) => string;
  labelFor?: (i: number) => string | null; tipRows?: (i: number) => Array<[string, string]>;
  onSegment?: (i: number, key: string) => void; legend?: boolean;
}) {
  const [tip, setTip] = useState<{ i: number; left: number; top: number } | null>(null);
  if (!months.length || !series.length) return <p className="am-card__text">No data for this range.</p>;
  const W = 1200, H = 290, L = 70, R = 16, T = 26;
  const pos = months.map((_, i) => grouped ? Math.max(0, ...series.map((x) => x.values[i])) : series.reduce((s, x) => s + Math.max(0, stacked ? x.values[i] : 0), 0) || (stacked ? 0 : Math.max(0, series[0].values[i])));
  const neg = months.map((_, i) => grouped ? Math.min(0, ...series.map((x) => x.values[i])) : series.reduce((s, x) => s + Math.min(0, stacked ? x.values[i] : 0), 0) || (stacked ? 0 : Math.min(0, series[0].values[i])));
  const maxV = Math.max(0, ...pos), minV = Math.min(0, ...neg);
  const rough = (maxV - minV || 1) / 4;
  const p10 = Math.pow(10, Math.floor(Math.log10(rough)));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * p10).find((v) => v >= rough) ?? 10 * p10;
  const top = Math.ceil((maxV * 1.08) / step) * step || (minV < 0 ? 0 : step);
  const bottom = Math.floor((minV * 1.08) / step) * step;
  const ticks: number[] = [];
  for (let v = bottom; v <= top + 1e-9; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  const B = H - 40;
  const Y = (v: number) => B - ((v - bottom) / (top - bottom || 1)) * (B - T);
  const slot = (W - L - R) / months.length;
  const bw = Math.min(56, slot * 0.62);
  const cx = (i: number) => L + slot * i + slot / 2;
  const showLabels = months.length <= 24;
  const catStep = Math.max(1, Math.ceil(months.length / 12));
  const longRange = months.length > 14;
  const title = (m: string) => (catTitle ? catTitle(m) : mlabel(m));
  const label = (i: number) => (labelFor ? labelFor(i) : grouped ? null : fmt(stacked ? pos[i] + neg[i] : series[0].values[i]));
  const rowsFor = (i: number): Array<[string, string]> =>
    tipRows ? tipRows(i) : series.map((s) => [s.label, fmt(s.values[i])] as [string, string]);
  const show = (i: number, el: SVGRectElement) => {
    const r = el.getBoundingClientRect();
    // Keep the tip on screen: a column near either edge (or inside a side sheet) would
    // otherwise push half the tip past the viewport.
    const half = 170;
    setTip({ i, left: Math.min(Math.max(r.left + r.width / 2, half), window.innerWidth - half), top: r.top + ((Y(pos[i]) - T) / (B - T)) * r.height - 28 });
  };
  return (
    <>
      <div className="am-tooltip" style={{ display: 'block', width: '100%' }} onMouseLeave={() => setTip(null)}>
        <svg className="am-column-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={aria} style={{ width: '100%' }}>
          {ticks.map((v) => (
            <g key={v}>
              <line className={v === 0 ? 'am-chart__axis-line' : 'am-chart__gridline'} x1={L} y1={Y(v)} x2={W - R} y2={Y(v)} />
              <text className="am-chart__tick" x={L - 6} y={Y(v) + 3} textAnchor="end">{fmt(v)}</text>
            </g>
          ))}
          {months.map((m, i) => {
            let up = 0, down = 0;
            // Grouped: the series sit side by side in the month's slot, each from zero.
            const segs = grouped ? series.map((s, k) => {
              const v = s.values[i], w = bw / series.length;
              const y0 = Y(Math.max(0, v)), h = Math.abs(Y(v) - Y(0));
              return h > 0 ? <rect key={s.key} className={`am-column am-series--${s.tone}`} x={cx(i) - bw / 2 + k * w + 1} y={y0} width={w - 2} height={h}
                style={onSegment ? { cursor: 'pointer' } : undefined} onClick={onSegment ? () => onSegment(i, s.key) : undefined} /> : null;
            }) : (stacked ? series : [series[0]]).map((s) => {
              const v = s.values[i];
              let y0, y1;
              if (v >= 0) { y0 = Y(up + v); y1 = Y(up); up += v; } else { y0 = Y(down); y1 = Y(down + v); down += v; }
              const h = Math.max(0, y1 - y0);
              return h > 0 ? (
                <rect key={s.key} className={`${stacked ? '' : 'am-column '}am-series--${s.tone}`.trim()} x={cx(i) - bw / 2} y={y0} width={bw} height={h}
                  style={onSegment ? { cursor: 'pointer' } : undefined} onClick={onSegment ? () => onSegment(i, s.key) : undefined} />
              ) : null;
            });
            const lab = showLabels ? label(i) : null;
            return (
              <g key={m}>
                {/* hover / focus zone first, so the segments above it stay clickable */}
                <rect x={L + slot * i} y={T} width={slot} height={B - T} fillOpacity={0} tabIndex={0}
                  aria-label={`${title(m)}: ${rowsFor(i).map(([a, b]) => `${a} ${b}`).join(', ')}`}
                  onMouseEnter={(e) => show(i, e.currentTarget)} onFocus={(e) => show(i, e.currentTarget)} onBlur={() => setTip(null)} />
                <g onMouseEnter={(e) => show(i, (e.currentTarget.previousSibling as SVGRectElement))}>{segs}</g>
                {lab && <text className="am-chart__value" x={cx(i)} y={Y(pos[i]) - 6} textAnchor="middle">{lab}</text>}
                {(i % catStep === 0 || i === months.length - 1) && (
                  <text className="am-chart__cat" x={cx(i)} y={B + 18} textAnchor="middle">{catLabel ? catLabel(m, i) : longRange ? MSY.format(toDate(m)) : mshort(m)}</text>
                )}
              </g>
            );
          })}
        </svg>
        {tip && (
          <span className="am-tooltip__tip am-tooltip__tip--rich" role="tooltip" style={{ left: tip.left, top: tip.top }}>
            <b>{title(months[tip.i])}</b>
            {rowsFor(tip.i).map(([a, b]) => <span key={a} style={{ display: 'block' }}>{a}: {b}</span>)}
          </span>
        )}
      </div>
      {legend && (
        <ul className="am-chart__legend am-chart__legend--below">
          {series.map((s) => (
            <li key={s.key} className="am-chart__legend-item"><span className={`am-chart__swatch am-series--${s.tone}`} /><span className="am-chart__legend-label">{s.label}</span></li>
          ))}
        </ul>
      )}
      <table className="am-chart__data-table">
        <caption>{aria}</caption>
        <thead><tr><th>{catTitle ? 'Category' : 'Month'}</th>{series.map((s) => <th key={s.key}>{s.label}</th>)}</tr></thead>
        <tbody>{months.map((m, i) => <tr key={m}><td>{title(m)}</td>{series.map((s) => <td key={s.key}>{fmt(s.values[i])}</td>)}</tr>)}</tbody>
      </table>
    </>
  );
}

// ---------------------------------------------------------------- month range (presets + From / To)
export type Preset = '12M' | '24M' | '60M' | 'ALL' | 'CUSTOM';
export function useMonthRange(allMonths: string[], opts?: { defaultPreset?: Exclude<Preset, 'CUSTOM'> }) {
  const [preset, setPreset] = useState<Preset>(opts?.defaultPreset ?? '12M');
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
    <div className="am-row am-row--wrap">
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

// ---------------------------------------------------------------- app frame + theme
type Theme = 'dark' | 'light';
const THEME_KEY = 'am-theme';
const readTheme = (): Theme => { try { return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'; } catch { return 'dark'; } };

// `also`: pages reached only by link (not listed in the menu) that still light up their section.
const SECTIONS: Array<{ name: string; icon: string; financial?: boolean; pages: Array<[string, string]>; also?: string[] }> = [
  // Customer Detail is opened from a customer's name (Customers table or any customer link), not the menu.
  { name: 'Customers', icon: 'group', also: ['/customer-detail'], pages: [['Customers', '/customers'], ['Customer Health', '/customer-health'], ['Time to Value', '/time-to-value'], ['Activation', '/activation'], ['Rep Dashboard', '/rep-dashboard'], ['Custom Report', '/custom-report']] },
  { name: 'Revenue', icon: 'attach_money', pages: [['Current Month', '/current-month'], ['Revenue Waterfall', '/revenue-waterfall'], ['Revenue Recognition', '/revenue-recognition'], ['AR Adjustments', '/ar-adjustments'], ['Collections', '/collections'], ['Services', '/services'], ['Stripe Connect', '/stripe-connect-revenue'], ['Payments Opportunity', '/payments-opportunity'], ['Sales Budget', '/sales-budget']] },
  { name: 'Retention', icon: 'timeline', pages: [['Logo Waterfall', '/logo-waterfall'], ['Cohort Retention', '/cohort-retention'], ['Net Revenue Retention', '/net-revenue-retention'], ['Churn Timeline', '/churn-timeline'], ['Churn Patterns', '/churn-patterns'], ['Churn Investigator', '/churn-investigator'], ['Churn Risk Matrix', '/churn-risk-matrix'], ['Renewal Management', '/renewal-management'], ['Contracts', '/contracts']] },
  { name: 'Operations', icon: 'construction', pages: [['Implementation', '/implementation'], ['Implementation Schedule', '/implementation-schedule'], ['Service Tickets', '/service-tickets'], ['Orders Verified', '/orders-verified'], ['Features', '/features'], ['Bug Report', '/bug-report'], ['Project Candidates', '/project-candidates'], ['Data Cleanup', '/data-cleanup']] },
  { name: 'Finance', icon: 'insert_chart', financial: true, pages: [['Unit Economics', '/unit-economics'], ['Efficiency', '/efficiency'], ['Segments', '/segments'], ['Profit & Loss', '/profit-loss'], ['EBITDA Bridge', '/ebitda-bridge'], ['Stripe and QB Reconciliation', '/stripe-qb-reconciliation']] },
  { name: 'M&A', icon: 'verified', financial: true, pages: [['Scorecard', '/scorecard'], ['CIM Packet', '/cim-packet'], ['Banker Handoff', '/banker-handoff'], ['Adjustments Register', '/adjustments-register'], ['Annual Amortization', '/annual-amortization-evidence'], ['Definitions', '/definitions'], ['Invariant Tests', '/invariant-tests']] },
];

function NavSection({ s, current }: { s: (typeof SECTIONS)[number]; current?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const navigate = useNavigate();
  const active = !!current && (s.pages.some(([, p]) => p === current) || !!s.also?.includes(current));
  return (
    <div ref={ref} className={`am-menu-anchor${open ? ' is-open' : ''}`}>
      <button className="am-appnav__btn" aria-label={s.name} aria-haspopup="true" aria-expanded={open} {...(active ? { 'aria-current': 'page' as const } : {})} onClick={() => setOpen(!open)}>
        <Icon name={s.icon} className="am-appnav__section-icon" /><span className="am-appnav__label">{s.name}</span> <Icon name="arrow_drop_down" className="am-appnav__caret" />
      </button>
      <div className="am-menu" role="menu">
        {s.pages.map(([label, path]) => (
          <button key={path} className="am-menu__item" role="menuitem" aria-selected={path === current} onClick={() => { setOpen(false); navigate(path); }}>
            <span className="am-menu__label">{label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** The converted-page frame: app navigation (this dashboard's sections, theme toggle), the
 *  Regular template's main column and page lane, and the page header. Dark by default. */
export function DsPage({ path, title, subtitle, actions, children, overlays }: {
  path: string; title: string; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; overlays?: ReactNode;
}) {
  const navigate = useNavigate();
  const { showFinancialTabs } = useViewMode();
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* private window */ }
  }, [theme]);
  // The frame sets the page's base text color from the theme; the unconverted MUI pages are
  // dark, so leaving a converted page hands them the dark tokens.
  useEffect(() => () => document.documentElement.setAttribute('data-theme', 'dark'), []);
  return (
    <div className="tpl-shell">
      <header className="am-appnav">
        <nav className="am-appnav__group am-appnav__sections" aria-label="Primary">
          <span className="am-tooltip">
            <a className="am-appnav__btn" href="/overview" {...(path === '/overview' ? { 'aria-current': 'page' as const } : {})} aria-label="Overview"
              onClick={(e) => { e.preventDefault(); navigate('/overview'); }}>
              <Icon name="dashboard" /><span className="am-appnav__label">Overview</span>
            </a>
            <span className="am-tooltip__tip">Overview</span>
          </span>
          {SECTIONS.filter((s) => !s.financial || showFinancialTabs).map((s) => <NavSection key={s.name} s={s} current={path} />)}
        </nav>
        <span className="am-appnav__spacer" />
        <div className="am-appnav__group">
          <span className="am-tooltip">
            <button className="am-appnav__btn am-appnav__btn--icon" aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
              <Icon name={theme === 'dark' ? 'light_mode' : 'dark_mode'} />
            </button>
            <span className="am-tooltip__tip">{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
          </span>
        </div>
      </header>
      <main className="tpl-main">
        <div className="tpl-page">
          <header className="am-page-header">
            <div className="am-page-header__titlewrap">
              <h1 className="am-page-header__title">{title}</h1>
              {subtitle && <p className="am-page-header__subtitle">{subtitle}</p>}
            </div>
            {actions && <div className="am-page-header__actions">{actions}</div>}
          </header>
          <div className="tpl-regular-body">{children}</div>
        </div>
      </main>
      {overlays}
    </div>
  );
}

/** CSV download from rows (no third-party). */
export function downloadCsv(filename: string, header: string[], rows: Array<Array<string | number>>) {
  const esc = (v: string | number) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csv = [header, ...rows].map((r) => r.map(esc).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `${filename}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}
