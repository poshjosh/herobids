# Bug Report: Swap-venue agent bots unusable — `execute-trade` / `manage_bot` ceiling clamped to `paper`

- **Status:** FIXED (2026-09-19). Root cause: the traderton boundary resolved an **agent** subject's execution mode via a static, operator-wide default (`execution.defaultOwnerMode`, defaulting to `paper`) instead of the agent's own configured mode. Swap venues (jupiter/1inch) reject paper synchronously (`execution_capability.paper_swap_not_supported`), so a shadow/live agent on a paper-default operator could never submit decisions or create bots on a swap venue — every call failed closed at the boundary. Fix (Option A — signed, injected per-agent mode): herobids now stamps the agent's real `agents.execution_defaults.mode` into the HMAC-signed payload (post-LLM), and traderton resolves the agent ceiling from that injected value (falling back to the operator default when absent).
- **Severity:** High (complete loss of swap-venue agent trading unless the operator bumped the global default — which would have mis-capped every other agent).
- **Date:** 2026-09-19
- **Discovered by:** A8 stabilization-certification gate, item 6 (full parity cycle) — swap bots could not be created/executed; traced to the boundary's static owner-mode fallback.
- **Environment:** development, local docker compose cross-stack (herobids api `localhost:3000`; traderton boundary `localhost:8080`), jupiter/1inch.

## Root cause — CONFIRMED

1. `executionMode` is a **construct-time** actor state (`paper` | `shadow` | `live`; `MODE_RANK = {paper:0, shadow:1, live:2}`). The boundary's agent-direct actor is built once per `(ownerId, actorId, venueAccountId)` with a single `ownerMode`.
2. `resolveSubjectInjection` → `resolveNoBotOwnerMode` resolved an **agent** subject to `ports.getDefaultOwnerMode?.(ownerId) ?? 'paper'` — i.e. a static, operator **global** knob, **not** the agent's per-agent mode. The boundary process cannot read herobids' `agents` table (locked: no `agents`-table dependency — 017 §4 / 019 §1), so it had no per-agent source and silently defaulted.
3. The mode-escalation guards (`checkModeEscalation`) then clamped every agent ceiling to that global default. On a paper-default operator, a `shadow`/`live` agent on a swap venue was rejected:
   - `submit_decision` → executor mode `paper` + venueType `swap` → `paper_swap_not_supported`.
   - `manage_bot` (`create_bot` / `adjust_bot_config`) → `requestedMode` (`shadow`/`live`) > ceiling (`paper`) → mode-rank rejection.

## Fix (Option A — signed injected per-agent mode)

The consumer already owns the `agents` row and already injects platform-owned risk context **post-LLM** inside the HMAC-signed payload (A3 RiskSource seam). `executionMode` is precisely such a value (LLM never sees/supplies it), so it rides the same seam instead of the boundary guessing.

**herobids (consumer) — stamp `agent.executionDefaults.mode`:**
- `decision-boundary-mapping.ts`: `executionMode` added to `SubmitDecisionBoundaryPayload`, `AgentRiskInjection`, `RiskSpecPayloadFields`, `buildSubmitDecisionPayload`, `buildRiskSpecPayloadFields`.
- `agent-decision-handler.ts` + `agent.ts` (`agentRiskSpecResolver`) + `index.ts` (`agentRiskResolver`) + `services/approval-service.ts`: thread `agent.executionDefaults?.mode`.
- `agent-message-broker.ts`: `executionMode` added to the `create_bot` and `adjust_bot_config` boundary payloads.

**traderton (boundary) — trust the injected mode, fall back to the operator default:**
- `subject-resolver.ts`: new `injectedModeOf(payload)`; `resolveNoBotOwnerMode` agent branch returns `injectedModeOf(payload) ?? getDefaultOwnerMode?.(ownerId) ?? 'paper'`.
- `agent-direct-actor-ensure.ts`: `ownerMode` added to the ensure cache entry; `modeChanged` joined to the fast-path change detection so a mode flip forces actor reconstruction (executionMode is construct-time — see caveat).
- Tool schemas declare `executionMode` so the dispatcher's `payloadParse` does not strip it (bug-001 lesson): `tools/trading.ts` (submit_decision), `tools/risk-limits.ts` (`AgentRiskSpecFieldsSchema` → get_risk_limits/get_account_summary), `tools/bots.ts` (create_bot, adjust_bot_config). Each is `.omit`ted from the LLM-visible JSON schema (never an LLM input).

## Caveat (flagged to user)

`executionMode` is **construct-time** agent state — it selects the Paper/Shadow/Live executor. The ensure-cache fast path keys on spec equality; without a change-detection entry for the mode, a live→shadow flip of the *same* agent+venue account would reuse a stale-mode actor. The ensure cache now treats `modeChanged` as a reconstruction trigger (new `ownerMode` field in `CacheEntry`). Sufficient for herobids' flow — where the mode is stable per agent run and only changes via an operator config swap — but a consumer that mutates mode mid-flight pays a full actor rebuild.

## References

- `traderton/packages/boundary/src/subject-resolver.ts` (`resolveNoBotOwnerMode`, `injectedModeOf`)
- `traderton/packages/boundary/src/agent-direct-actor-ensure.ts` (`CacheEntry.ownerMode`, `modeChanged`)
- `traderton/packages/worker/src/tools/{trading,risk-limits,bots}.ts` (schema declarations + LLM omit)
- `herobids/apps/worker/src/agents/decision-boundary-mapping.ts` (payload stamping)
- `herobids/apps/worker/src/agents/agent-message-broker.ts` (create_bot / adjust_bot_config injection)
- `herobids/apps/worker/src/services/approval-service.ts` + `index.ts` (approval path injection)
- A8 plan item 6 (parity full-cycle) — the failure this fixes.