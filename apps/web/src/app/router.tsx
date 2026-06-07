import { createBrowserRouter, Navigate } from 'react-router';
import { RootLayout } from './layout/RootLayout.js';
import { LoginPage } from '../features/auth/LoginPage.js';
import { AuthCallbackPage } from '../features/auth/AuthCallbackPage.js';
import { MissionControlPage } from '../features/mission-control/MissionControlPage.js';
import { ActivityFeedPage } from '../features/activity/ActivityFeedPage.js';
import { OutcomeBoardPage } from '../features/outcomes/OutcomeBoardPage.js';
import { ExposurePage } from '../features/exposure/ExposurePage.js';
import { BotsPage } from '../features/bots/BotsPage.js';
import { InstanceDetailPage } from '../features/instances/detail/InstanceDetailPage.js';
import { CredentialsPage } from '../features/credentials/CredentialsPage.js';
import { VenueAccountsPage } from '../features/venue-accounts/VenueAccountsPage.js';
import { ConnectionsPage } from '../features/connections/ConnectionsPage.js';
import { BillingPage } from '../features/billing/BillingPage.js';
import { AgentsPage } from '../features/agents/AgentsPage.js';
import { AgentDetailPage } from '../features/agents/AgentDetailPage.js';
import { AgentCapabilityPage } from '../features/agents/AgentCapabilityPage.js';
import { SkillsPage } from '../features/skills/SkillsPage.js';
import { SettingsPage } from '../features/settings/SettingsPage.js';

export const router = createBrowserRouter([
  {
    path: '/login',
    element: <LoginPage />,
  },
  {
    path: '/auth/callback',
    element: <AuthCallbackPage />,
  },
  {
    path: '/',
    element: <RootLayout />,
    children: [
      { index: true, element: <Navigate to="/mission-control" replace /> },
      { path: 'mission-control', element: <MissionControlPage /> },
      { path: 'skills', element: <SkillsPage /> },
      { path: 'activity', element: <ActivityFeedPage /> },
      { path: 'outcomes', element: <OutcomeBoardPage /> },
      { path: 'bots', element: <BotsPage /> },
      { path: 'bots/:id', element: <InstanceDetailPage /> },
      { path: 'connections', element: <ConnectionsPage /> },
      { path: 'credentials', element: <CredentialsPage /> },
      { path: 'venue-accounts', element: <VenueAccountsPage /> },
      { path: 'agents', element: <AgentsPage /> },
      { path: 'agents/:id', element: <AgentDetailPage /> },
      { path: 'agents/:agentId/capabilities/:family', element: <AgentCapabilityPage /> },
      { path: 'exposure', element: <ExposurePage /> },
      { path: 'billing', element: <BillingPage /> },
      { path: 'settings', element: <SettingsPage /> },
    ],
  },
]);
