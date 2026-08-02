- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-08-02
- **Summary:** 34 TypeScript build errors in `apps/api/src/` caused by agent table column refactoring — `executionMode`, `dailyLossLimit`, and `maxDrawdownPct` columns moved to JSONB columns (`executionDefaults`, `risk`). Also blueprints table columns (`configData`, `userId`, `visibility`) removed and `EffectiveRiskProfile`/`EffectiveRiskField` types not exported from domain.

- **Root Cause:** A recent refactoring moved agent columns to JSONB but didn't update all API route handlers and services. Specifically:
  1. `agent.executionMode` → moved to `agent.executionDefaults.mode` JSONB
  2. `agent.dailyLossLimit` → removed (now in `agent.risk.dailyMaxLossPct` JSONB)
  3. `blueprints.configData` → removed (data now in `blueprintRevisions.payload`)
  4. `blueprints.userId` → renamed to `blueprints.authorId`
  5. `blueprints.visibility` → renamed to `blueprints.publicationStatus`
  6. `EffectiveRiskProfile` / `EffectiveRiskField` types not exported from `@herobids/domain` (only Zod schemas exported)
  7. `executionDefaults.slippageBps?: number` not assignable to `slippageBps: number`
  8. Various unused imports/variables

- **Fix:** Applied minimal targeted fixes across 10 files:

  | File | Change |
  |------|--------|
  | `apps/api/src/index.ts` | Removed 5th arg (`appConfig.plans`) from `blueprintRoutes()` call |
  | `apps/api/src/routes/blueprints.ts` | Removed unused `PlansConfig` import and `plansConfig` parameter; fixed `executionDefaults.slippageBps ?? 0` default in two `capabilityInput` blocks; replaced `EffectiveRiskField` import with inline type |
  | `apps/api/src/routes/agent-interactivity.ts` | Cast `mode` string to `'paper' \| 'shadow' \| 'live'` |
  | `apps/api/src/routes/agents.ts` | Removed unused `effectiveMaxOpenPositions` and `effectiveStopLossCooldownMs` variables |
  | `apps/api/src/routes/bots.ts` | Removed unused `blueprintRevisionSkills` import; fixed blueprint lookup to join `blueprintRevisions` and use `authorId`/`publicationStatus` columns; fixed `projectBotToBlueprintPayload` call to extract `name` from `bot.config` |
  | `apps/api/src/routes/capabilities/trading.ts` | Replaced `agent.executionMode` with `agent.executionDefaults.mode` JSONB access |
  | `apps/api/src/routes/exports.ts` | Removed `?? agent.executionMode` fallback (now `?? null`) |
  | `apps/api/src/routes/telegram-command-handlers.ts` | Replaced `agent.executionMode` → `agent.executionDefaults.mode` JSONB; removed `agent.dailyLossLimit` fallback |
  | `apps/api/src/services/agent-config-service.ts` | Changed `executionMode: internalMode` → `executionDefaults: { ...existing, mode: internalMode }` with select+merge pattern |
  | `apps/api/src/services/blueprint-risk-resolver.ts` | Imported `EffectiveRiskProfileSchema`/`EffectiveRiskFieldSchema` Zod schemas and derived types with `z.infer<>` instead of non-existent type exports |
  | `apps/api/src/services/blueprint-scoring.ts` | Removed unused `and`, `gte`, `blueprintLikes`, `blueprintUsageEvents` imports; prefixed unused `authorId` param with `_` |

- **Files Changed:** 11 files (see table above)

- **Verification:** `pnpm --filter @herobids/api run build` passes with 0 errors. `pnpm lint` passes clean.
