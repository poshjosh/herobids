# Bug Report: Agent trading tools report context unavailable; every `submit_decision` rejected at the boundary with `precondition.not_ready`

- **Status:** FIXED (2026-09-17. Root cause confirmed: the traderton `submit_decision` Zod schema did not declare `venueAccountId`, so the boundary dispatcher's payload validation **stripped** the consumer-supplied hint before the subject resolver ran — see "Root cause — CONFIRMED". Fixed in traderton (`packages/worker/src/tools/trading.ts` + dispatcher internal logging). The herobids side was already correct; it required no change. Companion report: `traderton/docs/bug-reports/2026/09/17/001-submit-decision-schema-strips-venue-account-id.md`.)
- **Severity:** High (agents cannot trade: no decision reaches the executor, so no fills/positions/journal are ever produced — in `shadow` mode this should still produce simulated fills).
- **Date:** 2026-09-17
- **Discovered by:** Post-session evaluation of three trading agents (local docker compose: herobids stack + traderton `xstack` boundary), window 15:15–16:00 CEST (13:15–14:00 UTC).
- **Environment:** development, local docker compose. herobids API `localhost:3000`; traderton boundary `localhost:8080` (healthy). LLM provider `ollama` (local). Agent container: `herobids-agent-26a11d7f-9168-4a72-853e-907568df3092` ("tintel").

## Root cause — CONFIRMED (fix applied)

The earlier hypotheses below were disproven by a final code trace: the failure was **the hint being stripped, not the hint being absent-at-source**.

The chain:

1. herobids' `agent-decision-handler.ts` correctly resolves `venueAccountId` off the connection grant (`resolveGrantVenueAccountId` → `approvalVenueAccountResolver`, wired in `apps/worker/src/index.ts:517`) and includes it in the boundary payload via `buildSubmitDecisionPayload` (`decision-boundary-mapping.ts:45`).
2. The traderton boundary dispatcher validates the payload against the **tool's own Zod schema** and forwards the **parsed** result (`packages/boundary/src/dispatcher.ts:346–356` → `payloadParse.data`). `SubmitDecisionParamsSchema` (`packages/worker/src/tools/trading.ts`) did NOT declare `venueAccountId` → Zod **stripped the unknown key**.
3. The context factory (`bin.ts:243–264`) passes that stripped payload to `resolveSubjectInjection`; `venueAccountIdOf(payload)` (`subject-resolver.ts:79`) sees `undefined`.
4. The owner (herobids@gmail.com) has **two** venue accounts (hyperliquid + 1inch) and `bin.ts` wires no `getDefaultVenueAccountId` port → the resolver returns `precondition.not_ready` `"no default venue account for owner (ambiguous)"` (`subject-resolver.ts:297–307`), thrown by `bin.ts:262–264`, flattened by `dispatcher.ts:495` into the observed opaque `precondition.not_ready / "trading context unavailable"`.

Two corollary symptoms explained by the same trace:

- **`get_account_summary` reporting `executionMode: "paper"` while the agent is configured `shadow`:** the boundary's context factory derives `executionMode` from `injection.ownerMode`, and `resolveNoBotOwnerMode` for `actor.type === 'agent'` reads `ports.getDefaultOwnerMode?.(ownerId) ?? 'paper'` — `bin.ts` never wires `getDefaultOwnerMode`, so every agent-subject invocation sees `paper`. Secondary; filed in the companion report as a follow-up (L3-Rx already tracks per-tool venue/mode signals).
- **`risk_contract_unavailable / agent_config_unavailable / agent_repo_unavailable` in `get_account_summary`:** these come from the **traderton** copy of the tool (`packages/worker/src/tools/account.ts`), whose boundary context factory supplies `botRepo` but not `riskContractOps`/`executionConfig`/`agentRepo` (`bin.ts:271–305`). The warnings are truthful at the boundary — the platform ops are herobids-owned and intentionally not crossed. Cosmetic degradations of the boundary copy, not a herobids wiring defect. Also tracked in the companion report.

## What is CONFIRMED (facts, directly observed — from the original investigation)

1. **The traderton boundary rejects every `submit_decision`** for this owner with a terminal outcome:

   ```
   code:    precondition.not_ready
   message: "trading context unavailable"
   retryable: true
   ```

   3 such invocations to date (13:20:36 ×2, 14:28:12 ×1), all identical. Source: traderton `boundary_invocations` (tool_name=`submit_decision`).

2. **No trading state was produced anywhere.** traderton `decisions=0, fills=0, positions=0` (also orders/execution_plans/journal_events = 0). The decision never reached the executor. In `shadow` mode a *successful* path would have produced simulated shadow fills (traderton PaperExecutor/ShadowExecutor), so this is not "shadow does nothing by design".

3. **The agent's own trading tools report their context as unavailable.** For tintel, `get_account_summary` returns:

   ```json
   { "ok": true, "capital": null, "capitalAvailable": false, "executionMode": "paper",
     "riskLimits": "unavailable",
     "warnings": ["risk_contract_unavailable","agent_config_unavailable","agent_repo_unavailable"] }
   ```

   and `get_risk_limits` returns `status: error`, `"risk contract not available in this context"`. This is stable across every tick (13:19, 14:09, 14:28). Note `executionMode` here reads `paper` even though the agent's configured mode is `shadow` — flagged, not yet explained.

4. **`get_risk_limits` / `adjust_risk_limits` never reach the boundary.** The only tools traderton ever received are `check_watches`, `submit_decision`, `watch_token`, `provision_venue_account`. So the `get_risk_limits` failure in (3) happens **inside the herobids agent runtime**, before any boundary call — it is a herobids-side context/wiring problem, not a boundary failure.

5. **The agent misreports the failure to the user.** After the rejections, tintel messaged the user that execution is "in paper/shadow mode — live trades cannot be submitted… the trading infrastructure needs to be connected… ensure your exchange API connection is properly configured." This is misleading: the connection is active and provisioned, and the real failure is a boundary `precondition.not_ready`. (Tracked as a secondary issue below.)

## What was DISPROVEN (do not assume these)

While narrowing the cause, three plausible explanations were checked against the live system and **found false**. Recording them so the next investigator does not repeat them:

- **NOT the venue-account "ambiguity regression" from the (now-deleted) root `SCRATCHPAD.md`.** The current code already has the fix on both sides: herobids resolves `venueAccountId` from `connection.resolvedVenueAccountId` and passes it (`apps/worker/src/agents/agent-decision-handler.ts:528–530`), and traderton's subject-resolver honours a supplied `venueAccountId` deterministically, mirroring the `botId` branch (`traderton/packages/boundary/src/subject-resolver.ts:266–290`). The owner-only "ambiguous" fallback emits a *different* message ("no default venue account for owner (ambiguous)"), not the observed "trading context unavailable".

- **NOT a missing `agentRepo` / `agentRiskDefaults` in the agent container.** `buildRiskContractOps()` returns `undefined` only when `!agentRepo || !agentConfig.agentRiskDefaults` (`apps/worker/src/agent.ts:1737`). Live inspection shows the agent container HAS `DATABASE_URL=postgres://herobids:herobids@postgres:5432/herobids` (so `agentRepo` is constructed) and `AGENT_CONFIG` carries a full `agentRiskDefaults` block. So the null-guard is not the trigger — yet the tools still report `risk_contract_unavailable / agent_repo_unavailable`.

- **NOT DB/Redis unreachability from the agent container.** The agent container is on `herobids_default` and reaches `postgres:5432` and `redis:6379` (TCP checks OK).

- **NOT a not-ready connection.** The agent's `runtimeDescriptor` (from live `AGENT_CONFIG`) shows the trading connection `6bb2449f…` with `readiness.effectiveReady: true`, `isDefault: true`, `resolvedVenueAccountId: "57908962-89d3-449d-a555-b16bc1dd1c19"`. So on the descriptor herobids reads, `resolveGrantVenueAccountId` *should* return a venueAccountId and the connection *should* be executable.

## Root cause — NOT confirmed

The confirmed facts are in tension and I cannot yet reconcile them into a single verified cause:

- The boundary's `"trading context unavailable"` string is emitted **only** by `dispatcher.ts:495` when the context factory throws; for `submit_decision` the context factory (`traderton/packages/boundary/src/bin.ts:243–264`) throws **only** when `resolveSubjectInjection` fails. For an owner with 2 venue accounts, that failure implies **no `venueAccountId` reached the resolver** (a supplied+owned id would succeed; a supplied+unowned id would say "venue account not owned by subject"). That would mean herobids did **not** send the hint on the wire.
- BUT the herobids-side descriptor shows a ready connection with a resolved venue account, which is exactly the input `resolveGrantVenueAccountId` uses to produce the hint. So either the hint is computed but not placed on the boundary payload, or something else fails.
- Separately, the agent's own tools report `risk_contract_unavailable / agent_repo_unavailable` despite `agentRepo` + `agentRiskDefaults` + DB being present — implying the `ToolContext` handed to the **trading tools at call time** lacks `riskContractOps` / `agentRepo` / `agentConfigOps`, even though the top-level composition builds them.

**Working hypothesis (UNVERIFIED):** the `ToolContext` used for the trading/decision path is assembled without the platform ops (`riskContractOps`, `agentConfigOps`, `agentRepo`) and without threading the resolved `venueAccountId` — i.e. a context-assembly/wiring gap specific to the trading-tool (or boundary-routed decision) path, distinct from the top-level `agent.ts` composition. The single symptom family — "risk contract unavailable", "agent repo unavailable", and a decision that reaches the boundary without a resolvable venue context — is *consistent* with one context-assembly defect, but I have **not** traced the exact assembly site that drops them. Do not treat this as established.

The boundary deliberately **discards** the underlying cause (`dispatcher.ts:495` catch: "Do not leak the underlying cause over the boundary") and logs nothing internally, which is why the exact reason cannot be recovered from artifacts. See the cross-cutting observability item below.

## Steps to reproduce

1. Local compose: herobids stack + traderton `xstack` boundary up; boundary `/health/ready` returns `{"status":"ready"}`; HMAC creds match on both sides.
2. Create a trading agent (skill `system/trading`, `executionMode: shadow`, a ready hyperliquid connection with `resolvedVenueAccountId` set) and start it.
3. Let it run at least one escalated tick so the LLM calls `submit_decision`.
4. Observe:
   - traderton: `SELECT tool_name, jsonb_extract_path_text(terminal_response,'outcome','code'), jsonb_extract_path_text(terminal_response,'outcome','message') FROM boundary_invocations WHERE tool_name='submit_decision';` → `precondition.not_ready / "trading context unavailable"`.
   - traderton: `decisions/fills/positions` remain 0.
   - herobids `agent_messages` (type `agent.tool.result`) for `get_account_summary` → `warnings: [risk_contract_unavailable, agent_config_unavailable, agent_repo_unavailable]`; `get_risk_limits` → `"risk contract not available in this context"`.

## Impact

- Agents cannot execute any trade (direct or via bot decisions) for this owner/setup. No fills, positions, journal, or P&L are produced; shadow-mode simulation is equally blocked.
- Agents surface a misleading explanation to users, sending them to fix a venue connection that is not the problem.

## Investigation steps — RESOLVED (each was investigated; outcomes recorded)

1. **Trace the trading-tool `ToolContext` assembly.** — RESOLVED: the `_unavailable` warnings come from the **traderton** copy of the tools; the traderton boundary context factory (`bin.ts`) supplies `botRepo` but intentionally not the platform ops (`riskContractOps`/`executionConfig`/`agentRepo` — herobids-owned values that do not cross the boundary). Not a herobids wiring defect; the herobids composition (`agent.ts:1983`/`:1998`) was always correct. Cosmetic degradation tracked in the companion report.
2. **Confirm whether herobids sends `venueAccountId` on the wire.** — RESOLVED: herobids DOES send it (`buildSubmitDecisionPayload` includes `venueAccountId` when non-empty; the live descriptor had `resolvedVenueAccountId` set). The traderton `submit_decision` Zod schema did not declare the field, so the dispatcher's `payloadParse` **stripped it** before the subject resolver saw it. This was the root cause. No herobids change needed.
3. **Explain the `executionMode: "paper"` in `get_account_summary`** — RESOLVED: the boundary context factory derives `executionMode` from `injection.ownerMode`; `resolveNoBotOwnerMode` for an `agent` actor reads `ports.getDefaultOwnerMode?.(ownerId) ?? 'paper'`, and `bin.ts` wires no `getDefaultOwnerMode` → every agent-subject invocation defaults to `paper`. Tracked in the companion report (L3-Rx).
4. **Recover the boundary's swallowed cause** — DONE: `dispatcher.ts` now logs the context-factory failure internally (`logger.error` with toolName/ownerId/actorId/requestId/correlationId) while still returning only the opaque `precondition.not_ready` over the wire.

## Cross-cutting observability defect (traderton — FIXED alongside the schema fix)

`traderton/packages/boundary/src/dispatcher.ts` (the `executeAndMap` catch) previously discarded the context-factory error entirely. Not leaking the cause *over the boundary* remains intentional (legal isolation), but the cause is now **logged internally** on the traderton side before the opaque response is returned. This closes the diagnosability gap that made this bug hard to root-cause from artifacts. Recorded in the companion report.

## Secondary issue — misleading agent message (herobids)

When `submit_decision` fails with `precondition.not_ready`, the agent narrates it to the user as "paper/shadow mode / connect your exchange". Consider threading the boundary `code`/`message` into the tick context so the agent reports the true precondition instead of inventing a venue-connection explanation. (Behavioural/UX; lower severity than the execution block.)

## Evidence (saved artifacts)

Under `.ignore/eval/2026/09/17/_shared/bug-evidence/` (evaluation output; note: `.ignore/` contents may be pruned by external cleanup — re-collect from the live stack if missing):

- `traderton-submit_decision.txt` — the 3 rejected `submit_decision` boundary invocations with terminal responses.
- `tintel-tool-results.txt` — `get_account_summary` / `get_risk_limits` / `submit_decision` tool results (the `*_unavailable` warnings).
- `tintel-agent.log` — full agent-runtime log for the session.
- `tintel-AGENT_CONFIG.json` — the agent container's `AGENT_CONFIG` (shows `effectiveReady: true`, `resolvedVenueAccountId`, `agentRiskDefaults`).

## References (code, read during investigation — not modified)

- `apps/worker/src/tools/trading.ts` — `submit_decision` tool: publishes `DECISION_SUBMIT`, blpops reply.
- `apps/worker/src/agents/agent-decision-handler.ts` — `resolveGrantVenueAccountId` (`:194`), boundary invoke with `buildSubmitDecisionPayload(payload, venueAccountId)` (`:528–531`).
- `apps/worker/src/index.ts` — `approvalVenueAccountResolver` reads `chosen.resolvedVenueAccountId` for a connection with `readiness.effectiveReady` (`:518–530`).
- `apps/worker/src/agent.ts` — `buildRiskContractOps()` null-guard (`:1737`); `ToolContext` build with `riskContractOps` (`:1983`) and `agentRepo` (`:1998`).
- traderton `packages/boundary/src/subject-resolver.ts` — honours supplied `venueAccountId` (`:266–290`); owner-only ambiguity fallback (`:297–307`).
- traderton `packages/boundary/src/bin.ts` — context factory throws on `resolveSubjectInjection` failure (`:243–264`).
- traderton `packages/boundary/src/dispatcher.ts` — swallows the cause, returns `precondition.not_ready "trading context unavailable"` (`:485–496`).
- traderton `packages/worker/src/tools/trading.ts` — the `submit_decision` Zod schema (FIXED here — was missing `venueAccountId`).

## Fix applied (2026-09-17 — three phases; live-verified end-to-end)

### Phase 1 — schema stripping (the original bug; traderton)

| File | Change |
|------|--------|
| `traderton/packages/worker/src/tools/trading.ts` | `SubmitDecisionParamsSchema` now declares `venueAccountId` (same shape as `create_bot`'s in `bots.ts:56`). The dispatcher's `payloadParse` no longer strips the consumer-supplied hint, so the subject resolver resolves deterministically off the connection grant. |
| `traderton/packages/boundary/src/dispatcher.ts` | `executeAndMap`'s catch now logs the context-factory error internally (`logger.error` with toolName/ownerId/actorId/requestId/correlationId) before returning the unchanged opaque `precondition.not_ready` over the wire. |
| `traderton/packages/worker/src/index.ts` | Re-exports `createLogger` so the boundary can use the same pino factory without a new dependency. |

### Phase 2 — agent-direct actor registration (uncovered by the live test after Phase 1)

With the schema fixed, the live `submit_decision` proceeded past resolution and failed the NEXT layer: `instance_not_running` / "No execution context — ensure the actor is active and running" (`decision-intake.ts:104-111`). Root cause: item C's `constructAndRegisterAgentActor` had **NO production caller** — the M1 consumer that drove agent-actor lifecycle (herobids' in-process `AgentSessionManager`) was deleted by herobids L3d-5, and the M2 boundary never registered an agent actor. Fixed by making the boundary the lifecycle driver item D deferred to the consumer:

| File | Change |
|------|--------|
| `traderton/packages/boundary/src/bin.ts` | `buildAgentDirectActorEnsure`: on the first venue-resolving agent invocation per `(ownerId, actorId, venueAccountId)`, constructs + registers + STARTS the `AgentTradingActor` (start required — the second intake guard at `decision-intake.ts:121` is only reachable after a successful start). Cached per tuple; failed starts evict so the next attempt reconstructs. |

### Phase 3 — consumer-injected platform risk context (uncovered by the live test after Phase 2)

With the actor running, the live `submit_decision` reached the engine risk gate (decisions PERSISTED in traderton `decisions`) and was rejected: `"Daily loss limit reached: $0.00 realized (limit: $0.00)"` — `dailyLossLimit = equity × dailyMaxLossPct/100`, and equity = capital + P&L with **capital never injected** (the boundary process cannot read the consumer's `agents` table — locked: no `agents`-table dependency, 017 §4 / 019 §1). Fixed by injecting the platform-owned values at the call site (005's M2-adapter contract: "herobids injects the platform-owned values it still holds … at the call site"):

| File | Change |
|------|--------|
| `traderton/packages/worker/src/tools/trading.ts` | Schema declares consumer-injected `capital` / `riskPosture` / `riskOverrides` (post-LLM platform values — the LLM never sees or supplies them). |
| `traderton/packages/boundary/src/subject-resolver.ts` | `agentRiskSpecOf(payload)` extracts the risk context; `ResolvedInjection.agentRiskSpec` carries it onto the injection (both no-bot paths). |
| `traderton/packages/boundary/src/bin.ts` | The ensure consumes the risk spec: `capital`/`riskPosture` CHANGED → stop + deregister + reconstruct fresh (they anchor `EquityTracker` peak at construct time). Failure cache-eviction preserved. |
| `herobids/apps/worker/src/agents/decision-boundary-mapping.ts` | `buildSubmitDecisionPayload` gains `AgentRiskInjection` (capital/riskPosture/riskOverrides), carried through when present. |
| `herobids/apps/worker/src/agents/agent-decision-handler.ts` | Direct path injects `agent.capital` / `agent.risk` / `agent.riskOverrides` from the row already loaded at `:245` — zero additional queries. |
| `herobids/apps/worker/src/services/approval-service.ts` + `apps/worker/src/index.ts` | Approval path injects the agent's **CURRENT** risk context via a new `agentRiskResolver` dep (environment state, not a decision-semantics snapshot — an approval may execute hours after creation). |
| Tests | traderton: `subject-resolver.test.ts` (risk-spec extraction ×4), `trading.test.ts` (schema preserves capital/posture/overrides; empty→undefined). herobids suites unchanged-green. |

## Verification (live, on the rebuilt stack)

- `pnpm lint` + per-package `tsc -p` (traderton boundary + worker): clean. NOTE: the root `pnpm lint` had a build-cache blind spot — it passed while the Docker build failed with TS6133/TS2663 on the first dispatcher edit; always verify with `npx tsc --noEmit -p packages/boundary` before shipping.
- traderton unit suite: `2660 passed | 45 skipped` — no regressions. herobids: lint clean; decision-handler/approval-service suites green.
- **Live cross-stack run** (clean slate via `reset-and-run-xstack.sh`, reproduced the original ambiguous setup — owner with hyperliquid + 1inch accounts, shadow agent, `capital=1000`):
  - boundary log: `agent-direct actor constructed + started … mode:paper, capital:"1000.00000000"`
  - traderton `decisions`: **3 persisted** (ZEC/SOL/HYPE go_long, actor_id = the agent)
  - traderton `fills`: **3 shadow fills** (HYPE 2.5 @ 82.39, SOL 3 @ 101.50, ZEC 0.35 @ 1482.69)
  - traderton `positions`: **3 open long positions** on hyperliquid
  - traderton `journal_events`: 15
  - Previously: decisions/fills/positions/journal ALL 0 — every decision died at the boundary context factory.

## Known remaining follow-ups (not blocking; recorded)

1. **`get_account_summary` still reports `capital: null` / `executionMode: "paper"`** — the boundary's tool-context factory (`bin.ts`) doesn't supply `agentRepo`/`executionConfig`/`riskContractOps` (platform-owned values intentionally not crossed). The LLM flow works anyway (conservative sizing when capital unknown; the real injected capital drives the gate). Future `sync_agent_context`-style boundary tool or enriched context. Tracked in the companion report.
2. **Agent-direct actors start in `paper` mode** — `injection.ownerMode` for agent subjects falls back to `paper` (no `getDefaultOwnerMode` port wired). L3-Rx already tracks per-tool venue/mode signals.
3. **Misleading agent message to users** (the original report's secondary issue) — unchanged, behavioural/UX.

## Related

- `docs/bug-reports/2026/09/07/002-1inch-provider-link-venue-account-missing-credential.md` — venue-account credential-linkage defect on the provider-link path; a different failure but in the same connection→venue-account→execution chain. (In the present case the herobids `connections` rows also have empty `credential_id`, while the traderton `venue_accounts` carry credential ids — relationship to this bug is unconfirmed.)
- `traderton/docs/bug-reports/2026/09/17/001-submit-decision-schema-strips-venue-account-id.md` — companion report (traderton side) with the boundary-internal analysis, the `ownerMode: 'paper'` follow-up, and the boundary `get_account_summary` platform-ops gap.
