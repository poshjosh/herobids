import { RouterProvider } from 'react-router';
import { QueryProvider } from './providers/QueryProvider.js';
import { SessionProvider } from './providers/SessionProvider.js';
import { router } from './router.js';

export function App() {
  return (
    <QueryProvider>
      <SessionProvider>
        <RouterProvider router={router} />
      </SessionProvider>
    </QueryProvider>
  );
}
