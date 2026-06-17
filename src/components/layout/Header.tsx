import { useEffect, useState } from 'react';
import AppBar from '@mui/material/AppBar';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import RefreshIcon from '@mui/icons-material/Refresh';
import VisibilityIcon from '@mui/icons-material/Visibility';
import Tooltip from '@mui/material/Tooltip';
import CircularProgress from '@mui/material/CircularProgress';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useSheetTab } from '../../hooks/useSheetTab';
import { useViewMode } from '../../config/features';

type ProfileRow = { hubspot_data_fetched_at?: string | null };

function timeAgo(iso: string | null | undefined, now: number): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  const diffSec = Math.max(0, Math.floor((now - t) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  // Older — show date
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

export default function Header() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // "View as" dev toggle — only renders when the build flag is on (local).
  // Production builds set canTogglePreview to false so this whole UI is hidden.
  const { viewMode, setViewMode, isPreviewingAsCsRep, canTogglePreview } = useViewMode();
  function handleViewModeChange(_: unknown, next: 'admin' | 'cs_rep' | null) {
    if (!next) return;
    setViewMode(next);
    // If switching to cs_rep view while on a financial page, the route will
    // unregister — bounce to overview so we don't show a 404 / empty render.
    if (next === 'cs_rep' && /^\/(profit-loss|ebitda-bridge|cim-packet|scorecard|banker-handoff|adjustments-register|annual-amortization-evidence|stripe-qb-reconciliation|invariant-tests|definitions)/.test(window.location.pathname)) {
      navigate('/overview');
    }
  }

  // Tick every minute so the "X ago" stays fresh without polling data.
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);

  // Pull customer_profiles to surface the two relevant timestamps:
  // - data.fetchedAt = when the snapshot was last built (full pipeline run)
  // - data.rows[0].hubspot_data_fetched_at = when sync_hubspot.mjs last ran
  const { data } = useSheetTab<ProfileRow>('customer_profiles');
  const builtAt = data?.fetchedAt;
  const hubspotSyncedAt = data?.rows?.find((r) => r.hubspot_data_fetched_at)?.hubspot_data_fetched_at ?? null;

  const builtAgo = timeAgo(builtAt, now);
  const hubspotAgo = timeAgo(hubspotSyncedAt, now);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await queryClient.invalidateQueries();
      // Brief spinner so the user sees something happened
      await new Promise((r) => setTimeout(r, 400));
    } finally {
      setIsRefreshing(false);
    }
  };

  // Build the tooltip with both timestamps
  const tooltipContent = (
    <Box sx={{ p: 0.5, lineHeight: 1.5 }}>
      <Box><strong>Data built:</strong> {formatTimestamp(builtAt)}</Box>
      <Box><strong>HubSpot synced:</strong> {formatTimestamp(hubspotSyncedAt)}</Box>
      <Box sx={{ mt: 0.5, opacity: 0.7, fontSize: 11 }}>
        Click to refetch all snapshots in the browser. To refresh source data,
        run the ETL pipeline locally.
      </Box>
    </Box>
  );

  return (
    <AppBar
      position="sticky"
      elevation={0}
      sx={{
        bgcolor: 'background.paper',
        borderBottom: '1px solid',
        borderColor: 'divider',
        backgroundImage: 'none',
      }}
    >
      <Toolbar sx={{ gap: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
          <Box
            sx={{
              width: 28,
              height: 28,
              bgcolor: 'primary.main',
              borderRadius: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'primary.contrastText',
              fontWeight: 700,
              fontSize: 14,
            }}
          >
            A
          </Box>
          <Typography variant="h6" sx={{ fontWeight: 500, color: 'text.primary' }}>
            Allmoxy SaaS Dashboard
          </Typography>
        </Box>
        <Box sx={{ flex: 1 }} />

        {/* "View as" toggle — local dev only. Lets you preview the CS-rep
            view without restarting Vite. Hidden in production (where
            canTogglePreview is false because the build flag is unset). */}
        {canTogglePreview && (
          <Tooltip
            title={
              <Box sx={{ p: 0.5, lineHeight: 1.5 }}>
                <Box><strong>View as</strong></Box>
                <Box sx={{ fontSize: 11, opacity: 0.85, mt: 0.5 }}>
                  <strong>Admin</strong> — your full view including P&L + QoE tabs.
                </Box>
                <Box sx={{ fontSize: 11, opacity: 0.85, mt: 0.5 }}>
                  <strong>CS Rep</strong> — preview what your CS team sees on Vercel: no P&L, no QoE / Diligence.
                </Box>
              </Box>
            }
            placement="bottom"
            arrow
          >
            <ToggleButtonGroup
              size="small"
              exclusive
              value={viewMode}
              onChange={handleViewModeChange}
              sx={{
                '& .MuiToggleButton-root': {
                  px: 1.5,
                  py: 0.25,
                  fontSize: 11,
                  textTransform: 'none',
                  lineHeight: 1.4,
                  borderColor: 'divider',
                  color: 'text.secondary',
                  '&.Mui-selected': {
                    bgcolor: isPreviewingAsCsRep ? 'warning.main' : 'primary.main',
                    color: 'common.white',
                    '&:hover': { bgcolor: isPreviewingAsCsRep ? 'warning.dark' : 'primary.dark' },
                  },
                },
              }}
            >
              <ToggleButton value="admin">
                <VisibilityIcon sx={{ fontSize: 14, mr: 0.5 }} />
                Admin
              </ToggleButton>
              <ToggleButton value="cs_rep">
                CS Rep
              </ToggleButton>
            </ToggleButtonGroup>
          </Tooltip>
        )}

        {/* Last-refreshed timestamp shown next to the refresh button */}
        {(builtAgo || hubspotAgo) && (
          <Box sx={{ display: { xs: 'none', sm: 'flex' }, flexDirection: 'column', alignItems: 'flex-end', lineHeight: 1.2 }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Last refreshed
            </Typography>
            <Typography variant="caption" sx={{ color: 'text.primary', fontWeight: 600, fontSize: 12 }}>
              {builtAgo ?? '—'}
              {hubspotAgo && hubspotAgo !== builtAgo && (
                <Box component="span" sx={{ color: 'text.secondary', fontWeight: 400, ml: 0.5 }}>
                  · HubSpot {hubspotAgo}
                </Box>
              )}
            </Typography>
          </Box>
        )}

        <Tooltip title={tooltipContent} placement="bottom-end" arrow>
          <span>
            <Button
              size="small"
              onClick={handleRefresh}
              disabled={isRefreshing}
              variant="outlined"
              startIcon={
                isRefreshing
                  ? <CircularProgress size={14} thickness={5} sx={{ color: 'inherit' }} />
                  : <RefreshIcon fontSize="small" />
              }
              sx={{
                textTransform: 'none',
                fontSize: 12,
                color: 'text.secondary',
                borderColor: 'divider',
                '&:hover': { borderColor: 'primary.main', color: 'primary.main' },
              }}
            >
              {isRefreshing ? 'Refreshing…' : 'Refresh'}
            </Button>
          </span>
        </Tooltip>
      </Toolbar>
    </AppBar>
  );
}
