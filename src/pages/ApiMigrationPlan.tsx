import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import PageHeader from '../components/common/PageHeader';
import Markdown from '../components/common/Markdown';
// Single source of truth: the committed plan doc. Rendered here so it lives
// in-app (Maintenance tab) as well as in the repo for the data engineer.
import planMd from '../../docs/api-migration-plan.md?raw';

export default function ApiMigrationPlan() {
  return (
    <Box>
      <PageHeader
        title="API Migration Plan"
        subtitle="Phased plan to replace the manual meta-file upload with direct API connections (Stripe / HubSpot / Harvest now; Allmoxy DB + QuickBooks later), plus how triggering/scheduling changes. Source of truth: docs/api-migration-plan.md."
      />
      <Paper sx={{ p: { xs: 2, md: 4 }, maxWidth: 1000 }}>
        <Markdown source={planMd} />
      </Paper>
    </Box>
  );
}
