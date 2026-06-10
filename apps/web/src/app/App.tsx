import { RouterProvider } from 'react-router';
import { QueryProvider } from './providers/QueryProvider.js';
import { SessionProvider } from './providers/SessionProvider.js';
import { I18nProvider } from './i18n/I18nProvider.js';
import { router } from './router.js';

export function App() {
  return (
    <I18nProvider>
      <QueryProvider>
        <SessionProvider>
          <RouterProvider router={router} />
        </SessionProvider>
      </QueryProvider>
    </I18nProvider>
  );
}
