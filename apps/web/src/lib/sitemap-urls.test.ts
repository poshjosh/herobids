import { describe, it, expect } from "vitest";
import { collectPublicUrls } from "./sitemap-urls.js";

const BASE = "https://example.com";

describe("collectPublicUrls", () => {
  it("includes the landing page with highest priority", () => {
    const urls = collectPublicUrls(BASE);
    const landing = urls.find((u) => u.loc === `${BASE}/`);
    expect(landing).toBeDefined();
    expect(landing!.priority).toBe(1.0);
    expect(landing!.changefreq).toBe("daily");
  });

  it("includes static public pages", () => {
    const urls = collectPublicUrls(BASE);
    const locs = urls.map((u) => u.loc);
    expect(locs).toContain(`${BASE}/`);
    expect(locs).toContain(`${BASE}/login`);
    expect(locs).toContain(`${BASE}/try`);
  });

  it("generates locale-prefixed URLs for translated sections", () => {
    const urls = collectPublicUrls(BASE);
    // help/get-started should appear for en, ar, hi
    expect(urls.map((u) => u.loc)).toContain(`${BASE}/en/help/get-started`);
    expect(urls.map((u) => u.loc)).toContain(`${BASE}/ar/help/get-started`);
    expect(urls.map((u) => u.loc)).toContain(`${BASE}/hi/help/get-started`);
  });

  it("does NOT localize English-only sections", () => {
    const urls = collectPublicUrls(BASE);
    const locs = urls.map((u) => u.loc);
    expect(locs).toContain(`${BASE}/legal/privacy-policy`);
    // Must NOT have locale-prefixed legal pages
    expect(locs).not.toContain(`${BASE}/en/legal/privacy-policy`);
  });

  it("includes docs group landing pages (regression: they have real index.md content)", () => {
    const urls = collectPublicUrls(BASE);
    const locs = urls.map((u) => u.loc);
    // Group landing pages
    expect(locs).toContain(`${BASE}/docs/agents`);
    expect(locs).toContain(`${BASE}/docs/messaging`);
    expect(locs).toContain(`${BASE}/docs/reference`);
    expect(locs).toContain(`${BASE}/docs/trading-venues`);
    // Leaf pages still present
    expect(locs).toContain(`${BASE}/docs/agents/agent-style`);
    expect(locs).toContain(`${BASE}/docs/trading-venues/hyperliquid`);
  });

  it("includes all docs leaf pages", () => {
    const urls = collectPublicUrls(BASE);
    const locs = urls.map((u) => u.loc);
    expect(locs).toContain(`${BASE}/docs/agents/agent-style`);
    expect(locs).toContain(`${BASE}/docs/agents/billing-limits`);
    expect(locs).toContain(`${BASE}/docs/messaging/telegram/reply-threading`);
    expect(locs).toContain(`${BASE}/docs/messaging/telegram/slash-commands`);
    expect(locs).toContain(`${BASE}/docs/reference/crypto-ecosystem`);
    expect(locs).toContain(`${BASE}/docs/reference/crypto-ecosystem-aspects`);
    expect(locs).toContain(`${BASE}/docs/reference/glossary`);
    expect(locs).toContain(`${BASE}/docs/trading-venues/hyperliquid`);
    expect(locs).toContain(`${BASE}/docs/trading-venues/bybit`);
    expect(locs).toContain(`${BASE}/docs/trading-venues/jupiter`);
    expect(locs).toContain(`${BASE}/docs/trading-venues/1inch`);
    expect(locs).toContain(`${BASE}/docs/trading-venues/funding-wallets`);
  });

  it("includes all legal pages", () => {
    const urls = collectPublicUrls(BASE);
    const locs = urls.map((u) => u.loc);
    expect(locs).toContain(`${BASE}/legal/privacy-policy`);
    expect(locs).toContain(`${BASE}/legal/user-agreement`);
  });

  it("every URL has a lastmod date", () => {
    const urls = collectPublicUrls(BASE);
    for (const u of urls) {
      expect(u.lastmod).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("every URL has a valid priority between 0 and 1", () => {
    const urls = collectPublicUrls(BASE);
    for (const u of urls) {
      expect(u.priority).toBeGreaterThanOrEqual(0);
      expect(u.priority).toBeLessThanOrEqual(1);
    }
  });

  it("does not include authenticated routes", () => {
    const urls = collectPublicUrls(BASE);
    const locs = urls.map((u) => u.loc);
    expect(locs).not.toContain(`${BASE}/agents`);
    expect(locs).not.toContain(`${BASE}/bots`);
    expect(locs).not.toContain(`${BASE}/settings`);
    expect(locs).not.toContain(`${BASE}/admin`);
  });
});
