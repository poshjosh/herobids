# Plan: OpenAIdom Brand Rollout Across Web, Email, and Public Docs

**Status:** Done  
**Created:** 2026-07-12  
**Goal:** Introduce OpenAIdom as the customer-facing brand across the web app, platform-authored email, and public documentation, while keeping internal repository, package, Docker, and database names unchanged unless a later migration explicitly changes them.

---

## Summary

OpenAIdom currently behaves like one product operationally but presents itself inconsistently across surfaces:

1. the web app chrome still uses text-only `OpenAIdom` labels
2. the web shell has no favicon or brand asset pipeline wired into runtime assets
3. platform-authored email is either plain text or visually inconsistent
4. public docs and support content still speak in the old brand voice and domain
5. the new OpenAIdom brand assets and palette exist under `docs/product/brand/`, but they are not yet part of the app delivery path

The rollout should be treated as a product-surface branding change, not as a broad internal rename.

Recommended sequence:

1. establish the brand asset pipeline and shared design tokens
2. introduce a reusable brand component into web chrome and auth/public pages
3. wire browser metadata, favicon, and install assets
4. ship a shared branded email shell for platform-authored email
5. update customer-facing docs, public copy, and legal/contact references
6. align the final domain-facing presentation with the separate OpenAIdom domain rollout plan

This plan complements, but does not replace, the deployment-focused domain move in `docs/features/2026/07/12/001-openaidom-domain-rollout/001-plan.md`.

---

## Product Positioning

This plan assumes the following brand posture:

1. **OpenAIdom** is the intended customer-facing product identity
2. **OpenAIdom** remains an internal engineering and operational name for now
3. public surfaces should feel intentionally branded even before a deeper design-system overhaul
4. branding should be introduced in layers, starting with the highest-visibility surfaces
5. the rollout must not break auth, billing, email delivery, or localization contracts

This is the lowest-risk approach because it avoids coupling visual rebranding to package renames, schema renames, or infrastructure moves that are not required to ship the customer-facing change.

---

## Current Baseline

### Web UI

1. the authenticated shell uses plain `OpenAIdom` text in the sidebar and mobile top bar
2. public pages also use a plain text label instead of a wordmark or brand mark
3. login and auth flows use the existing dark UI but are not visually tied to a formal brand system
4. `apps/web/index.html` currently sets only a basic document title and no favicon or manifest assets
5. `apps/web/src/styles.css` defines a teal-forward brand token set that does not match the OpenAIdom image assets

### Email

1. auth login-link mail is plain text today
2. worker billing mail has no shared branded shell
3. platform safety alerts are not yet part of a broader branded email system
4. there is no single shared visual contract for platform-authored mail

### Docs and Public Content

1. public help/company/legal/docs pages are served from the web app, but the copy still reflects the older brand identity
2. product-facing docs, contact information, and legal references are not yet reviewed as a coordinated brand pass
3. there is no single checklist for finding and replacing customer-facing `OpenAIdom` references while intentionally leaving internal engineering names alone

### Assets

1. the current brand source of truth lives under `docs/product/brand/`
2. image assets live under `docs/product/brand/images/`
3. the palette lives in `docs/product/brand/brand-palette.md`
4. those assets are not runtime-served from the web app today
5. no authoritative mapping exists yet for which asset variant is used in which surface

---

## Goals

After this feature:

1. the app shell, login page, and public pages visibly read as OpenAIdom
2. browser tabs, bookmarks, and install surfaces show matching favicon and manifest assets
3. platform-authored email uses a shared branded shell with plain-text fallback
4. customer-facing documentation and legal/support copy align with the new brand and canonical domain
5. the rollout remains compatible with the accepted web i18n contract and the separate domain cutover plan

---

## Non-Goals

This plan does not include:

1. renaming workspace packages from `@herobids/*`
2. renaming database names, Docker image names, service names, or internal Terraform identifiers
3. redesigning the entire product IA, navigation model, or core interaction patterns
4. translating newly revised brand copy into more locales than the product currently supports in this slice
5. a marketing-site rebuild separate from the existing web app
6. agent-authored email fanout branding changes

---

## Brand Decisions To Lock Early

These decisions should be settled before implementation starts to avoid churn:

1. the authoritative customer-facing name is `OpenAIdom`
2. the legal or operator identity may still reference OpenAIdom where required, for example `OpenAIdom,`
3. the current brand source of truth is `docs/product/brand/`, with images in `docs/product/brand/images/` and palette values in `docs/product/brand/brand-palette.md`
4. the product should support both image-based and typographic fallback brand headers
5. existing dark surfaces can stay dark if the new token palette is adjusted to match the OpenAIdom mark rather than forcing a full visual redesign

Implementation defaults locked for this rollout:

1. Customer-facing body copy should switch to `OpenAIdom`; use a dual-label such as `OpenAIdom,` only where legal or operator disclosure requires it.
2. Email may ship first with a typographic `OpenAIdom` header; image-based email branding is optional polish after client rendering is validated.
3. The canonical production URL is `https://openaidom.com`; `https://www.openaidom.com` and `https://app.openaidom.com` are supported aliases, and staging uses `https://staging.openaidom.com`.

---

## Proposed Asset Strategy

Use the current brand docs as the source of truth, then promote only the approved runtime variants into the app.

Current palette authority:

1. Primary Navy: `#101828`
2. Accent Indigo: `#635BFF`
3. White: `#FFFFFF`
4. Light Gray: `#F5F7FA`
5. Dark Background: `#0B1220`

Recommended usage split:

1. square mark or favicon set for browser tabs, PWA metadata, and compact UI surfaces
2. transparent wordmark variants for sidebar/public/auth headers
3. banner artwork for login/public hero treatments where horizontal space exists
4. typographic fallback for email or edge surfaces where remote images are undesirable

Recommended implementation rule:

1. treat `docs/product/brand/` as the design and documentation source of truth
2. copy approved runtime assets from `docs/product/brand/images/` into a stable served location under the web app
3. derive or map app theme tokens from `docs/product/brand/brand-palette.md`
4. reference only runtime-served assets from product code
5. never point production code directly at documentation paths

---

## Likely Repo Surfaces

| Area | Likely files |
|---|---|
| Web shell branding | `apps/web/src/app/layout/RootLayout.tsx`, `apps/web/src/app/layout/Sidebar.tsx`, shared UI helpers |
| Auth/public page branding | `apps/web/src/features/auth/LoginPage.tsx`, `apps/web/src/features/public-pages/PublicLayout.tsx`, public page components |
| Browser metadata | `apps/web/index.html`, runtime public asset directory, manifest assets |
| Theme tokens | `apps/web/src/styles.css` |
| Email rendering | `apps/api/src/auth-mailer.ts`, `apps/worker/src/alerting/email-client.ts`, `apps/worker/src/alerting/ses-email-client.ts`, shared renderer module |
| Worker alerting | `apps/worker/src/agents/agent-message-broker.ts`, `apps/worker/src/alerting/platform-alert-service.ts` |
| Public docs and content | `apps/web/src/features/public-pages/content/**` |
| Brand source material | `docs/product/brand/brand-palette.md`, `docs/product/brand/images/` |
| Brand/domain documentation | `docs/features/2026/07/12/001-openaidom-domain-rollout/001-plan.md`, runbooks, contact/legal copy |

The canonical domain/implementation source for this work is `docs/features/2026/07/12/001-openaidom-domain-rollout/001-plan.md`.

---

## Implementation Plan

### Slice 1 — Asset Intake and Brand Contract

Goal: decide what brand assets exist, where they will be served from, and how code references them.

Tasks:

1. review the brand materials in `docs/product/brand/`, including `docs/product/brand/images/` and `docs/product/brand/brand-palette.md`
2. pick approved runtime image variants for dark and light surfaces
3. translate the documented palette into app token targets for web and email
4. create a stable runtime asset destination in the web app for brand images and favicon files
5. define a lightweight brand contract covering:
   - wordmark asset
   - compact mark asset
   - favicon set
   - optional banner asset
   - palette-to-token mapping
   - typographic fallback rules
6. document where image-based branding is allowed versus where text fallback is preferred
7. add a short internal note or README if needed so future changes do not reference documentation assets directly from app code

Expected result:

All later slices consume a deliberate asset contract rather than hard-coding whichever image happened to exist locally.

### Slice 2 — Shared Web Brand Component

Goal: introduce one reusable brand primitive for app chrome and public surfaces.

Tasks:

1. create a shared web brand component that can render:
   - mark only
   - wordmark only
   - mark plus wordmark
   - typographic fallback
2. support light/dark variants without duplicating branding logic in each page
3. make the component responsive so compact shells can collapse to a simpler treatment
4. keep the component free of route-specific copy so it remains reusable across app, auth, and public pages

Expected result:

Brand rendering becomes a single surface-owned abstraction instead of multiple ad hoc `OpenAIdom` text labels.

### Slice 3 — App Shell and Auth/Public Surface Rollout

Goal: replace the highest-visibility text-only brand treatments in the product.

Tasks:

1. replace the sidebar brand label in `apps/web/src/app/layout/Sidebar.tsx` with the shared brand component
2. replace the mobile top-bar label in `apps/web/src/app/layout/RootLayout.tsx`
3. update `apps/web/src/features/public-pages/PublicLayout.tsx` to use the new brand treatment in the public header
4. add a branded treatment to `apps/web/src/features/auth/LoginPage.tsx`, ideally using the wordmark or banner rather than only form controls
5. check supporting surfaces such as loading states, error boundaries, empty states, or 404s for lingering unbranded text-only headers

Expected result:

Users see OpenAIdom immediately when entering either the authenticated app or public/auth flows.

### Slice 4 — Browser Metadata, Favicon, and Install Surface

Goal: ensure the browser-level product identity matches the UI identity.

Tasks:

1. wire favicon assets into `apps/web/index.html`
2. add or update `site.webmanifest` and touch icons using the approved asset set
3. update the document title and any default social/share metadata owned by the web shell
4. verify the correct icon variant is used for tabs, bookmarks, pinned shortcuts, and mobile install prompts

Expected result:

The product stops presenting as an unbranded SPA in browser chrome.

### Slice 5 — Theme Token Alignment

Goal: bring the existing UI color system closer to the new asset palette without forcing a full redesign.

Tasks:

1. audit `apps/web/src/styles.css` brand tokens against `docs/product/brand/brand-palette.md`
2. replace the current teal-forward `--color-brand` family if it clashes with the documented navy and indigo palette
3. map the documented palette into a minimal token set for primary accent, dark surfaces, subtle surfaces, and text-on-brand usage
4. adjust subtle backgrounds, hover states, and badge accents only where needed to avoid mismatched color semantics
5. preserve existing contrast and accessibility behavior
6. avoid broad restyling of unrelated feature surfaces unless token changes naturally improve them

Expected result:

The UI reads as one brand system instead of a dark product shell with unrelated accent colors.

### Slice 6 — Branded Platform Email Shell

Goal: unify auth, billing, and platform safety email under one branded presentation layer.

Tasks:

1. create or extend a shared email renderer that returns `subject`, `text`, and `html`
2. define a branded HTML shell with:
   - strong header
   - concise explanatory body
   - CTA region when needed
   - muted footer
   - raw-link fallback block
3. support a brand image when appropriate, but preserve a typographic fallback for clients where remote images are undesirable or brittle
4. keep the renderer pure and shared so API and worker do not drift
5. ensure the plain-text version remains complete and usable without HTML

Expected result:

Platform-authored email feels like one product and can evolve visually from a central place.

### Slice 7 — Auth, Billing, and Safety Email Migration

Goal: move the existing platform email senders onto the branded renderer.

Tasks:

1. migrate auth login-link mail to the shared renderer
2. migrate worker billing warning and hard-cap notifications to the shared renderer
3. extend platform safety alerts with branded email delivery where the product contract requires it
4. keep existing operational behavior intact for sender, reply-to, timeout, and failure handling
5. confirm agent-authored email fanout remains out of scope and unchanged

Expected result:

The highest-value platform emails match the new brand without changing unrelated delivery semantics.

### Slice 8 — Public Docs and Customer-Facing Copy Review

Goal: align customer-facing documentation and support content with the new brand.

Tasks:

1. audit public page content under `apps/web/src/features/public-pages/content/**` for customer-facing references to OpenAIdom, links, and contact details
2. update help/company/legal/docs page copy where the customer-facing name or canonical domain changes
3. confirm whether legal pages should use a dual-label format such as `OpenAIdom,`
4. update public nav labels, page titles, and CTA copy where needed to reflect the new product identity
5. review docs for screenshots, examples, and inline URLs that may still point at the old brand or host

Expected result:

The public-facing docs stop undermining the new brand with mixed names and stale links.

### Slice 9 — Internal Documentation and Rollout Support

Goal: leave operators and future contributors with clear implementation and rollout guidance.

Tasks:

1. update or cross-link the domain rollout plan so visual branding rollout and hostname cutover are sequenced correctly
2. document the approved brand asset mapping and runtime source locations
3. update any operator-facing runbooks that mention public URLs, login flows, or email screenshots if branding changes affect them
4. note any intentionally preserved internal `OpenAIdom` names so later cleanup work is explicit rather than accidental

Expected result:

The rollout is understandable as an intentional layered change instead of a partially renamed product.

---

## Rollout Order

Recommended delivery order:

1. asset intake and brand contract
2. shared web brand component
3. app shell and auth/public page branding
4. favicon/metadata wiring
5. token alignment
6. shared email shell and email sender migrations
7. public docs and legal/support copy pass
8. staging verification on `staging.openaidom.com`, followed by first production launch on `openaidom.com` from the domain rollout plan

This order produces visible value early while preserving the ability to defer riskier domain-facing changes until staging is ready.

---

## Validation Plan

### Automated

1. web build and lint pass after asset integration and component changes
2. tests for any new shared brand component logic if it has conditional rendering branches
3. auth mailer tests verify `subject`, `text`, and `html` payloads
4. worker mailer tests verify SES payload mapping for both text and HTML
5. snapshot or string-assertion tests for shared email shell and fallback behavior

### Manual UI Checks

1. authenticated shell renders the correct brand treatment on desktop and mobile
2. login and public pages render the correct logo variant on dark/light or hero surfaces
3. favicon and tab title appear correctly in the browser
4. no broken asset URLs occur in local dev or production builds

### Manual Email Checks

1. send a real login-link email and review rendering in at least one desktop and one mobile client
2. preview billing and safety templates for spacing, hierarchy, CTA clarity, and raw-link fallback
3. verify typographic fallback still looks intentional if remote images are blocked

### Copy and Docs Checks

1. grep customer-facing content for stale `OpenAIdom` references that should now be `OpenAIdom`
2. verify legal and contact pages use the approved dual-label or single-label policy consistently
3. verify public URLs, email CTAs, and support addresses point at the intended canonical domain

---

## Risks

1. a partial rollout could leave the UI, email, and docs speaking in different brand names
2. favicon or manifest wiring may look correct locally but fail in production if asset paths are not served from a stable location
3. email clients may render remote image headers inconsistently, so the typographic fallback must be treated as first-class
4. legal/support copy may require a dual-label transition period even if the UI fully switches to OpenAIdom
5. the separate domain rollout plan introduces timing dependencies for canonical URLs used in email, docs, and metadata

---

## Dependencies

This plan depends on or should be coordinated with:

1. `docs/features/2026/07/12/001-openaidom-domain-rollout/001-plan.md` for hostname cutover and canonical origin changes
2. `docs/features/2026/07/12/003-platform-email-redesign/001-plan.md` for deeper email implementation details already identified
3. `docs/product/brand/brand-palette.md` for authoritative palette values used by web and email branding
4. the accepted web i18n contract in `docs/tech/architecture/adrs/2026/06/002-web-i18n-contract-and-key-strategy.md`

---

## Post-Implementation — Asset Mapping and Runtime Locations

### Runtime Asset Locations

| Asset | Location | Notes |
|-------|----------|-------|
| Brand images (favicon, wordmark, mark, banner) | `apps/web/public/brand/` | Served at runtime from the web app; copied from `docs/product/brand/images/` |
| Brand contract (tokens, asset paths, fallback rules) | `apps/web/src/brand/tokens.ts` | Single source of truth for code references; never reference `docs/product/brand/` directly from app code |
| BrandLogo component | `apps/web/src/brand/BrandLogo.tsx` | Reusable React component; supports mark-only, wordmark-only, mark+wordmark, and typographic fallback; light/dark variants |
| Branded email renderer | `packages/domain/src/email/renderer.ts` | Pure `(params) => { subject, text, html }`; shared by API (auth mail) and worker (billing/safety alerts) |
| CSS tokens | `apps/web/src/styles.css` | `--brand-*` hex tokens → `--color-*` semantic aliases; palette aligned to navy `#101828`, indigo `#635BFF`, white `#FFFFFF`, light gray `#F5F7FA`, dark bg `#0B1220` |

### Surfaces Updated (Slices 1–8)

| Surface | What changed |
|---------|-------------|
| Browser metadata | Favicon, manifest, document title, social/share metadata |
| App shell | Sidebar wordmark, mobile top-bar mark |
| Auth/login page | Branded header with wordmark/banner |
| Public pages | PublicLayout header, nav labels, page titles |
| Theme tokens | `--color-brand-*` family realigned to navy/indigo palette |
| Platform email | Auth login-link mail, billing notifications, safety alerts now use shared branded HTML shell with plain-text fallback |
| Public docs | 13 markdown files (help, docs, company, legal) — customer-facing copy switched to OpenAIdom |

### Surfaces Intentionally Unchanged

| Surface | Reason |
|---------|--------|
| Agent-authored email fanout | Out of scope — agents control their own message content |
| Navigation model / IA | Not a branding concern |
| Core interaction patterns | Not a branding concern |
| i18n keys referencing `herobids` as an internal token | These are internal identifiers, not user-visible strings; changing them would risk key-mismatch regressions with no user-facing benefit |

---

## Intentionally Preserved Internal `OpenAIdom` Names

The following are kept as-is. They are internal engineering identifiers, not customer-facing brand surfaces. Changing them would create migration risk with no user-visible benefit.

| Category | Examples | Rationale |
|----------|----------|-----------|
| Package names | `@herobids/domain`, `@herobids/engine`, `@herobids/db`, etc. | pnpm workspace identity; rename would touch every import in the repo |
| Database names | `herobids_dev`, `herobids_staging`, `herobids_prod` | Schema-qualified; rename requires dump/restore migration |
| Docker image names | `herobids/api`, `herobids/worker`, `herobids/agent` | Image registry identity; rename requires coordinated CI + deploy changes |
| Internal env vars | `HEROBIDS_ENV`, `HEROBIDS_DATABASE_URL`, `HEROBIDS_REDIS_URL` | Used across deploy scripts, compose files, and worker config loading |
| Config keys | `config/default.yaml` heritage; `agentRiskDefaults.*` namespace | Operator-facing config; changing keys breaks existing deploy configs |
| Legal entity name | "OpenAIdom" in legal liability clauses (e.g. Terms of Service) | Names the legal entity, not the brand; disclosed as "OpenAIdom," |
| localStorage key | `herobids_locale` (in `apps/web/src/app/i18n/resolveLocale.ts`) | Changing the key would reset every user's locale preference |
| Repo directory name | `herobids/` | Git remote identity; rename requires full re-clone for every contributor |
| Internal code identifiers | TypeScript types, function names, table names, migration files | Internal-only; no customer ever sees them |
| Infrastructure names | Compose service names (`herobids-api-dev`), Docker networks (`herobids_default`), systemd units (`herobids.service`), infra paths (`/opt/herobids/`), PostgreSQL user (`herobids`) | Deployment-critical; renaming breaks provisioning, compose orchestration, and cron jobs |

**Rule of thumb:** If a string never appears in a browser tab, email subject line, login page, or public doc, it was left alone.

---

## Success Criteria

This feature is successful when:

1. a first-time user sees OpenAIdom in browser chrome, app chrome, login, and public pages
2. platform-authored email clearly belongs to the same product
3. public docs and customer-facing copy no longer feel split between OpenAIdom and OpenAIdom
4. internal engineering names remain stable and do not create avoidable migration risk
5. the staging cutover and first production launch can happen as separate controlled deploy steps rather than being entangled with UI or email refactors