import type { ReactNode } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Divider from '@mui/material/Divider';
import Link from '@mui/material/Link';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';

// Minimal GitHub-flavored-markdown renderer — enough for our committed docs
// (headings, hr, blockquote, tables, lists incl. task lists, paragraphs, and
// inline **bold** / `code` / [links](url)). Not a full parser; intentionally
// small so we don't pull in a dependency.

const codeSx = { fontFamily: 'monospace', fontSize: '0.85em', bgcolor: 'rgba(139,148,158,0.18)', px: 0.5, py: 0.1, borderRadius: 0.5 } as const;

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\[([^\]]+)\]\(([^)]+)\))|(\*\*([^*]+)\*\*)|(`([^`]+)`)/g;
  let last = 0; let m: RegExpExecArray | null; let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) {
      const href = m[3];
      const internal = href.startsWith('/');
      out.push(<Link key={i++} href={href} target={internal ? undefined : '_blank'} rel={internal ? undefined : 'noopener noreferrer'} underline="hover">{m[2]}</Link>);
    } else if (m[4]) {
      out.push(<strong key={i++}>{m[5]}</strong>);
    } else if (m[6]) {
      out.push(<Box component="code" key={i++} sx={codeSx}>{m[7]}</Box>);
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function cells(row: string): string[] {
  return row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
}

export default function Markdown({ source }: { source: string }) {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0; let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // blank
    if (!line.trim()) { i++; continue; }

    // headings
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      const variant = level === 1 ? 'h4' : level === 2 ? 'h5' : 'h6';
      blocks.push(
        <Typography key={key++} variant={variant} sx={{ fontWeight: level <= 2 ? 600 : 600, mt: level === 1 ? 0 : 3, mb: 1, fontSize: level === 3 ? '1rem' : level === 4 ? '0.9rem' : undefined, color: level >= 3 ? 'text.secondary' : 'text.primary' }}>
          {inline(h[2])}
        </Typography>,
      );
      i++; continue;
    }

    // horizontal rule
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) { blocks.push(<Divider key={key++} sx={{ my: 2 }} />); i++; continue; }

    // blockquote
    if (line.startsWith('>')) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].startsWith('>')) { buf.push(lines[i].replace(/^>\s?/, '')); i++; }
      blocks.push(
        <Box key={key++} sx={{ borderLeft: '3px solid', borderColor: 'primary.main', pl: 2, py: 0.5, my: 1.5, bgcolor: 'action.hover', borderRadius: '0 4px 4px 0' }}>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>{inline(buf.join(' '))}</Typography>
        </Box>,
      );
      continue;
    }

    // table (header line + separator + rows)
    if (line.trim().startsWith('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const header = cells(line);
      i += 2; // skip header + separator
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) { rows.push(cells(lines[i])); i++; }
      blocks.push(
        <Box key={key++} sx={{ overflowX: 'auto', my: 1.5 }}>
          <Table size="small" sx={{ '& td, & th': { fontSize: 13, py: 0.75 } }}>
            <TableHead>
              <TableRow>{header.map((c, j) => <TableCell key={j} sx={{ fontWeight: 700 }}>{inline(c)}</TableCell>)}</TableRow>
            </TableHead>
            <TableBody>
              {rows.map((r, ri) => <TableRow key={ri} hover>{r.map((c, j) => <TableCell key={j}>{inline(c)}</TableCell>)}</TableRow>)}
            </TableBody>
          </Table>
        </Box>,
      );
      continue;
    }

    // list (- / 1. / - [ ])
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const items: ReactNode[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        const raw = lines[i].replace(/^\s*([-*]|\d+\.)\s+/, '');
        const task = raw.match(/^\[([ xX])\]\s+(.*)$/);
        items.push(
          <Box component="li" key={items.length} sx={{ mb: 0.5 }}>
            {task
              ? <Typography variant="body2" component="span"><Box component="span" sx={{ mr: 0.5 }}>{task[1].trim() ? '☑' : '☐'}</Box>{inline(task[2])}</Typography>
              : <Typography variant="body2" component="span">{inline(raw)}</Typography>}
          </Box>,
        );
        i++;
      }
      blocks.push(<Box component="ul" key={key++} sx={{ my: 1, pl: 3 }}>{items}</Box>);
      continue;
    }

    // paragraph (gather until blank/special)
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|>|\s*[-*]\s|\s*\d+\.\s)/.test(lines[i]) && !lines[i].trim().startsWith('|') && !/^(-{3,}|\*{3,})$/.test(lines[i].trim())) {
      para.push(lines[i]); i++;
    }
    if (para.length) blocks.push(<Typography key={key++} variant="body2" sx={{ my: 1, lineHeight: 1.6 }}>{inline(para.join(' '))}</Typography>);
  }

  return <Box>{blocks}</Box>;
}
