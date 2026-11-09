/**
 * Postgres Backend Plan on the Allmoxy design system. Same single source of truth as the
 * classic page (BackendPlan.tsx, kept at /backend-plan-classic): docs/postgres-backend-outline.md,
 * imported raw and rendered in-app. Only the presentation changes: each top-level section of the
 * doc becomes its own card, with a contents card first so a reader can jump straight to a section.
 *
 * DocReader below is a small markdown renderer built on design-system classes (the classic page
 * used the MUI Markdown component). It handles exactly what our committed docs use: headings,
 * rules, blockquotes, tables, bullet / numbered / task lists, paragraphs, and inline bold,
 * italic, `code` and [links](url). ApiMigrationPlanDS reuses it.
 */
import type { ReactNode } from 'react';
import { DsPage, Link } from '../design-system/parts';
import outlineMd from '../../docs/postgres-backend-outline.md?raw';

// ---------------------------------------------------------------- inline markdown
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\[([^\]]+)\]\(([^)]+)\))|(\*\*([^*]+)\*\*)|(`([^`]+)`)|(\*([^*\s][^*]*)\*)/g;
  let last = 0; let m: RegExpExecArray | null; let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) {
      const href = m[3];
      out.push(href.startsWith('/') ? <Link key={i++} to={href}>{m[2]}</Link> : <Link key={i++} href={href}>{m[2]}</Link>);
    } else if (m[4]) out.push(<strong key={i++}>{inline(m[5])}</strong>);
    else if (m[6]) out.push(<code key={i++}>{m[7]}</code>);
    else if (m[8]) out.push(<em key={i++}>{m[9]}</em>);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
const cells = (row: string) => row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
const plain = (s: string) => s.replace(/[*`]/g, '');
const LIST_RE = /^\s*([-*]|\d+\.)\s+/;

/** Block-level markdown → design-system markup. */
function Blocks({ source }: { source: string }) {
  const lines = source.split('\n');
  const blocks: ReactNode[] = [];
  let i = 0; let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const h = line.match(/^(#{3,4})\s+(.*)$/);
    if (h) {
      blocks.push(h[1].length === 3
        ? <h3 key={key++} className="am-card__title" style={{ marginTop: 16 }}>{inline(h[2])}</h3>
        : <h4 key={key++} className="am-card__title" style={{ marginTop: 12 }}>{inline(h[2])}</h4>);
      i++; continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) { i++; continue; } // sections are already cards
    if (line.startsWith('>')) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].startsWith('>')) { buf.push(lines[i].replace(/^>\s?/, '')); i++; }
      blocks.push(<div key={key++} className="am-card am-card--filled"><p className="am-card__text">{inline(buf.join(' '))}</p></div>);
      continue;
    }
    if (line.trim().startsWith('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const header = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) { rows.push(cells(lines[i])); i++; }
      blocks.push(
        <div key={key++} style={{ overflowX: 'auto' }}>
          <table className="am-table" aria-label={plain(header.join(' · '))}>
            <thead><tr>{header.map((c, j) => <th key={j}>{inline(c)}</th>)}</tr></thead>
            {/* Each cell's words sit in a span: a doc table is read, not scanned, so the design system's
                one-line cut for plain text cells must not hide any of its words. */}
            <tbody>{rows.map((r, ri) => <tr key={ri}>{r.map((c, j) => <td key={j}><span>{inline(c)}</span></td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (LIST_RE.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: ReactNode[] = [];
      while (i < lines.length && LIST_RE.test(lines[i])) {
        const raw = lines[i].replace(LIST_RE, '');
        const task = raw.match(/^\[([ xX])\]\s+(.*)$/);
        items.push(
          <li key={items.length} className="am-card__text" style={{ marginBottom: 4 }}>
            {task ? <><span aria-label={task[1].trim() ? 'Done' : 'To do'}>{task[1].trim() ? '☑' : '☐'}</span> {inline(task[2])}</> : inline(raw)}
          </li>,
        );
        i++;
      }
      blocks.push(ordered
        ? <ol key={key++} style={{ margin: 0, paddingLeft: 24 }}>{items}</ol>
        : <ul key={key++} style={{ margin: 0, paddingLeft: 24, listStyle: /\[[ xX]\]/.test(line) ? 'none' : undefined }}>{items}</ul>);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|>)/.test(lines[i]) && !LIST_RE.test(lines[i]) && !lines[i].trim().startsWith('|') && !/^(-{3,}|\*{3,})$/.test(lines[i].trim())) {
      para.push(lines[i]); i++;
    }
    if (para.length) blocks.push(<p key={key++} className="am-card__text" style={{ lineHeight: 1.6 }}>{inline(para.join(' '))}</p>);
    else i++; // safety: never stall on a line no rule consumed
  }
  return <div className="am-stack" style={{ gap: 12 }}>{blocks}</div>;
}

type Section = { id: string; title: string; body: string };
function splitDoc(md: string): { title: string; intro: string; sections: Section[] } {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  let title = '';
  const intro: string[] = [];
  const sections: Section[] = [];
  for (const line of lines) {
    const h1 = line.match(/^#\s+(.*)$/);
    const h2 = line.match(/^##\s+(.*)$/);
    if (h1 && !title) { title = h1[1]; continue; }
    if (h2) { sections.push({ id: `sec-${sections.length + 1}`, title: h2[1], body: '' }); continue; }
    if (sections.length) sections[sections.length - 1].body += `${line}\n`;
    else intro.push(line);
  }
  return { title, intro: intro.join('\n'), sections };
}

/** A committed markdown doc as a reading layout: intro card, contents card, one card per section. */
export function DocReader({ source }: { source: string }) {
  const doc = splitDoc(source);
  const jump = (id: string) => (e: React.MouseEvent) => { e.preventDefault(); document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  return (
    <div className="am-stack" style={{ maxWidth: 1000, width: '100%' }}>
      <section className="am-card am-card--outlined">
        <div className="am-stack" style={{ gap: 12 }}>
          {doc.title && <h2 className="am-card__title">{inline(doc.title)}</h2>}
          <Blocks source={doc.intro} />
        </div>
      </section>
      {doc.sections.length > 1 && (
        <nav className="am-card am-card--outlined" aria-label="Contents">
          <div className="am-chart__head"><span className="am-chart__title">Contents</span></div>
          <ol style={{ margin: 0, paddingLeft: 24 }}>
            {doc.sections.map((s) => (
              <li key={s.id} className="am-card__text" style={{ marginBottom: 4 }}>
                <a className="am-link" href={`#${s.id}`} onClick={jump(s.id)}>{inline(s.title.replace(/^\d+\.\s*/, ''))}</a>
              </li>
            ))}
          </ol>
        </nav>
      )}
      {doc.sections.map((s) => (
        <section key={s.id} id={s.id} className="am-card am-card--outlined" style={{ scrollMarginTop: 16 }}>
          <div className="am-stack" style={{ gap: 12 }}>
            <h2 className="am-card__title">{inline(s.title)}</h2>
            <Blocks source={s.body} />
          </div>
        </section>
      ))}
    </div>
  );
}

export default function BackendPlanDS() {
  return (
    <DsPage path="/backend-plan" title="Postgres Backend Plan"
      subtitle="Build outline for migrating this app from committed JSON snapshots to an Aurora Postgres backend. Hand this to whoever does the data cleaning and schema build. Source of truth: docs/postgres-backend-outline.md.">
      <DocReader source={outlineMd} />
    </DsPage>
  );
}
