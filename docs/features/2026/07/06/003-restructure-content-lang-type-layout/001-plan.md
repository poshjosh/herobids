# Restructure Public Content to `{lang}/{type}/` Layout

**Status:** pending  
**Date:** 2026-07-06  
**Scope:** `apps/web/src/features/public-pages/content/`

## Motivation

The current content directory structure is `content/{type}/{lang}/` (e.g., `content/help/en/get-started.md`). This is an unconventional i18n layout. The industry standard is `content/{lang}/{type}/` (e.g., `content/en/help/get-started.md`), used by Next.js, Rails, Hugo, Docusaurus, and most i18n libraries.

Benefits of the standard layout:
- **Delegable translation** — a translator owns one folder tree (e.g., `content/ar/`)
- **Language coverage visibility** — `ls content/en/` shows all content in English
- **Adding a language** — copy `content/en/` once instead of touching every content-type folder
- **Simpler `loadContent`** — single unified code path instead of translated vs English-only branches

## Current State

```
content/
  company/en/about-us.md        ← {type}/{lang}/
  company/en/contact-us.md
  help/en/get-started.md
  help/en/faqs.md
  help/en/pricing.md
  docs/agents/agent-style.md    ← no lang folder (English-only)
  docs/agents/billing-limits.md
  docs/agents/index.md
  docs/messaging/telegram/reply-threading.md
  docs/messaging/telegram/slash-commands.md
  docs/messaging/index.md
  docs/reference/glossary.md
  legal/privacy-policy.md       ← flat, no lang folder
  legal/user-agreement.md
```

Only `help/` and `company/` have locale subdirectories. `docs/` and `legal/` are flat. This inconsistency is resolved by the new layout.

## Target State

```
content/
  en/
    company/about-us.md
    company/contact-us.md
    help/get-started.md
    help/faqs.md
    help/pricing.md
    docs/agents/agent-style.md
    docs/agents/billing-limits.md
    docs/agents/index.md
    docs/messaging/telegram/reply-threading.md
    docs/messaging/telegram/slash-commands.md
    docs/messaging/index.md
    docs/reference/glossary.md
    legal/privacy-policy.md
    legal/user-agreement.md
```

URL patterns **do not change** — the routing is unchanged:
- `/:locale/help/get-started` → `content/{locale}/help/get-started.md` (translated)
- `/docs/agents/agent-style` → `content/en/docs/agents/agent-style.md` (English-only)

## Implementation Plan

### Step 1 — Move all content files to `content/en/`

Move every `.md` file under the `content/` tree into the new `content/en/` directory, mirroring the same `{type}/...` sub-structure:

| From | To |
|------|----|
| `content/company/en/about-us.md` | `content/en/company/about-us.md` |
| `content/company/en/contact-us.md` | `content/en/company/contact-us.md` |
| `content/help/en/get-started.md` | `content/en/help/get-started.md` |
| `content/help/en/faqs.md` | `content/en/help/faqs.md` |
| `content/help/en/pricing.md` | `content/en/help/pricing.md` |
| `content/docs/agents/agent-style.md` | `content/en/docs/agents/agent-style.md` |
| `content/docs/agents/billing-limits.md` | `content/en/docs/agents/billing-limits.md` |
| `content/docs/agents/index.md` | `content/en/docs/agents/index.md` |
| `content/docs/messaging/telegram/reply-threading.md` | `content/en/docs/messaging/telegram/reply-threading.md` |
| `content/docs/messaging/telegram/slash-commands.md` | `content/en/docs/messaging/telegram/slash-commands.md` |
| `content/docs/messaging/index.md` | `content/en/docs/messaging/index.md` |
| `content/docs/reference/glossary.md` | `content/en/docs/reference/glossary.md` |
| `content/legal/privacy-policy.md` | `content/en/legal/privacy-policy.md` |
| `content/legal/user-agreement.md` | `content/en/legal/user-agreement.md` |

Delete the now-empty directories: `content/company/`, `content/help/`, `content/docs/`, `content/legal/`.

### Step 2 — Simplify `loadContent.ts`

**File:** `apps/web/src/features/public-pages/loadContent.ts`

Currently has two branches:
- **Translated sections** (line 41–57): tries `./content/${section}/${loc}/${page}.md` with locale fallback
- **English-only sections** (line 60–65): tries `./content/${section}/${page}.md` (no locale)

After the restructure, all content lives at `./content/{locale}/{section}/{page}.md`. The function collapses into a **single unified path**:

```typescript
export async function loadContent(
  section: PublicSection,
  page: string,
  locale?: string,
): Promise<LoadedContent | null> {
  // All content lives under content/{locale}/{section}/{page}.md
  // English-only sections always use 'en'; translated sections use the URL param
  const effectiveLocale = isTranslatedSection(section) ? (locale ?? 'en') : 'en';
  const localesToTry = effectiveLocale !== 'en' ? [effectiveLocale, 'en'] : ['en'];

  let matched: (() => Promise<string>) | undefined;
  for (const loc of localesToTry) {
    const path = `./content/${loc}/${section}/${page}.md`;
    if (path in contentModules) {
      matched = contentModules[path];
      break;
    }
  }

  // Also try index.md fallback for group landing pages (e.g. docs/agents/index.md)
  if (!matched) {
    for (const loc of localesToTry) {
      const indexPath = `./content/${loc}/${section}/${page}/index.md`;
      if (indexPath in contentModules) {
        matched = contentModules[indexPath];
        break;
      }
    }
  }

  if (!matched) return null;

  const raw = await matched();
  return { content: raw, title: extractTitle(raw) };
}
```

**Key simplification:** The `isTranslatedSection` branch disappears — both translated and English-only sections use the same path pattern. The only difference is that English-only sections always resolve `locale` to `'en'`.

### Step 3 — Update JSDoc in `contentRegistry.ts`

**File:** `apps/web/src/features/public-pages/contentRegistry.ts`

Update the file header comment (lines 4–7):

```diff
- * Every page listed here must have a corresponding markdown file
- * under `content/<section>/<page>.md` (or `content/<section>/<locale>/<page>.md`
- * for translated sections).
+ * Every page listed here must have a corresponding markdown file
+ * under `content/<locale>/<section>/<page>.md` (e.g. `content/en/help/get-started.md`).
+ * English-only sections always resolve to the `en` locale.
```

### Step 4 — Verify no regressions

- `pnpm lint` — must pass
- `pnpm test` — must pass (includes `public-pages.test.tsx` which exercises `loadContent` and footer links)
- Manual visual check: ensure all public routes render correctly (`/en/help/get-started`, `/docs/agents/agent-style`, `/legal/privacy-policy`, etc.)

## What does NOT change

| Asset | Reason |
|-------|--------|
| `createPublicRoutes.tsx` | Route patterns (`/:locale/help/page`, `/docs/page`) are unchanged |
| `PublicLayout.tsx` | URL building (`publicUrl()`) is independent of disk layout |
| `PublicPage.tsx` | Locale resolution logic unchanged |
| `contentRegistry.ts` constants | `TRANSLATED_SECTIONS` and `ENGLISH_ONLY_SECTIONS` still valid for routing |
| `resolveLocale.ts` | Locale detection is independent of disk layout |
| i18n locale files (`en.ts`, `ar.ts`, `hi.ts`) | UI string translations unchanged |
| `public-pages.test.tsx` | Tests call abstract `loadContent()`, not disk paths |
| `declarations.d.ts` | `.md` module declaration unchanged |
| `vite.config.ts` | Vite handles `import.meta.glob('./content/**/*.md')` at any depth |

## Risks

- **Low risk.** The `import.meta.glob` glob pattern (`./content/**/*.md`) matches any nesting depth, so moving files does not break discovery. The only code change is in `loadContent.ts` (path construction) and a JSDoc comment. Routing, URL building, tests, and all other components are abstracted from the disk layout.
