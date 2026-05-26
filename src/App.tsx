import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import AppShell from './components/layout/AppShell';
import NorthStar from './pages/NorthStar';

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
const CustomerDetail = lazy(() => import('./pages/CustomerDetail'));
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
        <Route path="profit-loss" element={<L><ProfitLoss /></L>} />
        <Route path="segments" element={<L><Segments /></L>} />
        <Route path="scorecard" element={<L><MAReadiness /></L>} />
        <Route path="customer-detail" element={<L><CustomerDetail /></L>} />
        <Route path="custom-report" element={<L><CustomReport /></L>} />
        <Route path="*" element={<Navigate to="/overview" replace />} />
      </Route>
    </Routes>
  );
}
