/**
 * Vite plugin that generates a sitemap.xml at build time.
 *
 * Reads the public page registry and route definitions to produce a
 * complete sitemap of all publicly-accessible pages. Authenticated
 * routes are excluded since crawlers cannot access them.
 *
 * Site base URL is read from VITE_SITE_URL env var (required in production).
 */

import type { Plugin } from "vite";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { collectPublicUrls, type SitemapUrl } from "./src/lib/sitemap-urls.js";

const SITEMAP_NS = "http://www.sitemaps.org/schemas/sitemap/0.9";

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function renderUrl(url: SitemapUrl): string {
  const parts: string[] = [`  <url>\n    <loc>${escapeXml(url.loc)}</loc>`];
  if (url.lastmod) parts.push(`\n    <lastmod>${url.lastmod}</lastmod>`);
  if (url.changefreq) parts.push(`\n    <changefreq>${url.changefreq}</changefreq>`);
  if (url.priority !== undefined) parts.push(`\n    <priority>${url.priority.toFixed(1)}</priority>`);
  parts.push("\n  </url>");
  return parts.join("");
}

function renderSitemap(urls: SitemapUrl[]): string {
  const entries = urls.map(renderUrl).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="${SITEMAP_NS}">\n${entries}\n</urlset>\n`;
}

export function sitemapPlugin(): Plugin {
  let resolvedBaseUrl: string | undefined;
  let resolvedOutDir: string | undefined;

  return {
    name: "herobids-sitemap",
    apply: "build",

    configResolved(config) {
      const siteUrl = (config.env as Record<string, string>).VITE_SITE_URL;
      if (siteUrl) {
        resolvedBaseUrl = siteUrl.replace(/\/+$/, "");
      }
      // Resolve outDir relative to the Vite root (cwd at build time)
      resolvedOutDir = join(config.root, config.build.outDir);
    },

    writeBundle() {
      if (!resolvedBaseUrl) {
        this.warn(
          "VITE_SITE_URL is not set — sitemap.xml will NOT be generated. " +
            "Set VITE_SITE_URL to your production domain (e.g. https://openaidom.com) to enable sitemap generation.",
        );
        return;
      }

      const urls = collectPublicUrls(resolvedBaseUrl);
      const xml = renderSitemap(urls);

      const outputPath = join(resolvedOutDir!, "sitemap.xml");
      writeFileSync(outputPath, xml, "utf-8");
      console.log(`  ✓ sitemap.xml generated (${urls.length} URLs)`);
    },
  };
}
