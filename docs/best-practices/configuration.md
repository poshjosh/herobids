# Configuration Management

## Two Config Layers

Configuration is split by lifecycle — never mixed into one resolution chain.

| | Operator config | User/instance config |
|--|----------------|---------------------|
| **What** | DB URLs, Redis, API port, log level, rate limits, feature flags, secrets refs | Strategy parameters, risk limits, venue preferences, execution mode |
| **When it changes** | Deploy/restart | Runtime (API call, no redeploy) |
| **Where it lives** | `config/default.yaml` + env var overrides | Postgres (`trading_instances.config` JSONB) |
| **Who sets it** | Operator/infrastructure | User/agent via API |
| **Validated** | At process startup (fail fast) | At write time via API (reject before engine sees it) |

---

## Operator Config

### File structure

```
config/
  default.yaml       ← checked into repo, self-documenting with inline comments
  production.yaml    ← optional per-env overrides (gitignored if contains secrets refs)
  test.yaml          ← test-specific overrides
```

### Resolution order (most specific wins)

```
default.yaml → config/{NODE_ENV}.yaml → environment variables
```

### Example

```yaml
# config/default.yaml
app:
  port: 3000
  logLevel: info             # debug | info | warn | error

database:
  url: postgres://localhost:5432/herobids   # override: DATABASE_URL
  poolMin: 2
  poolMax: 10

redis:
  url: redis://localhost:6379               # override: REDIS_URL

venues:
  hyperliquid:
    baseUrl: https://api.hyperliquid.xyz
    wsUrl: wss://api.hyperliquid.xyz/ws
    rateLimitPerSec: 10
    timeoutMs: 30000
  jupiter:
    baseUrl: https://quote-api.jup.ag/v6
    timeoutMs: 15000

execution:
  defaultSlippageBps: 50
  orderTimeoutMs: 30000
  maxRetries: 3

risk:
  globalMaxDrawdownPct: 20
```

### Loading

```typescript
// apps/worker/src/config.ts
import { readFileSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import { AppConfigSchema } from '@herobids/domain/config';

function loadConfig(): AppConfig {
  const base = parseYaml(readFileSync('config/default.yaml', 'utf8'));
  const envFile = `config/${process.env.NODE_ENV ?? 'development'}.yaml`;
  const envOverlay = existsSync(envFile) ? parseYaml(readFileSync(envFile, 'utf8')) : {};
  const merged = deepMerge(base, envOverlay);
  applyEnvOverrides(merged);  // DATABASE_URL → merged.database.url
  return AppConfigSchema.parse(merged);  // Zod: fail fast if invalid
}
```

### Schema (Zod collapses type + defaults + validation)

```typescript
// packages/domain/src/config/schema.ts
import { z } from 'zod';

export const VenueConfigSchema = z.object({
  baseUrl: z.string().url(),
  wsUrl: z.string().url().optional(),
  rateLimitPerSec: z.number().min(1).default(10),
  timeoutMs: z.number().min(1000).default(30_000),
});

export const AppConfigSchema = z.object({
  app: z.object({
    port: z.number().default(3000),
    logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  }),
  database: z.object({
    url: z.string(),
    poolMin: z.number().default(2),
    poolMax: z.number().default(10),
  }),
  // ...
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
```

---

## User/Instance Config

Stored in Postgres, loaded by the trading instance at startup:

```typescript
// In DB: trading_instances.config (JSONB)
{
  "strategy": {
    "type": "momentum",
    "params": { "lookbackPeriod": 14, "threshold": 0.02 }
  },
  "risk": {
    "maxPositionSizePct": 10,
    "stopLossPct": 5
  },
  "execution": {
    "mode": "live",
    "slippageBps": 30
  }
}
```

- Validated with Zod at API write time — invalid config never reaches the engine
- Read by trading instance at startup
- Config-change notification via Redis pub/sub triggers reload without restart

---

## Principles

1. **No magic numbers in business logic.** Any threshold, limit, interval, timeout, or policy that might change belongs in config.

2. **Sensible defaults for everything.** Zod `.default()` ensures a process can start with minimal config. Zero-config should yield reasonable behavior.

3. **One entry point: `getConfig()`.** Never read `process.env` outside the config loader. Never import defaults directly.

4. **Namespace by concern.** `venues.hyperliquid.rateLimitPerSec`, not `hyperliquidRateLimit`. Dot-path maps to YAML nesting.

5. **Descriptive names with units.** `timeoutMs`, `cacheTtlMs`, `maxCallsPerMinute` — never ambiguous `timeout`, `ttl`, `maxCalls`.

6. **`config/default.yaml` is the documentation.** Inline comments explain every value. No separate docs file to drift out of sync.

7. **Secrets never in YAML or env vars passed to containers.** Use secrets manager references. Decrypt just-in-time in the process that needs them.

---

## What to Make Configurable

| Always configurable | Usually not configurable |
|---|---|
| Timeouts, intervals, retry counts | Internal data structures |
| Rate limits and cache TTLs | Algorithm implementation details |
| External URLs and endpoints | Type definitions |
| Feature flags (enabled/disabled) | Error class hierarchies |
| Thresholds and limits | Module wiring / dependency injection |
| Policies (reject vs. warn, strict vs. lenient) | Internal buffer sizes |

---

## Anti-patterns

- **Hard-coding a value with a TODO.** Add it to config now. The cost is one line in the Zod schema.
- **Reading `process.env` in business logic.** Use the config loader.
- **Duplicating defaults at call sites.** `const timeout = cfg.timeout ?? 30000` — the default belongs in the Zod schema, not here.
- **Mixing operator and user config.** Don't merge deploy-time settings with per-instance parameters into one blob.
- **Over-configuring internals.** Not every constant needs config. Internal buffer sizes and log format strings stay as code constants unless there's a clear user need.
- **Passing full operator config to containers.** Agent containers get only what they need via the message contract.
- **Applying bot blueprint risk defaults as agent constraints.** When an agent is the actor, risk config fields in the bot blueprint are data the agent reasons over, not platform-enforced constraints. Never silently enforce a default stop-loss, position cap, or portfolio stop over an agent's decisions unless the user's goal explicitly specifies it. See [Agent Mode Purity](../tech/agents/runtime-boundary-and-message-contract.md#agent-mode-purity).
