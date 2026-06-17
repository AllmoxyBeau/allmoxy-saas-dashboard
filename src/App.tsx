import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import AppShell from './components/layout/AppShell';
import NorthStar from './pages/NorthStar';
import { useViewMode } from './config/features';

const CurrentMonth = lazy(() => import('./pages/CurrentMonth'));
const RevenueWaterfall = lazy(() => import('./pages/RevenueWaterfall'));
const LogoWaterfall = lazy(() => import('./pages/LogoWaterfall'));
const CohortRetention = lazy(() => import('./pages/CohortRetention'));
const NetRevenueRetention = lazy(() => import('./pages/NetRevenueRetention'));
const UnitEconomics = lazy(() => import('./pages/UnitEconomics'));
const CustomerHealth = lazy(() => import('./pages/CustomerHealth'));
const Efficiency = lazy(() => import('./pages/Efficiency'));
const ChurnPatterns = lazy(() => import('./pages/ChurnPatterns'));
const ChurnInvestigator = lazy(() => import('./pages/ChurnInvestigator'));
const ProfitLoss = lazy(() => import('./pages/ProfitLoss'));
const Segments = lazy(() => import('./pages/Segments'));
const MAReadiness = lazy(() => import('./pages/MAReadiness'));
const CIMPacket = lazy(() => import('./pages/CIMPacket'));
const AdjustmentsRegister = lazy(() => import('./pages/AdjustmentsRegister'));
const AnnualAmortizationEvidence = lazy(() => import('./pages/AnnualAmortizationEvidence'));
const EbitdaBridge = lazy(() => import('./pages/EbitdaBridge'));
const InvariantTests = lazy(() => import('./pages/InvariantTests'));
const Definitions = lazy(() => import('./pages/Definitions'));
const SubSegmentBackfill = lazy(() => import('./pages/SubSegmentBackfill'));
const BankerHandoff = lazy(() => import('./pages/BankerHandoff'));
const ChurnRiskMatrix = lazy(() => import('./pages/ChurnRiskMatrix'));
const TimeToValue = lazy(() => import('./pages/TimeToValue'));
const StripeQBReconciliation = lazy(() => import('./pages/StripeQBReconciliation'));
const CustomerDetail = lazy(() => import('./pages/CustomerDetail'));
const Customers = lazy(() => import('./pages/Customers'));
const RepDashboard = lazy(() => import('./pages/RepDashboard'));
const CustomReport = lazy(() => import('./pages/CustomReport'));

function RouteFallback() {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', py: 10 }}>
      <CircularProgress size={28} />
    </Box>
  );
}

function L({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<RouteFallback />}>{children}</Suspense>;
}

export default function App() {
  // showFinancialTabs is a runtime hook so the "View as CS Rep" toggle in
  // the Header can disable financial routes without a page reload. In
  // production (build flag off) this always returns false regardless of
  // localStorage state, so prod never registers these routes.
  const { showFinancialTabs } = useViewMode();
  return (
    <Routes>
      <Route path="/" element={<AppShell />}>
        <Route index element={<Navigate to="/overview" replace />} />
        <Route path="overview" element={<NorthStar />} />
        <Route path="current-month" element={<L><CurrentMonth /></L>} />
        <Route path="revenue-waterfall" element={<L><RevenueWaterfall /></L>} />
        <Route path="logo-waterfall" element={<L><LogoWaterfall /></L>} />
        <Route path="cohort-retention" element={<L><CohortRetention /></L>} />
        <Route path="net-revenue-retention" element={<L><NetRevenueRetention /></L>} />
        <Route path="unit-economics" element={<L><UnitEconomics /></L>} />
        <Route path="customer-health" element={<L><CustomerHealth /></L>} />
        <Route path="efficiency" element={<L><Efficiency /></L>} />
        <Route path="churn-patterns" element={<L><ChurnPatterns /></L>} />
        <Route path="churn-investigator" element={<L><ChurnInvestigator /></L>} />
        <Route path="segments" element={<L><Segments /></L>} />
        <Route path="sub-segment-backfill" element={<L><SubSegmentBackfill /></L>} />
        <Route path="churn-risk-matrix" element={<L><ChurnRiskMatrix /></L>} />
        <Route path="time-to-value" element={<L><TimeToValue /></L>} />
        {/* Financial / QoE / diligence routes — registered only when the
            SHOW_FINANCIAL_TABS feature flag is on. In production (Vercel env
            var unset) typing these URLs falls through to the catch-all and
            redirects to /overview. */}
        {showFinancialTabs && (
          <>
            <Route path="profit-loss" element={<L><ProfitLoss /></L>} />
            <Route path="ebitda-bridge" element={<L><EbitdaBridge /></L>} />
            <Route path="scorecard" element={<L><MAReadiness /></L>} />
            <Route path="cim-packet" element={<L><CIMPacket /></L>} />
            <Route path="adjustments-register" element={<L><AdjustmentsRegister /></L>} />
            <Route path="annual-amortization-evidence" element={<L><AnnualAmortizationEvidence /></L>} />
            <Route path="invariant-tests" element={<L><InvariantTests /></L>} />
            <Route path="definitions" element={<L><Definitions /></L>} />
            <Route path="banker-handoff" element={<L><BankerHandoff /></L>} />
            <Route path="stripe-qb-reconciliation" element={<L><StripeQBReconciliation /></L>} />
          </>
        )}
        <Route path="customers" element={<L><Customers /></L>} />
        <Route path="rep-dashboard" element={<L><RepDashboard /></L>} />
        <Route path="customer-detail" element={<L><CustomerDetail /></L>} />
        <Route path="custom-report" element={<L><CustomReport /></L>} />
        <Route path="*" element={<Navigate to="/overview" replace />} />
      </Route>
    </Routes>
  );
}
