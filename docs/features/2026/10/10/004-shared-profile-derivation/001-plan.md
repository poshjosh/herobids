# Plan: Shared Trading-Profile Derivation (WP-H)

**Status:** draft
**Created:** 2026-10-10
**Epic:** [002-agent-onboarding-epic/000-roadmap.md](../002-agent-onboarding-epic/000-roadmap.md)
**Source:** [000-analysis.md](./000-analysis.md) (the problem statement)
**Depends on:** nothing (Wave 1, parallel). **Depended on by:** [WP-B](../005-post-creation-trading-provisioning/001-plan.md) (the `set_trading_setup` provisioning path) and the post-cut-over create paths.

## Goal

One shared function owns the derivation of trading-profile fields — `capital`, `riskPosture`, `executionDefaults`, and the 004 scan config (`scanMode` / `creatorStrategy`) — from an agent's **post-mutation** unified config + style. Every write path (create, patch, grant/revoke, go-live clone, blueprint instantiate, and the new WP-B provisioning path) supplies only its post-mutation config and connection set; the shared seam produces the proposed profiles.

## Scope correction (roadmap F7)

The analysis doc frames this as "dedupe the three create/update paths." That framing is now wrong for two reasons:

1. **WP-C deletes two of the three create paths.** After the cut-over, the form and guided chat create *blank* agents and derive **no** trading profile. The `POST /agents` and `chat.ts create_agent` trading branches are removed (WP-C S3/S4).
2. **The real fourth path is the new dynamic one.** After WP-C, the path that matters is: blank agent → `add_skills` (trading) → connection grant → `set_trading_setup` (WP-B). That path does not exist yet, and it must call the same derivation as everything else.

So WP-H is **not** "merge the three legacy paths" (that would harden a shape WP-C then deletes). It is: **extract one shared derivation seam now, and make the new WP-B path its first new consumer.** The legacy paths are migrated to it only insofar as they survive the cut-over (PATCH, grant/revoke, go-live, blueprint instantiate).

## Verified facts (code, 2026-10-10)

1. **Two pieces are already shared.** `deriveProfileScanConfig({ unifiedConfig, style })` (`apps/api/src/agents/profile-scan-config.ts:59`) and `proposeTradingProfiles({ actorId, priorProfiles, priorConnections, proposedConnections, changes, scanConfig })` (`apps/api/src/agents/trading-profile-reconciliation.ts:120`) are already single functions. `overlayTradingProfile(profile, changes)` applies `{ capital, riskPosture, executionDefaults }` (`trading-profile-reconciliation.ts:100`).
2. **What is duplicated is the `changes` computation.** Each site independently assembles `changes = { capital, riskPosture, executionDefaults }` from its own reading of the post-mutation config, then calls `deriveProfileScanConfig` and `proposeTradingProfiles` around it. The scan-config threading (plan E1H–E3H) had to touch every site by hand; a missed site silently sends stale/null scan config.
3. **The call sites (verified):**
   - `apps/api/src/routes/agents.ts` — `POST /agents` `prepareCreateProfilePlan` (~L759, inline profiles) and `PATCH /agents/:id` `preparePatchProfilePlan` (~L1744, two `proposeTradingProfiles` calls).
   - `apps/api/src/routes/agent-interactivity.ts` — `PUT /agents/:id` (~L318, inline profile overlay, not a `proposeTradingProfiles` call).
   - `apps/api/src/routes/chat.ts` — `create_agent` (~L1472).
   - `apps/api/src/routes/connections.ts` — delete fan-out (~L479).
   - `apps/api/src/services/agent-config-service.ts` — grant/revoke (~L104, L189, L246; `changes: {}`).
   - `apps/api/src/services/agent-go-live-service.ts` — clone (~L322).
   - `apps/api/src/routes/blueprints.ts` — instantiate (~L2306).
4. **The `changes` source varies per path.** Create uses the normalized insert config; PATCH uses the merged config after preset re-application; grant/revoke uses `changes: {}` (re-stamp scan config only); go-live reconstructs from a payload; WP-B will use tool params + operator defaults. This is exactly why the derivation must be a function of "post-mutation config + style + explicit overrides," not a single hard-coded shape.

## Design

### H1. One derivation function

Add to `apps/api/src/agents/` a single function, e.g. `deriveTradingProfileFields`:

```ts
interface TradingProfileFieldsInput {
  unifiedConfig: UnifiedAgentConfig | null;
  style: string | null;
  // Explicit overrides win over config-derived values (WP-B tool params,
  // create-time capital, etc.). Omitted → derived from config or null.
  capital?: string | null;
  riskPosture?: RiskPosture | null;
  executionDefaults?: ExecutionDefaults | null;
}

interface TradingProfileFields {
  changes: TradingProfileChanges;   // { capital, riskPosture, executionDefaults }
  scanConfig: ProfileScanConfig;    // { scanMode, creatorStrategy }
}
```

- `scanConfig` is `deriveProfileScanConfig({ unifiedConfig, style })` — unchanged, just wrapped.
- `changes` is assembled from the explicit overrides first, then the config-derived values, then `null`. The exact precedence is documented in one place and unit-tested once.

This is a thin seam, not a new subsystem: it composes the two already-shared functions and centralizes the one thing that is actually duplicated (the `changes` assembly).

### H2. Migrate the surviving paths to it

Each entry point keeps its own `preparePlannerInput` / `commitLocal` (the saga mechanics are already centralized and out of scope), but replaces its inline `changes` + `deriveProfileScanConfig` assembly with one call to `deriveTradingProfileFields`. The entry point still supplies its own post-mutation config and connection set — that part is genuinely path-specific and must stay.

Migration order (cheapest, lowest-risk first, and only the paths that survive the cut-over):

| # | Path | Post-mutation config it supplies |
|---|---|---|
| 1 | `agent-config-service.ts` grant/revoke | stored row (`agent.unifiedConfig`, `agent.style`); `changes: {}` |
| 2 | `connections.ts` delete fan-out | stored row |
| 3 | `agent-go-live-service.ts` clone | reconstructed from payload |
| 4 | `blueprints.ts` instantiate | reconstructed from blueprint |
| 5 | `agents.ts` PATCH | merged config after preset re-application |
| 6 | `agent-interactivity.ts` PUT | merged config |

`POST /agents` and `chat.ts create_agent` are **not** migrated — WP-C deletes their trading branches. They are left as-is until the cut-over removes them.

### H3. WP-B consumes the seam

WP-B's `set_trading_setup` (B3) calls `deriveTradingProfileFields` with `{ unifiedConfig, style, capital, riskPosture, executionDefaults }` where the overrides come from the tool params + operator defaults. This is the first *new* consumer and the proof that the seam is shaped correctly for the dynamic path.

## Work items

| # | Item | Gate |
|---|---|---|
| H1 | `deriveTradingProfileFields` + unit tests (precedence: override > config > null; scan config passthrough) | unit tests |
| H2 | Migrate grant/revoke, delete fan-out, go-live, blueprint, PATCH, PUT to the seam | existing per-path tests still pass; `pnpm lint` |
| H3 | WP-B B3 calls the seam (done in WP-B, listed here for ordering) | WP-B gate |
| H4 | Record the seam in the analysis doc as "resolved" and note the two create paths are intentionally not migrated (WP-C deletes them) | doc |

## Non-goals

- The reconciliation saga's write/outbox mechanics, the traderton-side profile store, and the runtime wake/relay path (already centralized).
- Migrating `POST /agents` and `chat.ts create_agent` (deleted by WP-C).
- Changing any profile field's *value* — this is a pure refactor; behaviour must be byte-identical.

## Risks

1. **Behaviour drift during migration.** Mitigation: pure refactor, no value changes; each path's existing tests are the gate; run `pnpm lint` and the API test suite after each migration step.
2. **Precedence ambiguity.** The `changes` precedence (override > config > null) must be pinned in one place and tested once, or the seam reintroduces the very divergence it removes.
3. **Over-abstracting.** The seam is deliberately thin (composes two existing functions). If a path needs genuinely different semantics (e.g. go-live's live-mode reconstruction), it keeps that logic and only shares the `changes`/`scanConfig` assembly — not the whole profile build.