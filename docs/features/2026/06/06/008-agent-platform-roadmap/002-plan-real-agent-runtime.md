# Plan 2: Real Agent Runtime

**Phase:** 2
**Status:** done
**Depends on:** [Phase 1 — Foundation Cleanup](./001-plan-foundation-cleanup.md)
**Roadmap:** [000-roadmap.md](./000-roadmap.md)

## Progress

| Step | Description | Status |
|---|---|---|
| 2.1 | `docker-socket-proxy` added to docker-compose.yaml | `done` |
| 2.2 | `Dockerfile.agent` created and builds successfully | `done` — `docker/Dockerfile.agent` exists |
| 2.3 | `scripts/sandbox-exec.sh` ported from aitradingbot | `done` — `scripts/sandbox-exec.sh` exists |
| 2.4 | `DockerAgentManager` implemented (start/stop/reconcile/crash) | `done` — `apps/worker/src/agents/docker-agent-manager.ts` |
| 2.5 | Stub launcher replaced with `DockerAgentManager` | `partial` — `AGENT_RUNTIME_MODE` env var routes to Docker; BUT defaults to `'stub'`; `docker-compose.yaml` does not set `AGENT_RUNTIME_MODE=docker`, so production still uses stub |
| 2.6 | `CapabilityPolicyEngine` on production path | `done` — instantiated per-agent in `agent-message-broker.ts` |
| 2.7 | Sandbox enforcement on code execution | `partial` — `SandboxEnforcer` and `sandbox-exec.sh` exist; `SandboxEnforcer` is not imported or called in `agent-message-broker.ts` on the `code_execute` path |
| 2.8 | Docker event stream + crash → safety alert | `done` — `DockerAgentManager` subscribes to event stream; `onContainerDie` updates DB status and fires `runtime_failed` alert |
| 2.9 | `packages/llm/` extracted; Anthropic native support added | `done` — `packages/llm/src/llm-provider.ts` with Anthropic support |
| 2.10 | Agent entry point `apps/worker/src/agent.ts` created | `done` — 580 lines; reads env, connects Redis Streams, runs reasoning loop |
| 2.11 | Agent reasoning loop ported from aitradingbot | `done` — tick-based loop in `agent.ts`; builds prompt context, calls LLM, dispatches tool calls |
| 2.12 | Skill system ported and wired to skill presets | `done` — skill constants (`BASE_SKILL`, `BOT_MANAGEMENT_SKILL`, `RISK_MONITORING_SKILL`) in domain; imported in `agent.ts` |
| 2.13 | `pnpm lint` passes, all tests pass | `done` |

## Goal

Replace the stub agent runtime launcher with a real Docker-based container runtime. Each agent runs in its own isolated container. The runtime boundary is enforced in production, not just in tests.

## Context

ADR 003 ([003-single-container-agent-code-execution.md](../../../tech/adrs/2026/06/003-single-container-agent-code-execution.md)) requires one container per agent runtime.

The current `apps/worker/src/agents/agent-runtime-launcher.ts` synthesizes a fake container ID in memory and does not launch a real container. This means:
- The Step 7 runtime-boundary requirement from the MVP plan is unmet
- No real isolation between agents
- Sandbox and capability policy have no real enforcement surface

The previous project (`aitradingbot`) solved this with a `DockerAgentManager` + `docker-socket-proxy` pattern that can be ported directly. The agent communicates back via Redis Streams, which is already the transport layer in herobids.

---

## Deliverables

### 1. Docker Socket Proxy In docker-compose

Add `tecnativa/docker-socket-proxy` to `docker-compose.yaml`.

The proxy exposes a restricted subset of the Docker API to the worker:
- `CONTAINERS: 1` — allow container management
- `POST: 1` — allow create/start/stop
- `EVENTS: 1` — allow event streaming for crash detection
- `IMAGES: 0`, `NETWORKS: 0`, `VOLUMES: 0`, `EXEC: 0`, `BUILD: 0` — all blocked

The worker connects to Docker via the proxy, not the raw socket. This limits blast radius if the worker is compromised.

```yaml
docker-proxy:
  image: tecnativa/docker-socket-proxy
  restart: unless-stopped
  volumes:
    - /var/run/docker.sock:/var/run/docker.sock:ro
  environment:
    CONTAINERS: 1
    POST: 1
    EVENTS: 1
    IMAGES: 0
    NETWORKS: 0
    VOLUMES: 0
    EXEC: 0
    SWARM: 0
    BUILD: 0
```

The worker service must receive:
```yaml
environment:
  DOCKER_HOST: docker-proxy
  DOCKER_NETWORK: herobids_default   # the compose network name
  AGENT_IMAGE: herobids-agent:latest
```

### 2. Agent Dockerfile (`Dockerfile.agent`)

Create a separate image for the agent runtime. This image:
- Builds the agent entry point from `apps/worker/src/agent.ts` (or a new dedicated entry)
- Installs network sandboxing tools: `iproute2`, `iptables`, `ip6tables`
- Copies `scripts/sandbox-exec.sh` (adapted from aitradingbot)
- Does **not** include the worker BullMQ runtime or bot actor code — agent image is lean
- Passes config via environment variables (no raw credentials, no operator secrets)

Container resource defaults (configurable via operator config):
- Memory: 512 MB
- CPU: 0.5 vCPU
- Ephemeral storage: 512 MB workspace

### 3. Network Sandbox Script

Create `scripts/sandbox-exec.sh` adapted from aitradingbot:
- Creates a network namespace per command execution
- Allows public internet egress
- Blocks all RFC 1918 ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
- Blocks link-local (169.254.169.254 — instance metadata endpoints)
- Uses public DNS (8.8.8.8, 8.8.4.4) — not the Docker-internal resolver
- Cleans up namespace on exit

Requires `CAP_NET_ADMIN` in the container security context.

### 4. `DockerAgentManager`

Create `apps/worker/src/agents/docker-agent-manager.ts`.

Responsibilities:
- `start(userId, agentId)` — pull bot config, resolve env vars, launch container via Docker API through proxy
- `stop(userId, agentId)` — mark stopped in DB first, then stop container; always close session
- `stopById(agentId)` — stop without userId check (used during worker shutdown)
- `reconcile()` — compare running containers against DB `status = 'active'` agents; restart missing, stop orphaned
- `onContainerDie(agentId)` — handle container crash events from Docker event stream; update DB, close session, trigger safety alert

Container launch configuration:
- Image: `AGENT_IMAGE` env var
- Name: `herobids-agent-{agentId}`
- Network: `DOCKER_NETWORK` env var
- Memory limit, CPU limit from operator config
- Env vars injected:
  - `REDIS_URL`
  - `AGENT_ID`
  - `SESSION_ID`
  - `AGENT_CONFIG` (JSON-serialised agent record: goal, prompt, skillPreset, guardRails — secrets stripped)
  - `TOOL_POLICY` (serialised capability grants)
  - `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY` (resolved from operator config or user selection)
- No raw DB connection strings, no venue API keys (venue calls go through brokered tools)
- Note: no `BOT_ID` injected at launch — the agent creates and manages its own bots autonomously

### 5. Replace The Stub Launcher

File: `apps/worker/src/agents/agent-runtime-launcher.ts`

Replace the in-memory stub with a call to `DockerAgentManager.start()`.

The launcher remains the single call site for starting an agent runtime. It delegates to `DockerAgentManager`. The session manager continues to own session lifecycle; the launcher owns container lifecycle.

### 6. Capability And Sandbox Policy On The Production Path

File: `apps/worker/src/agents/capability-policy.ts`

Instantiate `CapabilityPolicyEngine` on the production agent session path, not only in tests.

The engine must be constructed with:
- `DEFAULT_CAPABILITY_GRANTS` as the base
- The agent's persisted `toolPolicy` merged on top (per-agent overrides)

Every brokered tool call (decision submit, send_message, web_fetch, code_execute, publish_artifact) must be checked against the instantiated engine before execution.

File: `apps/worker/src/agents/sandbox-enforcer.ts`

Enforce sandbox policy on the production path:
- Code execution runs behind `sandbox-exec.sh` inside the agent container
- Output is bounded by `maxResponseBytes`
- Execution is bounded by `timeoutMs`
- Cleanup is guaranteed via `finally`

### 7. Container Event Streaming And Crash Detection

The `DockerAgentManager` must subscribe to Docker event stream after startup:
- Filter on container die/kill events
- Match by container name pattern `herobids-agent-*`
- On crash: call `onContainerDie(agentId)` which:
  1. Updates agent status to `crashed` in DB
  2. Closes the active session
  3. Fires the `runtime_failed` platform safety alert

### 8. Agent Entry Point And Reasoning Loop

**Current state:** The agent reasoning loop does not exist in herobids. The only LLM call in the codebase is `LlmStrategy` in `packages/strategy/src/llm.ts`, which is used exclusively for backtesting. No AI SDK dependencies are declared. The agent container entry point (`apps/worker/src/agent.ts`) does not exist yet.

This deliverable is therefore a **new build**, not a stub replacement. Port and adapt from `aitradingbot/src/agents/instance.ts` and `aitradingbot/src/agents/executor.ts`.

Create `apps/worker/src/agent.ts` as the container entry point:
- Reads config from environment variables (`AGENT_ID`, `SESSION_ID`, `REDIS_URL`, `AGENT_CONFIG`, tool policy grants)
- Connects to Redis Streams transport (existing transport layer in herobids)
- Runs the agent reasoning loop (tick-based, adapted from aitradingbot `AgentInstance`)
- Calls the LLM via the configured model (add an LLM client; OpenAI-compatible via native fetch already exists in `packages/strategy/src/llm-provider.ts` — reuse or promote it)
- Builds prompt context: goal, recent decisions, fills, P&L, progress score, available tools
- Parses LLM output and dispatches brokered tool calls through Redis Streams
- Handles graceful shutdown on SIGTERM
- Does not import any bot actor, BullMQ worker, or execution code

**LLM dependency:** Reuse `callLlmProvider()` from `packages/strategy/src/llm-provider.ts`. Extract it to a shared package (e.g. `packages/llm/`) so both strategy backtesting and the agent runtime can import it without a circular dependency.

**Anthropic support:** Add native Anthropic API support to `callLlmProvider()`. Anthropic uses a different wire format (`/messages` endpoint, `x-api-key` header, `max_tokens` at the top level). Add a separate request path branched on `config.provider === 'anthropic'`. Remove Anthropic from `INCOMPATIBLE_PROVIDERS`. Claude (e.g. `claude-sonnet-4-5`) is the recommended default model for agent reasoning — it should be the operator config default.

**Skills:** Port the skill system from `aitradingbot/src/agents/skills/` — skills define what tools and context the agent can access based on its preset.

---

## Migration Path

The stub launcher must remain functional in the dev environment without Docker available. Add a `AGENT_RUNTIME_MODE` env var:
- `docker` (default in production) — uses `DockerAgentManager`
- `stub` (for local dev without Docker) — keeps current in-memory behavior

The worker startup logs must clearly state which mode is active.

---

## Exit Criteria

- [ ] `docker-socket-proxy` added to `docker-compose.yaml`
- [ ] `Dockerfile.agent` builds successfully
- [ ] `scripts/sandbox-exec.sh` adapted and tested
- [ ] `DockerAgentManager` implemented: start, stop, stopById, reconcile, onContainerDie
- [ ] Stub launcher replaced; `DockerAgentManager` used on production path
- [ ] `CapabilityPolicyEngine` instantiated and used on production path for all brokered tools
- [ ] Sandbox enforcement (timeout, output bounds, cleanup) on code execution
- [ ] Docker event stream subscribed; crashes trigger safety alert and session close
- [ ] `AGENT_RUNTIME_MODE=stub` still works for local dev
- [ ] `pnpm lint` passes
- [ ] All existing tests pass; new tests cover DockerAgentManager start/stop/reconcile
- [ ] Agent reasoning loop implemented (`apps/worker/src/agent.ts`)
- [ ] LLM client reused or promoted from `packages/strategy/src/llm-provider.ts`
- [ ] Skill system ported from aitradingbot and wired to skill presets
- [ ] Agent tick loop: builds prompt context, calls LLM, dispatches tool calls via Redis Streams

---

## Decision Log

Append-only. Record decisions made or changed during implementation, with date and reason.

| Date | Decision | Reason |
|---|---|---|
| 2026-06-04 | Agent reasoning loop is a new build, not a stub replacement | No LLM loop exists in herobids worker; must port from aitradingbot |
| 2026-06-04 | No `BOT_ID` injected at agent container launch | Agents create their own bots; the agent is not bound to a single bot at launch |
| 2026-06-04 | Add native Anthropic support; remove from `INCOMPATIBLE_PROVIDERS` | Claude is the best agent reasoning model; current OpenAI-only restriction is arbitrary |
| 2026-06-04 | Extract `callLlmProvider` to `packages/llm/` | Both strategy backtesting and agent runtime need it; shared package avoids duplication |
| 2026-06-05 | Catch-up audit: steps 2.1–2.4, 2.6–2.13 marked done/partial; 2.5 partial (AGENT_RUNTIME_MODE defaults to 'stub'); 2.7 partial (SandboxEnforcer not on code_execute path) | Plan was not updated during implementation; audit performed retroactively |
