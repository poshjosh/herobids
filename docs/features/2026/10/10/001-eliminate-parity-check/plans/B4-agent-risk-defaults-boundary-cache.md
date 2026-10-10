# B4 — Remove herobids's `agentRiskDefaults` YAML block (boundary cache)

Audit of every herobids consumer of the `agentRiskDefaults` operator-config block,
with a classification (boundary-read-able vs. herobids-local) and the implementation
rows. Written 2026-10-10 (B4.1).

## The block

`config/default.yaml` → `agentRiskDefaults:` (17 fields). The manifest entry
`agent-risk-defaults` is `authority: traderton` with `topLevelKey: agentRiskDefaults`,
so the two repos' YAML blocks must stay byte-identical until herobids stops reading its
own copy. Traderton already exposes the block over the boundary via
`get_operator_defaults` (owner-scoped, no venue), and herobids already has a cached
reader: `apps/api/src/traderton-operator-defaults.ts` → `loadOperatorRiskDefaults`.

## Consumers (audited 2026-10-10)

| # | Consumer | Reads fields? | Classification |
|---|---|---|---|
| 1 | `apps/worker/src/index.ts:589-590` | `agentDecisionNoContextThreshold`, `agentDecisionSwapInstrumentFormatThreshold` | **herobids-local** (worker-side decision-handler hardening thresholds; read at worker startup, no boundary) |
| 2 | `apps/api/src/services/blueprint-risk-resolver.ts` `resolveEffectiveRisk` (via `routes/blueprints.ts:1848,2239`) | `maxOpenPositions`, `maxPositionSizePct`, `stopLossPct`, `stopLossCooldownMs`, `maxDrawdownPct`, `dailyMaxLossPct`, `maxNewPositionsPerDay`, `avoidParabolicMovePct`, `maxOrderNotional` | **boundary-read-able** (operator defaults for blueprint instantiation) |
| 3 | `apps/api/src/routes/agents.ts:501` `/agents/risk-defaults` | 7 web-facing fields | **boundary-read-able** (already reads boundary first, local as fallback) |
| 4 | `apps/api/src/routes/chat.ts` (pass-through) | forwards to `agent-create-normalization` + `executeChatAction` | **pass-through** (no direct read) |
| 5 | `apps/api/src/agents/agent-create-normalization.ts:55` | none (`agentRiskDefaults.` never read) | **dead param** |
| 6 | `apps/api/src/routes/agent-interactivity.ts:126,132` | none (`void agentRiskDefaults`) | **dead param** |
| 7 | `apps/api/src/services/agent-go-live-service.ts:45,66,75` | none (`void agentRiskDefaults`) | **dead param** |
| 8 | `apps/api/src/routes/telegram-command-handlers.ts:1100,1114,1144` | none (forwards to `cloneAgentAsLive`, which voids it) | **dead param** |
| 9 | `apps/worker/src/agent.ts:294` | none (interface field, never read) | **dead field** |

## Classification summary

- **Boundary-read-able (traderton-owned):** consumers 2 and 3 — the operator-default
  ceilings used for blueprint instantiation and the risk-defaults display endpoint.
  These should read `loadOperatorRiskDefaults` (already cached) instead of the local
  YAML block.
- **Herobids-local:** consumer 1 — the two worker decision-handler hardening thresholds
  (`agentDecisionNoContextThreshold`, `agentDecisionSwapInstrumentFormatThreshold`).
  These are worker operational knobs, not traderton risk defaults. They must move to a
  herobids-local config key so the `agentRiskDefaults` block can be removed.
- **Dead params/fields:** consumers 4-9 — remove the parameter/field (and the
  pass-through plumbing) once the real readers are re-pointed.

## The worker's two fields (the crux)

`agentDecisionNoContextThreshold` and `agentDecisionSwapInstrumentFormatThreshold` are
read by the worker's `AgentDecisionHandler` at startup. They are **not** traderton risk
defaults — they tune how the herobids worker hardens retryable→false after consecutive
`no_context` / `swap.instrument_format` failures. They happen to live in the same YAML
block today.

Two options:
1. **Move them to a herobids-local config key** (e.g. `agentDecisionHandler:` top-level
   block in `config/default.yaml`), keeping the worker reading local config. This is the
   cleanest: the `agentRiskDefaults` block then has zero herobids readers and can be
   removed.
2. **Read them from the boundary too** — but the worker has no per-startup boundary read
   for these, and they are not traderton-owned semantics, so this is wrong.

**Decision (lightweight): option 1.** Move the two fields to a new herobids-local
`agentDecisionHandler` config block.

## Implementation rows (appended)

### B4.2. Move the two worker thresholds to a herobids-local config block
- **Done-state:** `config/default.yaml` gains a top-level `agentDecisionHandler:` block
  with `noContextThreshold` and `swapInstrumentFormatThreshold`; the two fields are
  removed from `agentRiskDefaults`; `apps/worker/src/index.ts:589-590` reads the new
  block; `AgentRiskDefaultsSchema` drops the two fields (and traderton's schema drops
  them too — they are not traderton risk defaults); the `agent-risk-defaults` manifest
  entry is narrowed to the remaining shared fields (or the two fields are reclassified
  as herobids-local and the entry's region narrowed). `.env*.example` unchanged (YAML,
  not env).
- **Prerequisites:** none. **Gates:** floor, GP-H.

### B4.3. Re-point the API readers to the boundary cache
- **Done-state:** `blueprint-risk-resolver.ts` `resolveEffectiveRisk` takes the
  operator defaults from `loadOperatorRiskDefaults` (already cached) instead of the
  local `agentRiskDefaults` param; `routes/blueprints.ts` and `routes/agents.ts`
  `/agents/risk-defaults` source from the boundary; the dead params (consumers 4-9) are
  removed from the signatures and call sites.
- **Prerequisites:** B4.2. **Gates:** floor, GP-H.

### B4.4. Remove the herobids `agentRiskDefaults` YAML block and drop the entry
- **Done-state:** `config/default.yaml` `agentRiskDefaults:` block deleted; the
  `agent-risk-defaults` manifest entry removed (and its id from `REQUIRED_ENTRY_IDS` /
  `REQUIRED_ENTRY_AUTHORITIES`); the checker test retargeted (I2: it names
  `agent-risk-defaults` as a `traderton`-authority id — retarget to
  `domain-agent-risk-contract`, the other `traderton`-authority id, which survives until
  C3.6); `AgentRiskDefaultsSchema` removed from herobids's `config/schema.ts` (or kept
  as a type-only import if still referenced); CHANGELOG.
- **Prerequisites:** B4.3. **Gates:** floor, GP-H.

## `.env*.example` changes (I9)

None — `agentRiskDefaults` is YAML config, not an env var. No `.env*` twin changes.