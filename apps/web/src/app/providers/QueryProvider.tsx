import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: (failureCount, error) => {
        // Don't retry on auth errors
        if (error instanceof Error && 'status' in error && (error as { status: number }).status === 401) {
          return false;
        }
        return failureCount < 2;
      },
    },
  },
});

export function QueryProvider({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
