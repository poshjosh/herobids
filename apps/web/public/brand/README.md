# Brand Assets — Runtime Destination

This directory is the **single runtime source** for all OpenAIdom brand assets
consumed by the web app, email renderer, and any other production surface.

## Source of Truth

The design authority lives under `docs/product/brand/`:
- `docs/product/brand/brand-palette.md` — official palette values
- `docs/product/brand/images/` — original image files

**Never reference `docs/product/brand/` directly from app code.**
Always use the copies in this directory (or their `/brand/...` URL paths).

## Asset Inventory

| File | Purpose | Surface |
|------|---------|---------|
| `compact-mark.png` | Square mark (silhouette-only — CSS filter handles dark/light) | Sidebar, login, app icon |
| `banner.png` | Horizontal banner artwork | Login hero, public landing |
| `favicon.ico` | Multi-size ICO (legacy) | Browser tabs (root of public/) |
| `favicon-96x96.png` | PNG favicon | Browser tabs |
| `favicon.svg` | SVG favicon | Browser tabs |
| `apple-touch-icon.png` | iOS home screen icon | Mobile |
| `site.webmanifest` | PWA manifest | Mobile install |

Favicon files live at the root of `apps/web/public/` (not inside `brand/`) — they were generated via [RealFaviconGenerator](https://realfavicongenerator.net) using a solid navy-background 512×512 source.

## Source → Runtime Filename Mapping

Runtime filenames differ from source filenames. When updating an asset,
use this table to determine the correct destination filename.

| Source (`docs/product/brand/images/`) | Runtime (`apps/web/public/brand/`) | Notes |
|---------------------------------------|-------------------------------------|-------|
| `openaidom-icon-light-no-bg.png` | `compact-mark.png` | Silhouette-only; CSS filter in BrandLogo handles dark/light rendering |
| `openaidom-banner.png` | `banner.png` | Horizontal banner artwork |

Favicon files are generated separately — see `apps/web/public/` for `favicon.ico`, `favicon-96x96.png`, `favicon.svg`, `apple-touch-icon.png`, and `site.webmanifest`.

## Updating Assets

1. Replace the file in `docs/product/brand/images/` (design authority).
2. Copy the updated file to this directory using the **runtime filename** from the mapping table above — not the source filename.
3. If adding a new variant, add an entry to the mapping table above and update `apps/web/src/brand/tokens.ts`.

## Code-Level Contract

The canonical brand contract is at `apps/web/src/brand/tokens.ts`. It exports:
- Asset path constants (`COMPACT_MARK`, `FAVICON`, `BANNER`)
- Palette hex values (`BRAND_PALETTE`)
- Favicon paths (`FAVICON`)
- Image-vs-text fallback policy (doc comments)

All components that render brand marks should import from that module rather
than hard-coding paths or referencing this directory directly.
