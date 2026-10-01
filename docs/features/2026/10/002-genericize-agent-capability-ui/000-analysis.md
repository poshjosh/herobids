# Analysis — Genericize the agent capability UI (de-trading the agent form & detail)

**Status:** analysis
**Date:** 2026-10-01
**Parent:** Phase 2 Step 8 (legal/product boundary audit) of
`docs/features/2026/09/24/001-staging-first-external-backend-roadmap.md`
**Audit:** `docs/features/2026/10/003-frontend-trading-coupling-audit.md`

## Problem

The agent create/edit/detail UI treats trading as *the* agent domain rather than
as one capability among many. Three operator-reported defects:

1. **Capabilities list is trading-only.** The agent detail page shows a
   capability only when the agent has the `trading` family, so:
   - trading agent → trading shown;
   - trading + email agent → **trading only** (email missing);
   - email agent → **"no capabilities"**.
2. **An agent "type" selector exists** (trading / personal-assistant / custom),
   contradicting "agents are known by their skills."
3. **Advanced settings has Trading + Strategy tabs** instead of a generic
   Capabilities tab.

## Root causes (code-level)

1. `apps/web/src/features/agents/AgentDetailPage.tsx` hardcodes:
   ```ts
   const hasTradingCapability = hasCapabilityFamily(selectedSkills, 'trading');
   const capabilityQuery = useQuery({ queryFn: () => agentsApi.capabilityReadiness(id!, 'trading'), enabled: hasTradingCapability });
   ```
   It never iterates the agent's actual families and never queries non-trading
   readiness. The "no capabilities" empty state is literally "no trading."
2. `apps/web/src/features/agents/agent-display.ts`:
   - `CAPABILITY_FAMILY_LABELS = { trading: 'Trading' }` — no label for any
     other family.
   - `SkillPresetId = 'trading' | 'direct-trading' | 'trading-assistant' |
     'personal-assistant' | 'custom'` — surfaced as a type picker.
3. `apps/web/src/features/agents/AdvancedSettingsSection.tsx` renders tabs
   `[aiConfig, tradingSetup, strategy]`; `AgentFormBody.tsx` `ADVANCED_FIELD_TAB`
   maps validated fields to `0=AI, 1=Trading, 2=Strategy`.

## What already exists (reduces the work)

- `Skill.capabilityFamilies: string[]` is already on the web `Skill` model
  (`lib/api-client.ts`).
- `resolveCapabilityFamilies(skills)` already derives the deduped, sorted family
  list (`agent-display.ts`).
- `agentsApi.capabilityReadiness(id)` **with no family** already returns
  `{ capabilities: CapabilityReadiness[] }` across all families; the per-family
  form returns one. The detail page simply calls the trading-only form.
- `CapabilityReadiness.family: string` and `presentation(id, family)` are already
  family-generic.

So issue 1 is mostly **wiring existing generic primitives**; the trading-only
calls are the anomaly, not a missing capability model.

## Persistence decision (no new agent "type")

Confirmed: there is **no `type` column** on the agents table. Identity is
`skillIds` + `unifiedConfig` (`capabilityMode: 'intelligence'|'hybrid'`,
`technical`/`intelligence`). `skillPresetId` lives in `unifiedConfig.metadata` as
a creation-time preset selector. Decision:

- **Do not** introduce a persisted agent type. Identity is **derived** from the
  agent's skills → `capabilityFamilies`.
- **Keep** `capabilityMode` — it is a runtime wake/execution mechanic (scanner
  loop vs not), domain-neutral.
- **Demote** `skillPresetId`: keep an optional "suggested skills" convenience at
  creation if useful, but it must not be presented as, or relied on as, a type.

## Scope boundary

**In scope (this slice):** the agent create/edit/detail capability *presentation*
and the Advanced-settings tab structure — bucket B of the audit, plus the matching
API-client/route family-generalization (bucket C) and i18n relabels (bucket D)
needed to make B coherent.

**Out of scope:** whole trading features/pages — bots, exposure, instance detail,
portfolios, venue/technical config internals (audit buckets A/E). Those tie into
the larger "move trading to Traderton vs make generic vs remove" Step 8 decision
and need legal/product input. The trading *config editor itself* stays; it is
simply rendered behind the generic Capabilities tab, shown only when the trading
family is present.

## Risks / notes

- The capability sub-resource routes (`/capabilities/trading/connections`,
  `/positions`) are trading-literal on **both** web and API
  (`apps/api/src/routes/agents.ts`). The web change must land in lockstep with a
  family-generic API route, or stay a thin trading alias until the API moves.
  Flag for the plan; do not break the deployed boundary contract.
- i18n: three locales (`en/ar/hi`) carry the trading key copy; keep them in sync
  (there is a drift regression test, `i18n-regressions.test.ts`, incl. one
  assertion about trading-capability next-steps routing).
- Keep changes behavior-preserving for trading agents (no regression): a
  trading-only agent must still see exactly its trading capability + config.
