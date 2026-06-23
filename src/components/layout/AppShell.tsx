import { useEffect } from 'react';
import Box from '@mui/material/Box';
import { Outlet, useLocation } from 'react-router-dom';
import Header from './Header';
import NavTabs from './NavTabs';

/**
 * Top-level shell — dark bg, header bar, tab nav, content outlet.
 *
 * The shell fills the viewport (height: 100vh) and only the content region
 * scrolls — so the Header + NavTabs stay pinned in place on every page. Sticky
 * table headers then stick to the top of the content region (just below the
 * nav), which is exactly where we want them.
 *
 * Resets the content scroll to top on every route change (react-router-dom
 * doesn't do this by default), so navigating from a deep-scrolled page lands
 * you at the top of the next one.
 */
function ScrollToTop() {
  const { pathname, search } = useLocation();
  useEffect(() => {
    document.getElementById('app-main')?.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [pathname, search]);
  return null;
}

export default function AppShell() {
  return (
    <Box
      sx={{
        bgcolor: 'background.default',
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <ScrollToTop />
      <Header />
      <NavTabs />
      <Box component="main" id="app-main" sx={{ flex: 1, minHeight: 0, overflowY: 'auto', p: 3 }}>
        <Outlet />
      </Box>
    </Box>
  );
}
