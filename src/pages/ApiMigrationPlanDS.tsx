/**
 * API Migration Plan on the Allmoxy design system. Same single source of truth as the classic
 * page (ApiMigrationPlan.tsx, kept at /api-migration-plan-classic): docs/api-migration-plan.md,
 * imported raw. Rendered with the design-system DocReader shared with BackendPlanDS.
 */
import { DsPage } from '../design-system/parts';
import { DocReader } from './BackendPlanDS';
import planMd from '../../docs/api-migration-plan.md?raw';

export default function ApiMigrationPlanDS() {
  return (
    <DsPage path="/api-migration-plan" title="API Migration Plan"
      subtitle="Phased plan to replace the manual meta-file upload with direct API connections (Stripe, HubSpot and Harvest now; Allmoxy DB and QuickBooks later), plus how triggering and scheduling change. Source of truth: docs/api-migration-plan.md.">
      <DocReader source={planMd} />
    </DsPage>
  );
}
