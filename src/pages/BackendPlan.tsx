import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import PageHeader from '../components/common/PageHeader';
import Markdown from '../components/common/Markdown';
// Single source of truth: the committed handoff doc. Rendered here so the plan
// lives in-app (Maintenance tab) as well as in the repo for the data engineer.
import outlineMd from '../../docs/postgres-backend-outline.md?raw';

export default function BackendPlan() {
  return (
    <Box>
      <PageHeader
        title="Postgres Backend Plan"
        subtitle="Build outline for migrating this app from committed JSON snapshots to an Aurora Postgres backend. Hand this to whoever does the data cleaning + schema build. Source of truth: docs/postgres-backend-outline.md."
      />
      <Paper sx={{ p: { xs: 2, md: 4 }, maxWidth: 1000 }}>
        <Markdown source={outlineMd} />
      </Paper>
    </Box>
  );
}
