// Frontend runtime configuration.
// All values that vary by environment come from import.meta.env (Vite).
// Defaults are set for local development.

const apiOrigin = import.meta.env['VITE_API_ORIGIN'] as string | undefined ?? 'http://localhost:3000';

export const config = {
  // API base URL — in dev the Vite proxy rewrites /api/* to the local API server.
  // In production this should be the absolute API origin (e.g. https://api.openaidom.com).
  apiBaseUrl: import.meta.env['VITE_API_BASE_URL'] as string | undefined ?? '/api',

  // Absolute API origin used for browser redirects to API-owned routes that are
  // not served through the Vite /api proxy in local development.
  apiOrigin,

  // Google OAuth initiation endpoint (absolute, served by the API)
  googleAuthUrl: `${apiOrigin}/auth/google`,
};
