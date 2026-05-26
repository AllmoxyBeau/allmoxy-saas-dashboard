import { Link as RouterLink } from 'react-router-dom';
import Link from '@mui/material/Link';

/**
 * Renders a customer name as a clickable link to the Customer Detail page.
 * Pass `id` (allmoxy_customer_id) when available — falls back to `?name=` for
 * data sources that don't carry the ID. CustomerDetail resolves either form on
 * load via URL search params.
 */
export default function CustomerLink({
  id,
  name,
  children,
}: {
  id?: number | string | null;
  name?: string | null;
  children?: React.ReactNode;
}) {
  const label = children ?? name ?? '';
  if (id == null && !name) return <>{label}</>;
  const target = id != null
    ? `/customer-detail?id=${encodeURIComponent(String(id))}`
    : `/customer-detail?name=${encodeURIComponent(String(name))}`;
  return (
    <Link
      component={RouterLink}
      to={target}
      underline="hover"
      sx={{ color: 'inherit', fontWeight: 'inherit', cursor: 'pointer' }}
    >
      {label}
    </Link>
  );
}
