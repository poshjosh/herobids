/**
 * OpenAIDom Brand Contract — Slice 1
 *
 * Single source of truth for brand asset paths and design tokens consumed
 * by the web app, email renderer, and any other runtime surface.
 *
 * Rule: NEVER reference files under docs/product/brand/ directly from app code.
 * All runtime brand assets live under apps/web/public/brand/.
 *
 * @see apps/web/public/brand/README.md for the asset pipeline
 * @see docs/product/brand/brand-palette.md for the design authority
 */

// ─── Asset Paths ────────────────────────────────────────────────────────────
// All paths are relative to the web app's public directory (served at /).

/** Transparent wordmark for dark surfaces (sidebar, auth header, top bar). */
export const WORDMARK_LIGHT = '/brand/wordmark-light.png';

/** Transparent wordmark for light surfaces (email, docs, light-mode UI). */
export const WORDMARK_DARK = '/brand/wordmark-dark.png';

/** Square mark with background — compact UI contexts (favicon fallback, app icon). */
export const COMPACT_MARK_LIGHT = '/brand/compact-mark-light.png';
export const COMPACT_MARK_DARK = '/brand/compact-mark-dark.png';

/** Banner artwork for login hero, public landing, and wide treatments. */
export const BANNER = '/brand/banner.png';

/** Favicon set for dark-themed surfaces (the app default). */
export const FAVICON_DARK = {
  ico: '/brand/favicon-dark/favicon.ico',
  png16: '/brand/favicon-dark/favicon-16x16.png',
  png32: '/brand/favicon-dark/favicon-32x32.png',
  appleTouch: '/brand/favicon-dark/apple-touch-icon.png',
  android192: '/brand/favicon-dark/android-chrome-192x192.png',
  android512: '/brand/favicon-dark/android-chrome-512x512.png',
  manifest: '/brand/favicon-dark/site.webmanifest',
} as const;

/** Favicon set for light-themed surfaces (docs, emails, external embeds). */
export const FAVICON_LIGHT = {
  ico: '/brand/favicon-light/favicon.ico',
  png16: '/brand/favicon-light/favicon-16x16.png',
  png32: '/brand/favicon-light/favicon-32x32.png',
  appleTouch: '/brand/favicon-light/apple-touch-icon.png',
  android192: '/brand/favicon-light/android-chrome-192x192.png',
  android512: '/brand/favicon-light/android-chrome-512x512.png',
  manifest: '/brand/favicon-light/site.webmanifest',
} as const;

// ─── Palette → CSS Custom Property Mapping ──────────────────────────────────
// Derived from docs/product/brand/brand-palette.md.
// These map to custom properties defined in apps/web/src/styles.css.

export const BRAND_PALETTE = {
  /** Primary Navy — dominant brand color, replaces teal as --color-brand. */
  primaryNavy: '#101828',
  /** Accent Indigo — interactive elements, CTAs, links. */
  accentIndigo: '#635BFF',
  /** White — text on dark, card backgrounds on light surfaces. */
  white: '#FFFFFF',
  /** Light Gray — page background on light surfaces, subtle separators. */
  lightGray: '#F5F7FA',
  /** Dark Background — app shell background, dark card surfaces. */
  darkBackground: '#0B1220',
} as const;

/**
 * CSS custom property mapping used in styles.css.
 *
 * | CSS Variable              | Palette Role      | Hex       |
 * |---------------------------|-------------------|-----------|
 * | --brand-primary           | Primary Navy      | `#101828` |
 * | --brand-accent            | Accent Indigo     | `#635BFF` |
 * | --brand-white             | White             | `#FFFFFF` |
 * | --brand-light-gray        | Light Gray        | `#F5F7FA` |
 * | --brand-dark-bg           | Dark Background   | `#0B1220` |
 */

// ─── Typographic Fallback Rules ─────────────────────────────────────────────
//
// When an image-based brand mark cannot be used (email clients, text-only
// contexts, accessibility tools, low-bandwidth), fall back to typographic
// rendering with these rules:
//
//   font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI',
//                Roboto, 'Helvetica Neue', sans-serif;
//   font-weight: 700;
//   letter-spacing: -0.02em;
//   color: var(--brand-accent) on dark backgrounds;
//   color: var(--brand-primary) on light backgrounds;
//
// The fallback text is always "OpenAIDom" — never "HeroBids" in customer-
// facing surfaces.

// ─── Image vs. Text Fallback Policy ─────────────────────────────────────────
//
// | Surface                   | Image | Text Fallback |
// |---------------------------|-------|---------------|
// | Browser favicon           | ✓     | ✗             |
// | PWA / install manifest    | ✓     | ✗             |
// | Sidebar header            | ✓     | ✓ (mobile)    |
// | Public/auth page header   | ✓     | ✓             |
// | Login hero                | ✓     | ✓             |
// | Platform-authored email   | ✗ (1) | ✓             |
// | Plain-text email fallback | ✗     | ✓             |
// | Public docs / legal       | ✗     | ✓             |
// | Agent chat / messages     | ✗     | ✓             |
//
// (1) Image-based email branding is optional polish; validate client rendering
//     before enabling. See 001-plan.md for details.
