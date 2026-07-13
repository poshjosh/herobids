# Plan: OpenAIdom Brand Rollout Followup — Tier 2

**Status:** Ready for implementation  
**Created:** 2026-07-13  
**Parent:** `docs/features/2026/07/12/002-openaidom-brand-rollout/001-plan.md`  
**Task List:** `000-task-list.md` (Tier 2 items #15–#21)

---

## Summary

Tier 2 addresses seven medium-effort gaps from the brand rollout review: missing
component tests, a Safari favicon dark-mode gap, the last raw-oklch token, email
renderer hardening (Unicode coverage, XSS type-safety, plain-text fidelity),
and SES send-command test coverage for the `Html` field.

All items are independent and can be implemented in any order.

---

## Decisions Resolved Before Implementation

### #16 — Safari Favicon: SVG with `@media` (not dual `<link>` PNGs)

**Chosen approach**: Replace `apps/web/public/favicon.svg` with a true vector
SVG (from `docs/product/brand/images/openaidom-icon.svg`) that embeds
`@media (prefers-color-scheme: dark)` to swap fill colors.

**Rationale**: A single SVG is simpler to maintain than two PNG variants + dual
`<link>` tags. The asset already exists (`openaidom-icon.svg`).

**What changes**:
- Take `openaidom-icon.svg`, add a `<style>` block with `@media` rules that
  set `fill` to white (or `#635BFF` accent) on dark backgrounds and navy
  (`#101828`) on light backgrounds.
- Replace `apps/web/public/favicon.svg` with the styled version.
- Update `apps/web/public/brand/README.md` to document the new SVG source.

### #21 — HTML Tags Leak into Plain-Text: Add `textBody` Field

**Chosen approach**: Add an optional `textBody?: string` field to
`EmailContent`. When provided, `renderText()` uses it directly. When absent,
`renderText()` strips HTML tags from `body` as a best-effort fallback
(with a comment noting the fallback is lossy and callers should provide
`textBody`).

**Why not tag-stripping alone**:
- Lossy: `<strong>urgent</strong>` → `urgent` (emphasis lost),
  `<a href="...">click</a>` → `click` (link lost).
- Violates SRP: the renderer shouldn't parse HTML.
- Industry standard: SendGrid, Mailgun, Postmark all use separate html/text fields.
- Aligns with #19: once `body` is typed `SafeHtml` (HTML-only), the type system
  naturally demands a separate plain-text field.

**Migration**: Auth mailer (#15 in original plan's auth-mailer.ts) and
PlatformAlertService already construct body strings. They should also provide
`textBody` for plain-text clients. This is done as part of this slice.

---

## Implementation Checklist

### #15 — BrandLogo.test.tsx

**File**: `apps/web/src/brand/BrandLogo.test.tsx` (new)  
**Effort**: ~45 min

Test categories:
1. **Rendering by display prop** — `mark` renders only BrandMark, `wordmark`
   renders only BrandWordmark, `full` renders both.
2. **Variant → CSS filter** — `dark`/`auto` get `brightness(0) invert(1)`,
   `light` gets `brightness(0)`.
3. **Size presets** — sm/md/lg produce correct pixel dimensions.
4. **linkTo prop** — wraps logo in `<a>` with correct href and aria-label.
5. **className passthrough** — passed className appears on wrapper.
6. **Image load error fallback** — when `<img>` fires `onError`, the
   typographic "OD" mark replaces it.
7. **Typographic fallback styling** — correct font-family, weight, letter-spacing.

### #16 — Safari Favicon: SVG with Embedded `@media`

**Files**:
- `apps/web/public/favicon.svg` (replace)
- `apps/web/public/brand/README.md` (update)

**Effort**: ~25 min

Steps:
1. Open `docs/product/brand/images/openaidom-icon.svg`.
2. Add a `<style>` block with:
   ```css
   @media (prefers-color-scheme: dark) {
     path { fill: #FFFFFF; }
   }
   @media (prefers-color-scheme: light) {
     path { fill: #101828; }
   }
   ```
   (Adjust selector to match the actual SVG structure.)
3. Copy the styled SVG to `apps/web/public/favicon.svg`.
4. Update `apps/web/public/brand/README.md`:
   - Note that `favicon.svg` is now a true vector SVG (not a PNG wrapper).
   - Document the `@media` dark/light behavior.

### #17 — `--color-brand-subtle`: Add Hex Token + Alias

**File**: `apps/web/src/styles.css`  
**Effort**: ~2 min

Replace:
```css
--color-brand-subtle: oklch(25.7% 0.086 281);
```
With:
```css
--brand-subtle: #1E1B4B;
--color-brand-subtle: var(--brand-subtle);
```
This eliminates the last raw oklch token and prevents sRGB rounding drift,
matching how `--color-brand` and `--color-brand-dim` are already handled.

### #18 — Unicode/Emoji Tests in Email Renderer

**File**: `packages/domain/src/email/renderer.test.ts`  
**Effort**: ~15 min

Add test cases:
1. **Japanese subject** — `"件名：アカウント確認"` survives round-trip.
2. **Arabic/RTL subject** — `"تأكيد الحساب"` in subject and `<title>`.
3. **Emoji in subject** — `"🚀 Welcome to OpenAIdom"` renders correctly.
4. **Emoji in body** — `"<p>Portfolio up 12% 📈</p>"` in both HTML and text.
5. **Combined** — Japanese + emoji + special chars in one subject.

### #19 — `SafeHtml` Branded Type for `EmailContent.body`

**Files**:
- `packages/domain/src/values/safe-html.ts` (new)
- `packages/domain/src/email/renderer.ts` (edit)
- `packages/domain/src/index.ts` (edit — re-export)
- `apps/api/src/auth-mailer.ts` (edit — wrap body strings)
- `apps/worker/src/alerting/platform-alert-service.ts` (edit — wrap body strings)

**Effort**: ~20 min

Steps:
1. Create `packages/domain/src/values/safe-html.ts` following the branded-type
   pattern from `ids.ts`:
   ```ts
   declare const __brand: unique symbol;
   type Brand<T, B extends string> = T & { readonly [__brand]: B };
   export type SafeHtml = Brand<string, 'SafeHtml'>;
   export function asSafeHtml(s: string): SafeHtml { return s as SafeHtml; }
   ```
2. Change `EmailContent.body` from `string` to `SafeHtml`.
3. Update callers to wrap string literals with `asSafeHtml()`.
4. Re-export from `packages/domain/src/index.ts`.

### #20 — SES `Html` Field Test Coverage

**File**: `apps/worker/src/alerting/ses-email-client.test.ts`  
**Effort**: ~10 min

Add two test cases:
1. **`Html` included when `message.html` is provided** — verifies
   `Content.Simple.Body.Html.Data` is present in the `SendEmailCommand` params.
2. **`Html` omitted when `message.html` is absent** — verifies the `Html` key
   is not in the command params (covers the `...(message.html ? ... : {})`
   spread logic).

### #21 — HTML Tags Leak into Plain-Text Fallback

**Files**:
- `packages/domain/src/email/renderer.ts` (edit)
- `packages/domain/src/email/renderer.test.ts` (edit)
- `apps/api/src/auth-mailer.ts` (edit — add `textBody`)
- `apps/worker/src/alerting/platform-alert-service.ts` (edit — add `textBody`)

**Effort**: ~25 min

Steps:
1. Add `textBody?: string` to `EmailContent` interface.
2. In `renderText()`:
   - If `textBody` is provided, use it directly.
   - Otherwise, strip HTML tags from `body` using a simple regex
     (`/<[^>]*>/g`) and decode common entities (`&amp;`, `&lt;`, `&gt;`,
     `&quot;`, `&#39;`). Add a comment that this fallback is lossy.
3. Update `auth-mailer.ts` — provide a `textBody` for the login-link email
   (plain text with explicit URL, not just the CTA button label).
4. Update `platform-alert-service.ts` — provide `textBody` when constructing
   safety-alert emails (the `message` + `detail` fields are already plain text
   and serve well).
5. Add tests:
   - `textBody` is used when provided.
   - HTML tags are stripped when `textBody` is absent.
   - Common entities are decoded in the fallback path.

---

## Execution Order

All items are independent. Recommended order (fastest-first for momentum):

| Order | # | Item | Est. |
|-------|---|------|------|
| 1 | #17 | `--color-brand-subtle` hex token | 2 min |
| 2 | #20 | SES html field tests | 10 min |
| 3 | #18 | Unicode/emoji email tests | 15 min |
| 4 | #19 | `SafeHtml` branded type | 20 min |
| 5 | #21 | `textBody` field + plain-text fix | 25 min |
| 6 | #16 | Safari favicon SVG | 25 min |
| 7 | #15 | `BrandLogo.test.tsx` | 45 min |

**Total: ~2.5 hours**

---

## Validation

```bash
pnpm lint                     # type-check all packages
pnpm --filter @herobids/domain test   # email renderer tests
pnpm --filter @herobids/worker test   # ses-email-client + platform-alert tests
pnpm --filter @herobids/web test      # BrandLogo tests (if web has vitest)
```
