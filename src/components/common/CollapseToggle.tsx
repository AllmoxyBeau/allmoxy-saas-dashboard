import { useState, useCallback } from 'react';
import IconButton from '@mui/material/IconButton';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';

export function useCollapse(defaultOpen = true) {
  const [open, setOpen] = useState(defaultOpen);
  const toggle = useCallback(() => setOpen((o) => !o), []);
  return { open, toggle, setOpen };
}

type Props = {
  open: boolean;
  onToggle: () => void;
  label?: string;
};

export default function CollapseToggle({ open, onToggle, label }: Props) {
  return (
    <IconButton
      size="small"
      onClick={onToggle}
      aria-label={open ? `Collapse${label ? ` ${label}` : ''}` : `Expand${label ? ` ${label}` : ''}`}
      sx={{ p: 0.25 }}
    >
      {open ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
    </IconButton>
  );
}
