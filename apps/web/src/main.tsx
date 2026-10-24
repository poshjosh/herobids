import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './app/App.js';
import { BackgroundFX } from './app/BackgroundFX.js';
import { ErrorBoundary } from './app/ErrorBoundary.js';
import { registerServiceWorker } from './lib/push/register-service-worker.js';

void registerServiceWorker('serviceWorker' in navigator ? navigator.serviceWorker : undefined);

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <BackgroundFX />
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
