# Phase 2 Completion Note — Product/Legal Boundary (Steps 6–8)

**Date:** 2026-10-01. **Program:** `004-phase2-program/`.
**Outcome:** Phase 2 engineering is **complete**, modulo one batched legal
decision and one infra hard stop awaiting operator approval.

## What Phase 2 set out to do

Make **herobids present as a generic agent host** and **Traderton own the
trading product** — a legal/payment-provider requirement. Three roadmap steps:
move trading docs to Traderton (6), stand up a minimal Traderton site (7), and
audit + remediate every herobids trading product surface (8).

## What was delivered

- **Step 8 remediation — frontend (T1.1):** the agent capability UI is now
  generic — capabilities derive from skills (one readiness card per family), a
  generic **Capabilities** tab replaced the Trading/Strategy tabs, the agent
  "type" selector is gone, and i18n was relabelled across en/ar/hi. The backend
  readiness endpoint now emits one entry per declared family (P2-10).
- **Step 8 audit — backend (T2.1):** `005-backend-trading-coupling-audit.md`
  classified every backend product/identity surface (13 GENERIC, 3 MOVE, 0
  REMOVE-SAFE, 3 ESCALATE-LEGAL).
- **Step 8 remediation — backend (T2.2):** the safe-standalone GENERIC items —
  `GET /capabilities` now derives families from `SYSTEM_SKILLS`; four 503
  messages are capability-neutral; the default guided-setup goal is
  capability-neutral. Contract/lockstep items deferred (P2-7/P2-12).
- **Step 6 — move trading docs (T3.1/T3.2):** the venue guides, wallet-funding
  guide, and crypto-ecosystem reference are now canonical in the traderton repo
  (`docs/reference/*`); herobids' glossary was split to keep only generic
  platform terms. The web registry/sitemap, two dangling in-app links, an
  orphaned i18n key, and the agent-facing docs-search index were all updated so
  no moved trading content remains reachable from herobids.
- **Step 7 — minimal Traderton site (T4.1):** a static, human-facing site under
  `traderton/site/` (product identity, docs/venue guides, service status). It
  serves locally and the execution-boundary isolation guard (`/internal*` and
  `/health*` → 404; the public vhost never proxies the boundary) is
  regression-tested. **Publishing (T4.2) is an infra hard stop** — the DNS/TLS/
  deploy + staging-compose wiring is documented in the traderton repo
  (`.../002-publish-prep.md`), not executed.
- **Step 8 reconciliation (T5.1):** `RECONCILIATION.md` confirms every surface
  from both audits is done, deferred-with-note, escalated, or KEEP — none
  unclassified.

## The legal/product-boundary batch — RESOLVED by the operator (2026-10-01)

The `ESCALATIONS.md` batch is resolved (see DECISIONS P2-17/18/19):
- **E1 → retired** the onboarding "AI crypto trader" greeting button; onboarding
  is capability-neutral and trading is discovered via skills. (This turned out to
  be governed by the already-settled "no agent type; identity from skills" decision
  P2-2 — not a new legal call.)
- **E2 → leave as-is.** Billing *for* trading (an external action) is acceptable;
  the `assessment.request` meter stays. Optional future: categorize
  externally-caused bills.
- **E3 → keep positioning as-is for now;** produced the frontend trading-text
  inventory (`007-frontend-trading-text-inventory.md`). Applying it is a later task.
- **N1** (herobids→Traderton outbound link) stays deferred with E3.

## What still waits on the operator

1. **T4.2 publish** (infra hard stop): approve DNS/TLS/VM-deploy + wiring `site`
   into the staging compose/deploy flow (checklist in the publish-prep doc).

## Deliberately deferred (not gaps)

Lockstep contract items (route generalization, `skillPresetId`/`strategyPreset`/
`SKILL_PRESET_MAP` demotion, guided-setup reshape — P2-7/P2-12) and the
Phase-3-owned trading-feature/schema moves (blueprint facet schema,
`GET /blueprints/defaults` default). Each is recorded in `RECONCILIATION.md`.

**Update 2026-10-02:** the admin-only Preview UIs that were listed here as
deferred (bots/instances/exposure/outcomes/activity pages) were subsequently
**deleted** rather than deferred, once the operator greenlit it. See
`RECONCILIATION.md` Buckets A/E and `008-orphan-i18n-key-sweep.md`.

## Verification

All work committed locally (no push), in both repos. Across the program:
`pnpm lint`, herobids web + api + worker builds, and traderton lint + build all
green; 681 web tests, 94 chat tests, 17 platform-docs tests, 5/5 capability
functional tests, sitemap/public-pages tests, and the site isolation test all
pass. UI changes were visually verified locally.

## Outstanding (non-blocking)

Low-severity items are tracked under "Outstanding Issues" in the Phase 2
`TASKS.md` (orphaned i18n keys, residual trading-worded 503s elsewhere, the
"Tick" glossary duplication, the site favicon 404, raw-markdown doc links).
