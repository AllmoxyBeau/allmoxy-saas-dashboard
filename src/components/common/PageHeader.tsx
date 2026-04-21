import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import type { ReactNode } from 'react';

type Props = {
  title: string;
  subtitle?: string;
  question?: 'healthy' | 'efficient' | 'durable';
  actions?: ReactNode;
};

const QUESTION_LABEL: Record<NonNullable<Props['question']>, string> = {
  healthy: 'Is the business healthy?',
  efficient: 'Is the business efficient?',
  durable: 'Is the business durable?',
};
export default function PageHeader({ title, subtitle, question, actions }: Props) {
  return (
    <Box sx={{ mb: 3 }}>
      <Stack direction="row" alignItems="flex-end" justifyContent="space-between" spacing={2}>
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 500, mb: 0.5 }}>
            {title}
          </Typography>
          {subtitle && (
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              {subtitle}
            </Typography>
          )}
          {question && (
            <Typography
              variant="caption"
              sx={{
                display: 'inline-block',
                mt: 1,
                px: 1,
                py: 0.25,
                borderRadius: 1,
                bgcolor: 'rgba(44, 115, 255, 0.12)',
                color: 'primary.main',
                fontWeight: 500,
                fontSize: 11,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              {QUESTION_LABEL[question]}
            </Typography>
          )}
        </Box>
        {actions && <Box>{actions}</Box>}
      </Stack>
    </Box>
  );
}
