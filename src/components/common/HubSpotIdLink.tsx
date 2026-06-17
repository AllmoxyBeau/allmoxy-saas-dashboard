import Link from '@mui/material/Link';
import { hubspotCompanyUrl } from '../../lib/hubspot';

/**
 * Renders a HubSpot company ID as a clickable link that opens the company
 * record in HubSpot. Opens in a new tab. Falls back to plain text when no
 * id is supplied (e.g. customers we haven't matched to HubSpot yet).
 */
export default function HubSpotIdLink({
  id,
  label,
  showIcon = false,
}: {
  id: string | number | null | undefined;
  /** Override the displayed text — defaults to the id itself. */
  label?: React.ReactNode;
  showIcon?: boolean;
}) {
  const url = hubspotCompanyUrl(id);
  const display = label ?? (id != null ? String(id) : '—');
  if (!url) return <>{display}</>;
  return (
    <Link
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      underline="hover"
      sx={{ color: 'inherit', fontWeight: 'inherit' }}
    >
      {display}
      {showIcon && <span style={{ marginLeft: 4, fontSize: '0.85em', opacity: 0.6 }}>↗</span>}
    </Link>
  );
}
