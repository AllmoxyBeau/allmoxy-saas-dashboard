import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import ConstructionIcon from '@mui/icons-material/Construction';

type Props = {
  bullets: string[];
};

/**
 * Temporary "this module is still being built" surface. Keeps the shell feeling
 * wired-up during Phase 1 while real content is stubbed per module.
 */
export default function ModulePlaceholder({ bullets }: Props) {
  return (
    <Paper sx={{ p: 4 }}>
      <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: 2 }}>
        <ConstructionIcon sx={{ color: 'primary.main' }} />
        <Typography variant="h6" sx={{ fontWeight: 500 }}>
          Module in progress
        </Typography>
      </Stack>
      <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>
        Planned content for this tab:
      </Typography>
      <Stack component="ul" sx={{ pl: 2, m: 0, gap: 0.75 }}>
        {bullets.map((b) => (
          <Typography key={b} component="li" variant="body2" sx={{ color: 'text.primary' }}>
            {b}
          </Typography>
        ))}
      </Stack>
    </Paper>
  );
}
