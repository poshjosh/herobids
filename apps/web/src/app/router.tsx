import { createBrowserRouter, Navigate } from 'react-router';
import { RootLayout } from './layout/RootLayout.js';
import { LoginPage } from '../features/auth/LoginPage.js';
import { AuthCallbackPage } from '../features/auth/AuthCallbackPage.js';
import { MissionControlPage } from '../features/mission-control/MissionControlPage.js';
import { ActivityFeedPage } from '../features/activity/ActivityFeedPage.js';
import { OutcomeBoardPage } from '../features/outcomes/OutcomeBoardPage.js';
import { ExposurePage } from '../features/exposure/ExposurePage.js';
import { InstancesPage } from '../features/trading-instances/InstancesPage.js';
import { InstanceDetailPage } from '../features/instances/detail/InstanceDetailPage.js';
import { PortfoliosPage } from '../features/portfolios/PortfoliosPage.js';
import { CredentialsPage } from '../features/credentials/CredentialsPage.js';
import { VenueAccountsPage } from '../features/venue-accounts/VenueAccountsPage.js';

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
      { path: 'activity', element: <ActivityFeedPage /> },
      { path: 'outcomes', element: <OutcomeBoardPage /> },
      { path: 'exposure', element: <ExposurePage /> },
      { path: 'instances', element: <InstancesPage /> },
      { path: 'instances/:id', element: <InstanceDetailPage /> },
      { path: 'portfolios', element: <PortfoliosPage /> },
      { path: 'credentials', element: <CredentialsPage /> },
      { path: 'venue-accounts', element: <VenueAccountsPage /> },
    ],
  },
]);
