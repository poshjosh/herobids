# Agent Platform Roadmap

This is the canonical high-level roadmap for herobids from its current state to the goal of a live, internal-user-ready agentic trading platform.

## Reference Documents

- [Vision](../../../vision.md)
- [Domain Language](../../../tech/domain-language.md)
- [Runtime Boundary And Message Contract](../../../tech/agents/runtime-boundary-and-message-contract.md)
- [ADR 001: Actor-Neutral Agent Protocol](../../../tech/adrs/2026/06/001-actor-neutral-agent-protocol.md)
- [ADR 002: Redis Streams Agent Transport](../../../tech/adrs/2026/06/002-redis-streams-agent-transport.md)
- [ADR 003: Single-Container Agent Code Execution](../../../tech/adrs/2026/06/003-single-container-agent-code-execution.md)
- [Preliminary Re-assessment](../007-re-assessment/001-preliminary-report.md)
- [**Implementation Guide**](./000a-how-to-implement.md) — how to work through these plans without silent divergence

## Overall Status

| Phase | Status | Notes |
|---|---|---|
| Phase 1 — Foundation Cleanup | `in progress` | Most done. Remaining: rename residue in domain/API/web, safety alert gaps, delete UI, /bots page. See [006-remaining-work.md](./006-remaining-work.md). |
| Phase 2 — Real Agent Runtime | `in progress` | Mostly done. Remaining: AGENT_RUNTIME_MODE defaults to 'stub' in docker-compose, SandboxEnforcer not on code_execute path. See [006-remaining-work.md](./006-remaining-work.md). |
| Phase 3 — Agent-First Experience | `in progress` | 3.1–3.3 and 3.6 done. 3.4 partial. 3.7–3.8 blocked on /bots page (Phase 1 gap). |
| Phase 4 — Platform Hardening | `done` | Completed 2026-06-05. All steps done. |

---

## Current State (2026-06-05)

Implementation ran significantly ahead of the plan docs without the plan docs being updated. After a catch-up audit on 2026-06-05, the actual state is:

**Done across Phases 1–4:**
- DB schema fully aligned: `bots` table (with `creatorType`/`creatorId`), `user_credentials`, `agent_credentials`, `skills` tables, no `trading_instances` or `agent_instance_links` in migrations
- Agent CRUD, runtime sessions, message ledger, artifact metadata
- Redis Streams agent protocol transport
- `DockerAgentManager` implemented (start/stop/reconcile/crash detection, event stream)
- `docker-socket-proxy` in docker-compose
- `Dockerfile.agent` and `scripts/sandbox-exec.sh` exist
- `CapabilityPolicyEngine` on production path in `agent-message-broker.ts`
- `manage_bot` and `send_message` in `DEFAULT_CAPABILITY_GRANTS` and broker
- `packages/llm/` extracted; `packages/strategy` uses it; `apps/worker/src/agent.ts` (580 lines) has the full reasoning loop
- Skill presets (`trading`, `reminder`, `custom`) in domain, API, and web UI
- Decisions card, Objective card in `AgentDetailPage`
- Venue `probe()` on both Hyperliquid and Jupiter adapters
- Venue auto-detection at credential registration (`accounts.ts`)
- `create_bot` brokered tool implemented in `agent-message-broker.ts` (via `MANAGE_BOT` create action)
- Full docker-compose stack, dev overrides, pino-pretty, seed script, functional/integration/E2E tests, responsive layout

**Still open (details in [006-remaining-work.md](./006-remaining-work.md)):**
- Rename residue: `TradingInstanceId`/`TradingInstanceConfig*` in domain; `instances.ts` API route not renamed to `bots.ts`; no `/bots` web page
- Safety alerts: `paused_by_guardrail` and `critical_execution_failure` not fired in `agent-session-manager.ts`
- Delete control not wired in `AgentDetailPage`
- `AGENT_RUNTIME_MODE` defaults to `'stub'` — docker-compose.yaml does not set it to `'docker'`
- `SandboxEnforcer` not called on the `code_execute` production path in the broker
- Goal-driven create flow is single-step (no 2-step intent + review)
- `/bots` page and strategy preset UI not built

---

## Phases

### Phase 1 — Foundation Cleanup

**Goal:** Correct the model, complete the existing MVP gaps, and ensure what is shipped is correctly named and internally consistent.

**Key deliverables:**
- Rename `trading_instances` to `bots` across all layers
- Introduce the `blueprint` concept as the config/spec separation inside a bot
- Align agent presets to skill-based presets (`trading`, `reminder`, `custom`) — move strategy presets to bots
- Complete remaining MVP gaps: decisions UI, objective card, relink/delete, capability registration
- Complete mandatory safety alert wiring
- Create the domain language document
- Fix UI naming (separate "Create Bot" from "Create Agent", name suggestion `<username>-agent`)

**Depends on:** Nothing. This is the baseline.

**Plan:** [001-plan-foundation-cleanup.md](./001-plan-foundation-cleanup.md)

---

### Phase 2 — Real Agent Runtime

**Goal:** Each agent runs in a real isolated Docker container. The runtime boundary is not a stub.

**Key deliverables:**
- Per-agent Docker container using `DockerAgentManager` (ported from aitradingbot)
- `docker-socket-proxy` in docker-compose (restricted Docker API access)
- Separate `Dockerfile.agent` for the agent runtime image
- Network namespace sandbox (public internet allowed, internal networks blocked)
- Capability and sandbox policy enforced on the production path
- Container lifecycle reconciliation (orphan recovery, crash detection)
- Agent communicates back via Redis Streams (existing transport, no change needed)

**Depends on:** Phase 1 (naming and model must be stable before containerizing)

**Plan:** [002-plan-real-agent-runtime.md](./002-plan-real-agent-runtime.md)

---

### Phase 3 — Agent-First Experience

**Goal:** Users describe what they want. Agents figure out the rest. No venue or symbol expertise required.

**Key deliverables:**
- Venue auto-detection from credentials/wallet (agent determines venue type, instruments, modes)
- Agents autonomously create and configure bots from user goal
- User-facing flows expose goal, constraints, and budget — not strategy params or symbol formats
- Skill preset UI for agents (trading, reminder, custom)
- Strategy preset UI for bots (momentum, dca, range)
- Progress scoring in agent context (net P&L after all costs, performance score)
- Agent name suggestion: `<username>-agent`

**Depends on:** Phase 1 (model must be stable), Phase 2 (real runtime needed for honest agent behavior)

**Plan:** [003-plan-agent-first-experience.md](./003-plan-agent-first-experience.md)

---

### Phase 4 — Platform Hardening

**Goal:** The platform is production-ready, testable, and deployable as a complete stack.

**Key deliverables:**
- Full docker compose stack: api, web, worker, postgres, redis, docker-socket-proxy
- Seed first admin user
- Functional, integration, and e2e user-acceptance tests
- Rate limiting validation under load (agents × market data providers)
- Responsive layout across all pages
- Log format review (JSON vs human-readable by environment)

**Depends on:** Phase 1 and 2 (stable model and real runtime before writing e2e tests)

**Plan:** [004-plan-platform-hardening.md](./004-plan-platform-hardening.md)

---

## Sequencing Summary

```
Phase 1 (Foundation Cleanup)
  └── Phase 2 (Real Agent Runtime)
        └── Phase 3 (Agent-First Experience)

Phase 1 (Foundation Cleanup)
  └── Phase 4 (Platform Hardening)
```

Phases 2 and 4 both depend on Phase 1.
Phase 3 depends on both Phase 1 and Phase 2.
Phase 4 can begin in parallel with Phase 2 once Phase 1 is complete.

---

## Known Contradictions With Existing Docs

The following items in the current codebase contradict what is described in this roadmap or in the domain language document. They are resolved in the phase plans.

1. **Agent presets are currently trading-strategy presets.**
   `apps/api/src/routes/agents.ts` defines `momentum_trader`, `range_trader`, `dca_accumulator` as agent presets. These are strategy concepts and belong on bots. Agent presets should be skill-based. This is corrected in Phase 1.

2. **`trading_instances` conflates config and runtime.**
   The DB schema, domain types, worker, and API all use `trading_instance` to mean both the configuration and the running process simultaneously. The blueprint/run split and rename to `bot` are Phase 1 work.

3. **The agent runtime launcher is a stub.**
   `apps/worker/src/agents/agent-runtime-launcher.ts` synthesizes a container ID in memory and does not launch a real container. ADR 003 requires one container per agent. This is Phase 2 work.

4. **Capability policy is not enforced on the production path.**
   `capability-policy.ts` and `sandbox-enforcer.ts` exist but are not instantiated outside tests. The broker uses a hardcoded constant instead of the agent's persisted `toolPolicy`. Partial fix in Phase 1 (registration and broker), full production enforcement in Phase 2.

---

## Strategic Decisions

### Why herobids, not aitradingbot

Two projects exist at `dev_ai/aitradingbot/` and `dev_ai/herobids/`. Three options were evaluated:

| Option | Description | Outcome |
|---|---|---|
| A — Extend aitradingbot | Add perpetuals/shorts to aitradingbot | Rejected: spot-only DEX model is architectural, not a gap |
| B — Rewrite herobids from scratch | Greenfield agent-first build | Rejected: herobids has a working engine, venues, and auth |
| C — Transplant (chosen) | Port the aitradingbot agent layer into herobids | Chosen: gets the best of both |

**herobids has:**
- Full `go_long` / `go_short` / `go_flat` execution engine with Hyperliquid perpetuals
- Position tracker with short-side P&L
- Planner, risk gate, reconciliation loop
- Auth, per-user ownership, API, and web UI

**aitradingbot has:**
- Working LLM reasoning loop (tick-based `AgentInstance` + `executor.ts`)
- Real `DockerAgentManager` with container lifecycle management
- Skill system (tool allowlists derived from skill preset)
- `docker-socket-proxy` + `sandbox-exec.sh` isolation pattern
- 60+ resolved production bugs and lessons

**What we transplant (Phase 2):**
- `DockerAgentManager` — start, stop, reconcile, crash detection
- Agent entry point and reasoning loop — adapted from `AgentInstance` / `executor.ts`
- Skill system — ported from `aitradingbot/src/agents/skills/`
- `sandbox-exec.sh` — adapted for herobids network isolation model
- `packages/ai` LLM provider — extracted to `packages/llm/`, Anthropic support added

**What we do NOT copy:**
- Direct trading tools on the agent (agents submit decisions; the engine executes)
- Raw infra secrets or operator config in agent container env
- `NET_ADMIN` / `SYS_ADMIN` capabilities on the main agent container
- aitradingbot's spot-only DEX swap model

See [.ignore/reference.md](../../../../.ignore/reference.md) for the full analysis of what to keep and reject.

---

## Decision Log

Append-only. Record strategic decisions made at the roadmap level.

| Date | Decision | Reason |
|---|---|---|
| 2026-06-04 | Option C: transplant aitradingbot agent layer into herobids | herobids has the engine; aitradingbot has the agent runtime. Neither rewrite alone gets there. |
| 2026-06-04 | Rename `trading_instances` → `bots`; drop `agent_instance_links`; add `creatorType`/`creatorId` | Agents create bots — a link table is the wrong abstraction. `trading_instance` conflates config with runtime. |
| 2026-06-04 | Agent presets are skill-based; strategy presets belong on bots | Agents are not trading strategies. Conflating them caused the wrong preset list to appear on agent create. |
| 2026-06-04 | Wipe and regenerate Drizzle migrations from scratch | No backward compat needed at this stage; cleaner than layering migrations on a broken model. |
| 2026-06-04 | Agents have full lifecycle authority over their own bots | No user confirmation gate on agent bot creation/start. Goal text is sole source of trading policy (Agent Mode Purity). |
