# AGENTS.md

Rules and guidelines for AI agents working on this codebase.

## Project Overview

HeroBids is an AI-first algorithmic trading system. It supports multiple venues (Hyperliquid perpetuals, Jupiter DEX swaps) with paper/shadow/live execution modes, real-time WebSocket market data, and configurable trading strategies.

Tech stack: TypeScript (strict), Node.js ≥22, ESM modules, pnpm monorepo, PostgreSQL + Drizzle ORM, Redis, Zod validation, vitest.

## Build & Run

```bash
pnpm install              # install all workspace deps
pnpm build                # build all packages (tsc)
pnpm test                 # run all tests (vitest)
pnpm lint                 # type-check only (tsc --noEmit)

# Infrastructure
docker compose up -d      # postgres + redis

# Database migrations
pnpm --filter @herobids/db run migrate
```

## Configuration

Two config layers — never mix them:

| | Operator config | Instance config |
|--|----------------|-----------------|
| **What** | DB URLs, API port, rate limits, venue endpoints, secrets refs | Strategy params, risk limits, venue preferences, execution mode |
| **Lifecycle** | Deploy/restart | Runtime (API call) |
| **Location** | `config/default.yaml` + env overrides | Postgres JSONB (`trading_instances.config`) |
| **Validation** | Startup (fail fast via Zod) | API write time (reject before engine sees it) |

See `docs/best-practices/configuration.md` for full details.

## Code Conventions

### Language & Style

- TypeScript with `strict: true`. Target ES2022, ESM only.
- `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters` enabled.
- Use meaningful, descriptive names. Variables are nouns, functions are verbs.
- Tool names use lower snake case.
- Prefer action-first tool names.
- Prefer `verb_noun` or `verb_noun_qualifier` when possible.
- Avoid noun-first and hyphenated tool names.
- Bad: `code_execute`, `get-overview-from-market`.
- Good: `execute_code`, `get_market_overview`.
- Keep functions short and single-purpose (SRP).
- Avoid over-engineering — write the simplest code that meets requirements (KISS).
- DRY: abstract only when duplication is proven, not preemptive.

### Error Handling

- Public APIs never throw — they return `Result<T, E>` (see `packages/domain/src/result.ts`).
- Use `ok()` / `err()` helpers for constructing results.
- Error codes are namespaced dot-strings: `venue.timeout`, `risk.exceeded`, etc.
- Distinguish fatal (cannot operate safely → crash) from warn-and-continue (sub-optimal → log + proceed).
- Every async loop must reschedule itself on failure (`finally` or top-level catch).

### Type Safety

- Define interfaces/types for all inputs, outputs, and data structures.
- Use branded types for domain values (`Quantity`, `Price`, `OrderId`, `FillId`).
- Validate at system boundaries (API input, config load, venue responses) with Zod.
- Interior code trusts already-validated types — no redundant runtime checks.

### Architecture

- **Ports & adapters**: Domain ports in `packages/domain/src/ports/`, infra in `packages/venues/`.
- Depend on abstractions (ports), not concrete implementations.
- Business logic in `packages/engine/` — pure where possible, no I/O imports.
- Constructor injection for all dependencies (no service locators, no global singletons).

### Actor Trading Model

- The system defines four actor types: `agent`, `bot`, `user`, `system`.
- Agents can trade directly via `submit_decision` — they do NOT need to create a bot first.
- Bots are optional tools for agents (and users), useful for automated trading, strategy testing, parallel execution, etc.
- The `DecisionIntakeResolver` must resolve execution context for any actor that submits a decision — not only bot actors.
- Execution context resolution varies by actor type:
  - **Bot** → `bots.venue_account_id` → `venue_accounts` (direct, via running TradingActor in actorRegistry)
  - **Agent** → `capability_grants.connection_id` → `connections` (the connections table absorbs the former trading_bindings)
  - **User** (future) → user-owned `connections` → `venue_accounts`

## Project Structure

```
packages/
  domain/      # Types, ports, value objects, config schemas (zero deps)
  engine/      # Core trading logic: planner, risk gate, executors, position tracker
  strategy/    # Strategy implementations (momentum, etc.)
  venues/      # Venue adapters (Hyperliquid, Jupiter), stream pool, mark sources
  db/          # Drizzle schema, migrations, repositories

apps/
  api/         # HTTP API (Hono) — instance CRUD, health
  worker/      # Long-running process — actors, stream pool, scan loops

config/        # Operator YAML config
docs/          # Feature specs, best practices, lessons, bug reports
scripts/       # One-off spikes and shell utilities
```

Package dependency direction: `domain` ← `engine` ← `strategy` / `venues` / `db` ← `apps/*`

## Agent Mode Purity

When an agent is running, the agent's goal text and any explicit creator-specified constraints are the **source of trading policy**. Do not inject hidden constraints the creator did not ask for.

| Category | Examples | Rule |
|---|---|---|
| **Constraints** | Stop-loss %, position caps, portfolio stop | Never apply unless explicitly configured (see risk gate rules below) |
| **Data** | Price, P&L, market context, progress score | Always provide — the agent reasons over it |
| **Operational mechanics** | Execution mode, slippage, retries, schema validation | Always apply — infrastructure, not policy |

### Risk Gate Rules for Agents

Every risk limit applied to an agent follows one of two paths:

| Path | Source | Mutability | Example |
|------|--------|------------|---------|
| **User-configured** | Explicitly set by the creator in the agent's config (UI or API) | Immutable at runtime — the agent cannot override it | User sets `dailyLossLimit: 500` → engine enforces a hard $500/day cap |
| **Operator default** | Read from `config.agentRiskDefaults.*` because the user did not specify a value | Agent-mutable — exposed to the agent as an adjustable parameter via tools | Default `maxOpenPositions: 10` from config → agent may raise or lower it within operator bounds |

Key invariants:
- **No hard-coded magic numbers.** Every default must come from operator config (`config/default.yaml → agentRiskDefaults`).
- **Transparency.** The agent must be able to read its effective risk limits.
- **User intent is supreme.** If the user explicitly configured a limit, the agent cannot weaken it.
- **Operator bounds.** Operator config may define a ceiling that neither user nor agent can exceed (e.g. `agentRiskDefaults.maxOpenPositions` = 50 as an absolute platform cap).

### Other Key Rules
- Do not apply bot blueprint risk defaults as constraints over agent decisions
- Do not add confirmation gates or approval steps to agent bot lifecycle actions
- An agent has full lifecycle authority over its own bots: create, start, stop, reconfigure, delete — no user confirmation required
- The engine risk gate still enforces hard safety invariants (malformed payloads, unauthorised access, unreconciled state, user-configured limits)

See [Agent Mode Purity](./docs/tech/agents/runtime-boundary-and-message-contract.md#agent-mode-purity) for the full specification.

## Best Practices

Before making changes, read all documents in `./docs/best-practices/`. Follow the patterns and guidelines described there.

Key principles:
- Prefer loud failure over silent degradation. A trading system that doesn't know it's broken is dangerous.
- Paper/shadow modes must simulate realistic costs (slippage + fees).
- Never assume token decimals — fetch and persist them. Fail if unknown.
- Migration files must match the Drizzle journal. Use `drizzle-kit generate`.
- Config flows through one resolved, typed object. Schema changes affect one resolution function.
- Apply cooldowns after forced exits (stop-loss, circuit breaker) before re-entry.

## Guides

- [General lessons](./docs/lessons/lessons-from-previous-project.md) — critical bugs from previous project
- [Rate limiting guide](./docs/lessons/rate-limiting-guide.md) — venue rate limit architecture
- [Configuration management](./docs/best-practices/configuration.md) — config layers and loading; avoid hard-coded literals unless they are genuinely internal and not user-facing
 - [Skill authoring guide](./docs/tech/agents/skill-authoring.md) — conventions for writing skills and a JSON template for `POST /skills`

## Rules

- Do not add dependencies without justification. Prefer standard library and existing deps.
- Do not commit secrets, API keys, or credentials. Use env var overrides.
- Do not bypass TypeScript strict checks (`any`, `@ts-ignore`, `as unknown as X`).
- Do not swallow errors. If you catch, either handle meaningfully or re-throw/log.
- Do not introduce circular package dependencies.
- LLM thinking or reasoning text must never enter stored conversation history, tool parsing, or user-visible output. Strip provider-specific thinking blocks at the `@herobids/llm` boundary and only persist visible text.
- Run `pnpm lint` before considering work complete — it must pass.
- Test names describe behavior, not implementation (`"rejects order when notional exceeds limit"`).
- Commits should be atomic and focused. One logical change per commit.

