import { createBrowserRouter, Navigate } from 'react-router';
import { RootLayout } from './layout/RootLayout.js';
import { NotFoundPage } from './NotFoundPage.js';
import { LoginPage } from '../features/auth/LoginPage.js';
import { AuthCallbackPage } from '../features/auth/AuthCallbackPage.js';
import { SetupProviderLinkPage } from '../features/setup/SetupProviderLinkPage.js';
import { LandingPagePlaceholder } from '../features/landing/LandingPagePlaceholder.js';
import { createPublicRoutes } from '../features/public-pages/createPublicRoutes.js';
import { ConnectionsPage } from '../features/connections/ConnectionsPage.js';
import { BillingPage } from '../features/billing/BillingPage.js';
import { AgentsPage } from '../features/agents/AgentsPage.js';
import { CreateAgentPage } from '../features/agents/CreateAgentPage.js';
import { AgentDetailPage } from '../features/agents/AgentDetailPage.js';
import { AgentCapabilityPage } from '../features/agents/AgentCapabilityPage.js';
import { SkillsPage } from '../features/skills/SkillsPage.js';
import { TryPage } from '../features/try/TryPage.js';
import { SettingsPage } from '../features/settings/SettingsPage.js';
import { AdminPage } from '../features/admin/AdminPage.js';

export const router = createBrowserRouter([
  // ── Public landing page (no auth) ─────────────────────────────
  { path: '/', element: <LandingPagePlaceholder /> },

  // ── Public pages (no auth) ────────────────────────────────────
  ...createPublicRoutes(),

  {
    path: '/login',
    element: <LoginPage />,
  },
  {
    path: '/auth/callback',
    element: <AuthCallbackPage />,
  },
  {
    path: '/setup/provider-link',
    element: <SetupProviderLinkPage />,
  },
  {
    path: '/try',
    element: <TryPage />,
  },
  // ── Authenticated routes (RootLayout enforces auth) ───────────
  {
    element: <RootLayout />,
    children: [
      { path: '/mission-control', element: <Navigate to="/agents" replace /> },
      { path: '/agents', element: <AgentsPage /> },
      { path: '/agents/new', element: <CreateAgentPage /> },
      { path: '/agents/:id', element: <AgentDetailPage /> },
      { path: '/agents/:agentId/capabilities/:family', element: <AgentCapabilityPage /> },
      { path: '/skills', element: <SkillsPage /> },
      { path: '/connections', element: <ConnectionsPage /> },
      { path: '/billing', element: <BillingPage /> },
      { path: '/settings', element: <SettingsPage /> },
      { path: '/admin', element: <AdminPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
