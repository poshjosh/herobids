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
| `wordmark-light.png` | Transparent light wordmark | Dark surfaces (sidebar, auth header) |
| `wordmark-dark.png` | Transparent dark wordmark | Light surfaces (email, docs) |
| `compact-mark-light.png` | Light square mark (icon+bg) | Compact UI, app icon fallback |
| `compact-mark-dark.png` | Dark square mark (icon+bg) | Compact UI, app icon fallback |
| `banner.png` | Horizontal banner artwork | Login hero, public landing |
| `favicon-dark/` | Favicon set for dark themes | Browser tabs, PWA (app default) |
| `favicon-light/` | Favicon set for light themes | External embeds, docs |

## Source → Runtime Filename Mapping

Runtime filenames differ from source filenames. When updating an asset,
use this table to determine the correct destination filename.

| Source (`docs/product/brand/images/`) | Runtime (`apps/web/public/brand/`) | Notes |
|---------------------------------------|-------------------------------------|-------|
| `openaidom-logo.png` | `wordmark-light.png` | Transparent light wordmark |
| `openaidom-logo.png` (color-inverted) | `wordmark-dark.png` | Transparent dark wordmark (derived) |
| `openaidom-icon-dark.png` | `compact-mark-dark.png` | Chose variant **with** background over `openaidom-icon-dark-no-bg.png` |
| `openaidom-icon-light.png` | `compact-mark-light.png` | Chose variant **with** background over `openaidom-icon-light-no-bg.png` |
| `openaidom-banner.png` | `banner.png` | Horizontal banner artwork |
| `favicon-dark/` (entire directory) | `favicon-dark/` | Filenames preserved; `site.webmanifest` differs (see below) |
| `favicon-light/` (entire directory) | `favicon-light/` | Filenames preserved; `site.webmanifest` differs (see below) |

## Updating Assets

1. Replace the file in `docs/product/brand/images/` (design authority).
2. Copy the updated file to this directory using the **runtime filename** from the mapping table above — not the source filename.
3. If adding a new variant, add an entry to the mapping table above and update `apps/web/src/brand/tokens.ts`.

## Code-Level Contract

The canonical brand contract is at `apps/web/src/brand/tokens.ts`. It exports:
- Asset path constants (`WORDMARK_LIGHT`, `FAVICON_DARK`, etc.)
- Palette hex values (`BRAND_PALETTE`)
- Image-vs-text fallback policy (doc comments)

All components that render brand marks should import from that module rather
than hard-coding paths or referencing this directory directly.
