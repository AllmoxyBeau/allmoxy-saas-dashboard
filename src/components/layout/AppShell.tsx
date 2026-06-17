import { useEffect } from 'react';
import Box from '@mui/material/Box';
import { Outlet, useLocation } from 'react-router-dom';
import Header from './Header';
import NavTabs from './NavTabs';

/**
 * Top-level shell — dark bg, header bar, tab nav, content outlet.
 *
 * Also resets scroll to top on every route change. react-router-dom doesn't
 * do this by default, so deep-scrolled pages (like the Churn Risk Matrix
 * attack list or Customers table) would leave you mid-page when navigating
 * to Customer Detail. Scrolling to 0 makes every navigation feel like a
 * fresh page load.
 */
function ScrollToTop() {
  const { pathname, search } = useLocation();
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [pathname, search]);
  return null;
}

export default function AppShell() {
  return (
    <Box
      sx={{
        bgcolor: 'background.default',
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <ScrollToTop />
      <Header />
      <NavTabs />
      <Box component="main" sx={{ flex: 1, p: 3 }}>
        <Outlet />
      </Box>
    </Box>
  );
}
