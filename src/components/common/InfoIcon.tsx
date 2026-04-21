import type { ReactNode } from 'react';
import Box from '@mui/material/Box';
import Tooltip from '@mui/material/Tooltip';
import IconButton from '@mui/material/IconButton';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';

// Small ℹ icon with a tooltip that explains what a metric or chart represents,
// how the number is derived, and the target threshold. Used across the dashboard
// so every card/chart can answer "what does this mean?" in one hover.
export default function InfoIcon({ info }: { info: ReactNode }) {
  return (
    <Tooltip
      title={<Box sx={{ fontSize: 12, lineHeight: 1.55, maxWidth: 360 }}>{info}</Box>}
      arrow
      placement="top"
      enterTouchDelay={0}
      leaveTouchDelay={5000}
    >
      <IconButton size="small" sx={{ p: 0.25, color: 'text.secondary', '&:hover': { color: 'primary.main' } }}>
        <InfoOutlinedIcon sx={{ fontSize: 15 }} />
      </IconButton>
    </Tooltip>
  );
}
