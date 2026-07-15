# BRAND ROLLOUT FOLLOWUP TASK LIST

## [DONE] Tier 1 — Do Now (quick, low-risk, high-value)

These are all ~5-minute fixes — doc updates, one-liners, typos:

| # | Slice | Issue | Effort |
|---|-------|-------|--------|
| 1 | S1-M#1 | README dangling "(see below)" — add explanation paragraph | 2 min |
| 2 | S1-M#2 | Source webmanifest files stale — copy runtime fixes back to images | 2 min |
| 3 | S2-LOW | Redundant ternary in BrandLogo — clean up `auto → lightAsset` fallthrough | 1 min |
| 4 | S4-LOW#1 | Unused `favicon-light/favicon.ico` — remove the dead file | 30 sec |
| 5 | S4-LOW#3 | Missing `og:url` + `og:site_name` in index.html | 2 min |
| 6 | S4-LOW#4 | Webmanifest files lack trailing newline | 30 sec |
| 7 | S6-M#1 | `safeUrl` no-op needs `// TODO` with issue ref | 30 sec |
| 8 | S6-LOW#1 | `htmlEscape` doesn't escape single-quote `'` — add `&#39;` | 30 sec |
| 9 | S7-LOW#1 | `eventSubject(event)` called twice — extract to variable | 1 min |
| 10 | S7-LOW#2 | `slice(0,500)` mid-word truncation — find last space before 500 | 2 min |
| 11 | S8-MEDIUM | `contact-us.md` missing operator disclosure — add "operated by OpenAIdom" line | 1 min |
| 12 | S8-LOW#1-3 | `about-us.md` typos: `e.t.c`→`etc.`, `assistantance`→`assistance`, numbered list fix | 2 min |
| 13 | S9-MEDIUM | Infrastructure names missing from preserved-names catalog | 3 min |
| 14 | S9-LOW#1-2 | Cross-reference "9 slices" phrasing + CHANGELOG pointer | 2 min |

**Total: ~15 items, ~25 minutes of work.**

---

## [PENDING] Tier 2 — Should Do (more effort but important)

| # | Slice | Issue | Effort | Why now |
|---|-------|-------|--------|---------|
| 15 | S2-MEDIUM | No `BrandLogo.test.tsx` | 30-60 min | Component has 27+ states; no tests means future refactors are blind |
| 16 | S4-M#1 | Safari favicon gap — create SVG favicon with embedded `@media` | 30 min (need SVG asset) | ~55% of mobile users are on Safari; dark favicon on light chrome looks broken |
| 17 | S5-MEDIUM | `--color-brand-subtle` still raw oklch — add hex token + alias | 2 min | Quick fix, eliminates last oklch→sRGB drift |
| 18 | S6-M#3 | Missing Unicode/emoji tests in email renderer | 15 min | Important for i18n; Japanese/Arabic/emoji subject lines |
| 19 | S6-M#2 | `body` trust boundary — add branded `SafeHtml` type | 15 min | Compile-time guard against XSS in email; aligns with AGENTS.md branded types convention |
| 20 | S7-M#1 | SES html field test coverage | 10 min | Regression risk — html could silently stop sending |
| 21 | S7-M#2 | HTML tags leak into plain-text email fallback | 20 min (needs design decision) | Billing emails show literal `<strong>` in plain-text clients. Options: separate `textBody` field, or strip tags in `renderText()` |

**Total: ~7 items, ~2-3 hours of work.**

---

## [PENDING] Tier 3 — Defer (blocked, cosmetic, or out of scope)

| # | Slice | Issue | Reason to defer |
|---|-------|-------|-----------------|
| 22 | S1-LOW#2 | Typographic fallback rules still implicit in tokens.ts | BrandLogo already implements fallback; adding comment is Tier 1 but the system works |
| 23 | S3-LOW | `variant="auto"` vs app-level theme toggle | Design decision — need to know if a theme toggle exists |
| 24 | S3-LOW | Pre-existing `LoginPage.tsx` type error | Unrelated to brand; file a separate bug |
| 25 | S4-M#2 | OG image aspect ratio (3.44:1) | Needs a designer to create 1200×630 social image |
| 26 | S4-LOW#2 | OG/Twitter root-relative URLs | Needs production URL (`openaidom.com`) confirmed and deployed |
| 27 | S5-LOW | `--color-brand-dim` unused | Defer until a component actually needs hover/pressed indigo |
| 28 | S6-LOW#2-4 | Preheader padding, text underlines, const arrow | Cosmetic only — no user impact |
| 29 | S7-M#3 | `PlatformAlertService` zero test coverage | Large effort (~1-2 hours), safety-critical but needs dedicated slice |
| 30 | S8-LOW#4 | `privacy-policy.md` phrasing | Stylistic preference, no user impact |
| 31 | S9-LOW#3 | Post-implementation section placement | Structural doc convention, no impact |