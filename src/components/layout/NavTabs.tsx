import { useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown';
import { useLocation, useNavigate } from 'react-router-dom';
import { NAV_ENTRIES, isGroup, type NavEntry, type NavGroup, type NavLeaf } from './navItems';
import { useViewMode } from '../../config/features';

function isActiveLeaf(pathname: string, leaf: NavLeaf): boolean {
  return pathname === leaf.path || pathname.startsWith(leaf.path + '/');
}

function entryIsActive(pathname: string, entry: NavEntry): boolean {
  if (isGroup(entry)) return entry.items.some((i) => isActiveLeaf(pathname, i));
  return isActiveLeaf(pathname, entry);
}

type HoverCtl = {
  openLabel: string | null;
  openNow: (label: string) => void;
  closeSoon: () => void;
  closeNow: () => void;
};

function GroupButton({ group, pathname, hover }: { group: NavGroup; pathname: string; hover: HoverCtl }) {
  const navigate = useNavigate();
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const active = entryIsActive(pathname, group);
  const open = hover.openLabel === group.label;

  const select = (path: string) => { hover.closeNow(); navigate(path); };

  return (
    <Box
      onMouseEnter={() => hover.openNow(group.label)}
      onMouseLeave={hover.closeSoon}
      sx={{ display: 'inline-flex' }}
    >
      <Button
        ref={anchorRef}
        onClick={() => (open ? hover.closeNow() : hover.openNow(group.label))}
        endIcon={<ArrowDropDownIcon />}
        disableRipple
        sx={{
          textTransform: 'none',
          fontSize: '0.875rem',
          fontWeight: active ? 600 : 500,
          color: active ? 'primary.main' : 'text.secondary',
          borderBottom: '2px solid',
          borderColor: active ? 'primary.main' : 'transparent',
          borderRadius: 0,
          px: 1.5,
          py: 1.5,
          minHeight: 48,
          whiteSpace: 'nowrap',
          '&:hover': {
            bgcolor: 'transparent',
            color: active ? 'primary.main' : 'text.primary',
          },
        }}
      >
        {group.label}
      </Button>
      <Menu
        anchorEl={anchorRef.current}
        open={open}
        onClose={hover.closeNow}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        // Let pointer events fall through the backdrop so hovering a sibling tab
        // can switch the open menu; re-enable them on the menu paper itself.
        slotProps={{
          root: { sx: { pointerEvents: 'none' } },
          paper: { sx: { mt: 0, minWidth: 220, pointerEvents: 'auto' } },
        }}
        MenuListProps={{
          onMouseEnter: () => hover.openNow(group.label),
          onMouseLeave: hover.closeSoon,
          sx: { py: 0.5 },
        }}
        disableScrollLock
        disableAutoFocus
        disableEnforceFocus
        disableRestoreFocus
        keepMounted
      >
        {group.items.map((leaf) => {
          const selected = isActiveLeaf(pathname, leaf);
          return (
            <MenuItem
              key={leaf.path}
              selected={selected}
              onClick={() => select(leaf.path)}
              sx={{
                fontSize: '0.875rem',
                fontWeight: selected ? 600 : 400,
                color: selected ? 'primary.main' : 'text.primary',
              }}
            >
              {leaf.label}
            </MenuItem>
          );
        })}
      </Menu>
    </Box>
  );
}

function LeafButton({ leaf, pathname, hover }: { leaf: NavLeaf; pathname: string; hover: HoverCtl }) {
  const navigate = useNavigate();
  const active = isActiveLeaf(pathname, leaf);
  return (
    <Button
      // Hovering a plain tab should also dismiss any open dropdown.
      onMouseEnter={hover.closeNow}
      onClick={() => navigate(leaf.path)}
      disableRipple
      sx={{
        textTransform: 'none',
        fontSize: '0.875rem',
        fontWeight: active ? 600 : 500,
        color: active ? 'primary.main' : 'text.secondary',
        borderBottom: '2px solid',
        borderColor: active ? 'primary.main' : 'transparent',
        borderRadius: 0,
        px: 1.5,
        py: 1.5,
        minHeight: 48,
        whiteSpace: 'nowrap',
        '&:hover': {
          bgcolor: 'transparent',
          color: active ? 'primary.main' : 'text.primary',
        },
      }}
    >
      {leaf.label}
    </Button>
  );
}

export default function NavTabs() {
  const location = useLocation();
  const pathname = location.pathname;
  // When previewing as CS Rep, filter out entries flagged as financial. In
  // production (build flag off) financial entries aren't in NAV_ENTRIES at
  // all, so this filter is a no-op there.
  const { showFinancialTabs } = useViewMode();
  const visibleEntries = showFinancialTabs
    ? NAV_ENTRIES
    : NAV_ENTRIES.filter((e) => !e.financial);

  // Single open-dropdown state shared across all groups, so opening one closes
  // the others. A short close delay (hover intent) lets the pointer travel from
  // a tab button to its menu without the menu flickering shut.
  const [openLabel, setOpenLabel] = useState<string | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hover: HoverCtl = {
    openLabel,
    openNow: (label) => { clearTimeout(closeTimer.current); setOpenLabel(label); },
    closeSoon: () => { clearTimeout(closeTimer.current); closeTimer.current = setTimeout(() => setOpenLabel(null), 120); },
    closeNow: () => { clearTimeout(closeTimer.current); setOpenLabel(null); },
  };

  return (
    <Box
      sx={{
        bgcolor: 'background.paper',
        px: 3,
        borderBottom: '1px solid',
        borderColor: 'divider',
        overflowX: 'auto',
      }}
    >
      <Stack direction="row" spacing={0.5} alignItems="stretch">
        {visibleEntries.map((entry) =>
          isGroup(entry) ? (
            <GroupButton key={entry.label} group={entry} pathname={pathname} hover={hover} />
          ) : (
            <LeafButton key={entry.path} leaf={entry} pathname={pathname} hover={hover} />
          ),
        )}
      </Stack>
    </Box>
  );
}
