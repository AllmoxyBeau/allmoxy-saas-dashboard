import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import Box from '@mui/material/Box';
import { useLocation, useNavigate } from 'react-router-dom';
import { NAV_ITEMS } from './navItems';

export default function NavTabs() {
  const location = useLocation();
  const navigate = useNavigate();
  const current = NAV_ITEMS.findIndex((i) => location.pathname.startsWith(i.path));
  const value = current === -1 ? 0 : current;

  return (
    <Box sx={{ bgcolor: 'background.paper', px: 3, borderBottom: '1px solid', borderColor: 'divider' }}>
      <Tabs
        value={value}
        onChange={(_, idx) => navigate(NAV_ITEMS[idx].path)}
        variant="scrollable"
        scrollButtons="auto"
      >
        {NAV_ITEMS.map((item) => (
          <Tab key={item.path} label={item.label} />
        ))}
      </Tabs>
    </Box>
  );
}
