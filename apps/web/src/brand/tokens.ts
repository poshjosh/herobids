/**
 * OpenAIdom Brand Contract — Slice 1
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

/** Compact square mark — single asset. Dark/light visibility handled by CSS filter in BrandLogo. */
export const COMPACT_MARK = '/brand/compact-mark.png';

/** Banner artwork for login hero, public landing, and wide treatments. */
export const BANNER = '/brand/banner.png';

/** Dark brand mark for light backgrounds (email headers, etc.). No CSS filter needed. */
export const WORDMARK_DARK = '/brand/wordmark-dark.png';

/** Favicon set — single set with solid navy background, visible on light and dark browser chrome. */
export const FAVICON = {
  ico: '/favicon.ico',
  png: '/favicon-96x96.png',
  svg: '/favicon.svg',
  appleTouch: '/apple-touch-icon.png',
  manifest: '/site.webmanifest',
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
// The fallback text is always "OpenAIdom" — never "HeroBids" in customer-
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
