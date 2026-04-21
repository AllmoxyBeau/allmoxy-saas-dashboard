import Box from '@mui/material/Box';
import { Outlet } from 'react-router-dom';
import Header from './Header';
import NavTabs from './NavTabs';

/**
 * Top-level shell — dark bg, header bar, tab nav, content outlet.
 */
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
      <Header />
      <NavTabs />
      <Box component="main" sx={{ flex: 1, p: 3 }}>
        <Outlet />
      </Box>
    </Box>
  );
}
