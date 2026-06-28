import { Navigate, type RouteObject } from 'react-router';
import { PUBLIC_PAGE_REGISTRY, getSectionPages } from './contentRegistry.js';
import { SUPPORTED_LOCALES, type SupportedLocale } from '../../app/i18n/resolveLocale.js';
import { PublicPage } from './PublicPage.js';
import { PublicNotFound } from './PublicNotFound.js';

/**
 * Generates route objects for all public pages from the registry.
 *
 * Two patterns:
 *   `/:locale/<section>/<page>`  for translated sections (help, company)
 *   `/<section>/<page>`          for English-only sections (docs, legal)
 *
 * Unsupported locales redirect to English.
 * Unmatched paths under public section prefixes render a public 404.
 */
export function createPublicRoutes(): RouteObject[] {
  const routes: RouteObject[] = [];

  for (const [section, meta] of Object.entries(PUBLIC_PAGE_REGISTRY)) {
    for (const page of Object.keys(getSectionPages(meta))) {
      if (meta.translated) {
        // Translated: /:locale/<section>/<page>
        routes.push({
          path: `:locale/${section}/${page}`,
          element: <PublicPage section={section} page={page} />,
        });
      } else {
        // English-only: /<section>/<page>
        routes.push({
          path: `${section}/${page}`,
          element: <PublicPage section={section} page={page} />,
        });
      }
    }
  }

  // Redirect non-locale-prefixed translated pages to /en/...
  // e.g. /help/faqs → /en/help/faqs
  for (const section of ['help', 'company']) {
    for (const page of Object.keys(getSectionPages(PUBLIC_PAGE_REGISTRY[section]!))) {
      routes.push({
        path: `${section}/${page}`,
        element: <Navigate to={`/en/${section}/${page}`} replace />,
      });
    }
  }

  // Catch-all 404s for unmatched paths under public section prefixes.
  // These sit after the specific routes so they only match misses.
  // English-only sections: /docs/* and /legal/*
  routes.push(
    { path: 'docs/*', element: <PublicNotFound /> },
    { path: 'legal/*', element: <PublicNotFound /> },
  );
  // Translated sections: /:locale/help/* and /:locale/company/*
  for (const section of ['help', 'company']) {
    routes.push({
      path: `:locale/${section}/*`,
      element: <PublicNotFound />,
    });
  }
  // Non-locale translated misses: /help/* and /company/* → redirect to /en/...
  for (const section of ['help', 'company']) {
    routes.push({
      path: `${section}/*`,
      element: <Navigate to={`/en/${section}`} replace />,
    });
  }

  return routes;
}

// Re-export SUPPORTED_LOCALES for convenience
export { SUPPORTED_LOCALES };
export type { SupportedLocale };
