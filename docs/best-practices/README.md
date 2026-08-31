# Best Practices

Conventions and guidelines for the herobids codebase.

## Key principles

- Prefer loud failure over silent degradation. A trading system that doesn't know it's broken is dangerous.
- Paper/shadow modes must simulate realistic costs (slippage + fees).
- Never assume token decimals — fetch and persist them. Fail if unknown.
- Migration files must match the Drizzle journal. Use `drizzle-kit generate`.
- Config flows through one resolved, typed object. Schema changes affect one resolution function.
- Apply cooldowns after forced exits (stop-loss, circuit breaker) before re-entry.

## Subjects/Areas

- [Configuration Management](configuration.md) — config layers, naming, loading, anti-patterns
- [LLM Providers](llm-providers.md) — how to add/remove LLM providers via the provider registry
- [Shared-Wallet Accounting Boundary](shared-wallet-accounting-boundary.md) — authoritative records vs observational wallet telemetry
- [Agent Runtime](agent-runtime.md) — wake taxonomy, non-wakeable events, session circuit breaker, context snapshot discipline
- [Docker Conventions](docker.md) — shared Dockerfile, build targets, cache rules, agent image conventions