import { createBrowserRouter, Navigate, Link } from 'react-router-dom';
import { isSilva, RequireAuth, useMe } from './lib/auth';
import { Spinner } from './components/ui';
import { LoginPage, MfaSetupPage, MfaVerifyPage } from './pages/auth/AuthPages';
import { AdminLayout } from './pages/admin/AdminLayout';
import { AdminCompanies, AdminCompanyDetail, AdminEstablishments, AdminOverview, AdminScreens } from './pages/admin/AdminCore';
import {
  AdminAlerts,
  AdminAnalytics,
  AdminAudit,
  AdminBilling,
  AdminCampaignReview,
  AdminCampaigns,
  AdminNetwork,
  AdminSettings,
  AdminSubscriptions,
  AdminZones,
} from './pages/admin/AdminMore';
import { PortalLayout } from './pages/portal/PortalLayout';
import { PortalBilling, PortalCampaigns, PortalEstablishments, PortalMedia, PortalOverview, PortalSettings, PortalTeam } from './pages/portal/PortalPages';
import { CampaignEditor, PortalCampaignDetail, PortalReports } from './pages/portal/CampaignPages';
import { AdminLeads } from './pages/admin/AdminLeads';
import { LandingPage, PrivacyPage } from './pages/public/Landing';

function Home() {
  const { data: me, isLoading } = useMe();
  if (isLoading) return <Spinner />;
  if (!me) return <Navigate to="/login" replace />;
  return <Navigate to={isSilva(me) ? '/admin' : '/portal'} replace />;
}

function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-3 text-center">
      <h1 className="text-lg font-semibold">Page not found</h1>
      <Link to="/app" className="text-sm text-accent hover:underline">
        Go to your dashboard
      </Link>
    </div>
  );
}

export const router = createBrowserRouter([
  { path: '/', element: <LandingPage /> },
  { path: '/app', element: <Home /> },
  { path: '/privacy', element: <PrivacyPage /> },
  { path: '/login', element: <LoginPage /> },
  { path: '/mfa', element: <MfaVerifyPage /> },
  { path: '/mfa/setup', element: <MfaSetupPage /> },
  {
    path: '/admin',
    element: (
      <RequireAuth area="admin">
        <AdminLayout />
      </RequireAuth>
    ),
    children: [
      { index: true, element: <AdminOverview /> },
      { path: 'companies', element: <AdminCompanies /> },
      { path: 'companies/:companyId', element: <AdminCompanyDetail /> },
      { path: 'establishments', element: <AdminEstablishments /> },
      { path: 'screens', element: <AdminScreens /> },
      { path: 'campaigns', element: <AdminCampaigns /> },
      { path: 'campaigns/:campaignId', element: <AdminCampaignReview /> },
      { path: 'network', element: <AdminNetwork /> },
      { path: 'zones', element: <AdminZones /> },
      { path: 'subscriptions', element: <AdminSubscriptions /> },
      { path: 'billing', element: <AdminBilling /> },
      { path: 'analytics', element: <AdminAnalytics /> },
      { path: 'alerts', element: <AdminAlerts /> },
      { path: 'audit', element: <AdminAudit /> },
      { path: 'settings', element: <AdminSettings /> },
      { path: 'leads', element: <AdminLeads /> },
    ],
  },
  {
    path: '/portal',
    element: (
      <RequireAuth area="portal">
        <PortalLayout />
      </RequireAuth>
    ),
    children: [
      { index: true, element: <PortalOverview /> },
      { path: 'campaigns', element: <PortalCampaigns /> },
      { path: 'campaigns/new', element: <CampaignEditor /> },
      { path: 'campaigns/:campaignId', element: <PortalCampaignDetail /> },
      { path: 'campaigns/:campaignId/edit', element: <CampaignEditor /> },
      { path: 'media', element: <PortalMedia /> },
      { path: 'establishments', element: <PortalEstablishments /> },
      { path: 'reports', element: <PortalReports /> },
      { path: 'billing', element: <PortalBilling /> },
      { path: 'team', element: <PortalTeam /> },
      { path: 'settings', element: <PortalSettings /> },
    ],
  },
  { path: '*', element: <NotFound /> },
]);
