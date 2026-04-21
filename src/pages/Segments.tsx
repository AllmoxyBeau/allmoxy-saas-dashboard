import Box from '@mui/material/Box';
import PageHeader from '../components/common/PageHeader';
import ModulePlaceholder from '../components/common/ModulePlaceholder';

export default function Segments() {
  return (
    <Box>
      <PageHeader
        title="Segments"
        subtitle="ARR, retention, and CAC efficiency broken out by vertical and stream."
        question="healthy"
      />
      <ModulePlaceholder
        bullets={[
          'Vertical breakdown: Cabinet Doors / Closet & Storage / Millwork / Components / Hardware / Software-only / Other',
          'ARPC by vertical + stream mix per segment',
          'Retention delta between segments (which verticals are our stickiest?)',
          'Reads from: segments (Phase 0) + classification_master.vertical',
          'Phase 0 ask: tag top-100-by-ARR customers with a `vertical` value in classification_master',
        ]}
      />
    </Box>
  );
}
