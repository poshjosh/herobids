// Frontend runtime configuration.
// All values that vary by environment come from import.meta.env (Vite).
// Defaults are set for local development.

export const config = {
  // API base URL — in dev the Vite proxy rewrites /api/* to the local API server.
  // In production this should be the absolute API origin (e.g. https://api.herobids.com).
  apiBaseUrl: import.meta.env['VITE_API_BASE_URL'] as string | undefined ?? '/api',

  // Google OAuth initiation endpoint (absolute, served by the API)
  googleAuthUrl: (import.meta.env['VITE_API_ORIGIN'] as string | undefined ?? 'http://localhost:3000') + '/auth/google',
};
