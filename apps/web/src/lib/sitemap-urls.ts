/**
 * Sitemap URL collection — pure functions for enumerating all public-facing
 * page URLs. Shared between the Vite sitemap plugin and its unit tests.
 *
 * Uses the same PUBLIC_PAGE_REGISTRY + getSectionPages that the router uses,
 * so the sitemap stays in sync with the actual route set.
 */

import {
  PUBLIC_PAGE_REGISTRY,
  getSectionPages,
} from "../features/public-pages/contentRegistry.js";
import { SUPPORTED_LOCALES } from "../app/i18n/resolveLocale.js";

export interface SitemapUrl {
  loc: string;
  lastmod?: string;
  changefreq?:
    | "always"
    | "hourly"
    | "daily"
    | "weekly"
    | "monthly"
    | "yearly"
    | "never";
  priority?: number;
}

export function collectPublicUrls(baseUrl: string): SitemapUrl[] {
  const urls: SitemapUrl[] = [];
  const today = new Date().toISOString().split("T")[0]!;

  const url = (
    path: string,
    priority = 0.5,
    changefreq: SitemapUrl["changefreq"] = "weekly",
  ): SitemapUrl => ({
    loc: `${baseUrl}${path}`,
    lastmod: today,
    changefreq,
    priority,
  });

  // ── Static public pages ──────────────────────────────────────
  urls.push(url("/", 1.0, "daily"));
  urls.push(url("/login", 0.3, "monthly"));
  urls.push(url("/try", 0.8, "weekly"));

  // ── Public content pages from registry ───────────────────────
  for (const [section, meta] of Object.entries(PUBLIC_PAGE_REGISTRY)) {
    const pages = getSectionPages(meta);
    for (const page of Object.keys(pages)) {
      if (meta.translated) {
        for (const locale of SUPPORTED_LOCALES) {
          urls.push(url(`/${locale}/${section}/${page}`, 0.6));
        }
      } else {
        urls.push(url(`/${section}/${page}`, 0.6));
      }
    }
  }

  return urls;
}
