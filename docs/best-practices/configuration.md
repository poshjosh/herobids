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
  providers.yaml     ← LLM provider registry (static model lists, pricing, catalog modes)
  production.yaml    ← optional per-env overrides (gitignored if contains secrets refs)
  test.yaml          ← test-specific overrides
```

`config/providers.yaml` is part of the operator config layer — it defines which LLM providers
are available and their static pricing. Dynamic providers (e.g. OpenRouter) have their pricing
refreshed hourly into the `llm_pricing_snapshots` DB table by the worker.

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

### The External Backend registry (operator config)

An **External Backend** is a trust-gated service herobids reaches tools on
through a generic, transport-pluggable path (today: Traderton, the trading
backend). It is registered as **operator config** — `config/default.yaml →
externalBackends`, a map keyed by `backendId`, parsed into an
`ExternalBackendDefinition[]`. There is no backend-identity branch in code; a new
backend is added by adding a registry entry + publishing a signed descriptor
(see the [External Backend architecture overview](../tech/architecture/external-backend.md)).

```yaml
# config/default.yaml
externalBackends:
  traderton:
    enabled: true
    endpoint:
      baseUrl: http://localhost:8080        # override: TRADERTON_BOUNDARY_URL
      contractVersion: "1.0"                # 005 invocation envelope version
      protocol: rest                        # rest | mcp; mcp is development/test only (D19)
      # mcpPath: /internal/v1/mcp           # required when protocol (or an override) is mcp
      requestTimeoutMs: 10000               # override: TRADERTON_BOUNDARY_TIMEOUT_MS
    caller:
      consumerId: herobids                  # override: TRADERTON_BOUNDARY_CONSUMER_ID
      keyId: current                        # override: TRADERTON_BOUNDARY_KEY_ID
      hmacSecretRef: TRADERTON_BOUNDARY_HMAC_SECRET   # NAME of the env var holding the secret — never the secret
    trustedDescriptorSigningKeys:           # ed25519 PEM-SPKI keys that verify published descriptors
      - keyId: traderton-dev-1
        status: active                      # active | retiring (overlap-window rotation)
        publicKey: |
          -----BEGIN PUBLIC KEY-----
          ...
          -----END PUBLIC KEY-----
    approvedSourceSkillRefs:                # which skills.sh refs this backend may deep-integrate
      - traderton/skills/crypto-trading
    descriptorPinning:
      mode: maxAge                          # maxAge { seconds } | pinned { sha256 }
      seconds: 3600

tradingBackendId: traderton                 # the first-party binding used by the trading call sites
```

Field notes:
- **`hmacSecretRef` is the NAME of an env var, never the secret.** The loader
  resolves it from `process.env` (`resolveConfiguredExternalBackend`) and the
  secret stays out of `AppConfig`. The resolved `{ definition, hmacSecret }` is
  forwarded to the agent container as `EXTERNAL_BACKEND_CONFIG_JSON` (a container
  payload field, not an operator env var — see "Three Config Surfaces" below).
- **`trustedDescriptorSigningKeys`** are the operator's trust anchors: a backend
  publishes an ed25519-signed descriptor that is the sole authority for its tool
  schemas; herobids exposes a backend's tools only if the descriptor verifies
  against a trusted key, is unexpired, pins correctly, and matches the backend id
  (ADR 015/016). A trust failure degrades the skill to instruction-only, never a
  crash.
- **`protocol`** picks the invocation transport (`rest` default; `mcp` is
  dev/test only, D19). It is a config value, not a code branch — the client
  selects the transport generically behind an internal seam.
- The committed Traderton descriptor + its dev public key are regenerated as a
  set by `pnpm --filter @herobids/scripts run generate-dev-descriptor` (the
  private key is gitignored). A **real operator-held signing key** is a gated,
  post-deploy step — not a dev concern.

> **Env override limits.** `externalBackends` is a structured policy object, so
> only the leaf scalars that infra injects get env overrides
> (`TRADERTON_BOUNDARY_{URL,CONSUMER_ID,KEY_ID,TIMEOUT_MS}` → dotted paths under
> `externalBackends.traderton.*`). The registry shape, trust keys, approved refs
> and pinning live in YAML only (and the HMAC secret is referenced by name).

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

## Environment files — `.example` twins

Operator/deploy-time env inputs (secrets refs, infra URLs, provider keys) are supplied
via `.env*` files. **Real `.env*` files are gitignored; every `.env*` file has a committed
`.example` twin, and the `.example` is the source of truth.**

```
.env                     ← real values, gitignored (never committed)
.env.example             ← committed, self-documenting twin of .env
.env.ops.dev             ← real values, gitignored
.env.ops.dev.example     ← committed twin
```

The `.gitignore` enforces the mechanism:

```
.env
.env.*
!.env.example
!.env.ops.dev.example
!.env.ops.environment.example
```

(ignore all real `.env*`, then explicitly un-ignore each `.example`).

### Why

A newcomer (human or agent) can look at the committed `.example` files and immediately
know **which `.env` to create and exactly which keys it needs** — without reading the code
or leaking a secret. The `.example` is documentation that cannot drift silently, because the
rule below keeps it in lockstep with the code.

### The rule (authoring/implementing agents MUST follow)

- Every `.env*` file has a matching committed `.example` (same variable keys).
- `.example` values are **safe placeholders or blank** — never real secrets.
- Each variable gets a one-line `#` comment explaining what it is and whether it's required
  (put the comment on its own line — Docker Compose does not strip inline `#`).
- **When you ADD or CHANGE an env var, update the matching `.example` in the SAME change.**
  The `.example` must stay in lockstep with what the code reads (`process.env.*`).
- **When you introduce a NEW `.env` variant, create its `.example` immediately** and add a
  `!.env.<name>.example` un-ignore line to `.gitignore`.
- Scope: `.example` documents operator/deploy-time env inputs ONLY — not the instance/strategy
  config that lives in YAML (`config/*.yaml`) or Postgres JSONB. Keep the layers distinct so
  the `.example` never becomes a stale mirror of another source of truth.

### Why trading venue secrets (`HL_*`, `ONEINCH_PRIVATE_KEY`, `SOLANA_WALLET_PRIVATE_KEY`, …) still appear in herobids ops env

After the trading extraction, the trading engine + venue adapters live in **traderton**,
behind the REST boundary. So it is reasonable to ask why venue-account secrets like
`HL_API_KEY` / `HL_SECRET` / `HL_WALLET_ADDRESS` still show up in herobids'
`.env.ops.dev.example` / `.env.ops.environment.example`. Two distinct reasons — neither of which
means herobids *stores* or *owns* trading secrets:

1. **Test-runner / operator-onboarding INPUTS, not runtime config.** The `.env.ops.*` files
   feed the operator **scripts** (`scripts/ts/*-test.ts`, `scripts/shell/**`), not the
   herobids api/worker processes. Those scripts play the role of *a user onboarding a venue
   account*: they read the venue secret from the operator's env and submit it to the
   `POST /setup/provider-link` API, exactly as a real user would type it into the UI. The
   secret is a **client input to the onboarding call**, not something the herobids runtime
   reads from its own environment. (herobids api/worker read NO `HL_*` from env — verify:
   `rg "HL_API_KEY|HL_SECRET|HL_WALLET" apps packages -g '!*.test.ts'` → no hits.)

2. **herobids handles trading secrets only IN TRANSIT — the boundary owns encryption + storage.**
   The trading provider-link path (`apps/api/src/routes/setup.ts`, manual mode) canonicalises
   + validates the submitted secrets and then FORWARDS them to the traderton boundary's
   `provision_venue_account`, which encrypts (`CREDENTIAL_ENCRYPTION_KEY`) and stores them
   traderton-side. herobids does **not** encrypt or persist trading venue secrets locally.
   (The local `encryptCredential` in `setup.ts` is the NON-trading branch — Gmail/OAuth/
   telegram platform creds that are genuinely herobids-owned and never cross the trading
   boundary.) The `generate` mode is stronger still: traderton mints the keypair behind the
   boundary and returns only the public address — herobids never sees a private key.

Posture summary: herobids is a **validating courier** for manual venue onboarding (secret
passes through, boundary encrypts+stores); it is the **owner** only of non-trading platform
credentials. The `HL_*`-style vars in `.env.ops.*` are operator inputs to that onboarding
flow (and to the test scripts that exercise it), not herobids runtime secrets. If full
legal-isolation later requires that manual venue secrets never transit herobids at all (user →
boundary directly), that is a separate, deliberate architecture decision — record it in the
decision log before changing this flow.

### Format

```dotenv
# .env.example
# --- Database (required) ---
# Postgres connection string.
DATABASE_URL=postgres://user:pass@localhost:5432/dbname

# --- Secrets (required) ---
# Shared HMAC secret between herobids and the Traderton boundary; must match on both sides.
TRADERTON_BOUNDARY_HMAC_SECRET=changeme-shared-secret

# --- Optional integrations ---
# Scrapfly key for scraping. Optional; absent → the dependent feature degrades, not crashes.
SCRAPFLY_API_KEY=
```

## See also

- [Configuration Reference](../tech/configuration.md) — practical index of every config file, what it controls, and where to edit it

## Principles

1. **No magic numbers in business logic.** Any threshold, limit, interval, timeout, or policy that might change belongs in config.

2. **Sensible defaults for everything.** Zod `.default()` ensures a process can start with minimal config. Zero-config should yield reasonable behavior.

3. **One entry point: `getConfig()`.** Never read `process.env` outside the config loader. Never import defaults directly.

4. **Namespace by concern.** `venues.hyperliquid.rateLimitPerSec`, not `hyperliquidRateLimit`. Dot-path maps to YAML nesting.

5. **Descriptive names with units.** `timeoutMs`, `cacheTtlMs`, `maxCallsPerMinute` — never ambiguous `timeout`, `ttl`, `maxCalls`.

6. **`config/default.yaml` is the documentation.** Inline comments explain every value. No separate docs file to drift out of sync.

7. **In production, secrets go through a secrets manager — not env vars.** Use secrets manager references (e.g. AWS Secrets Manager, Vault). Decrypt just-in-time in the process that needs them. For local dev, `.env` passthrough via `${VAR:-}` in the service's `environment:` block is acceptable — but keep inline comments on their own line; Docker Compose does not strip inline comments and will pass the `#` text as the value.

8. **Required env vars must fail fast at process startup.** Any env var without a safe default must be validated at the top of the entry point and exit with a clear fatal log if absent — not discovered later on the first operation that needs it. Follow the pattern already used for `AGENT_ID` and `SESSION_ID` in the agent runtime.

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
- **Hard-coding a value that should be creator-controlled.** Expose it as explicit config or UI input now instead of burying it as a code literal.
- **Reading `process.env` in business logic.** Use the config loader.
- **Duplicating defaults at call sites.** `const timeout = cfg.timeout ?? 30000` — the default belongs in the Zod schema, not here.
- **Two homes for one tunable.** The scout/judge turn caps currently live both as operator config (`agentRuntime.llm.scout/judge.maxTurns`) and as per-agent style/instance defaults (`AGENT_STYLE_RUNTIME_DEFAULTS`), and the agent runtime overwrites the operator value with the instance value — so external operator config has no effect, inverting the intended precedence (operator config should beat hardcoded defaults; user overrides should beat operator config; all bounded by the ceiling). As a stopgap all tiers are aligned to the same near-ceiling values (scout 499 / ceiling 500; judge 9 999 / ceiling 10 000) so nothing is contradictory. The real fix (a single precedence-ladder resolver) is planned in [`docs/features/pending/000-runtime-turn-budget-precedence/001-plan.md`](../features/pending/000-runtime-turn-budget-precedence/001-plan.md).
- **Mixing operator and user config.** Don't merge deploy-time settings with per-instance parameters into one blob.
- **Over-configuring internals.** Not every constant needs config. Internal buffer sizes and log format strings stay as code constants unless there's a clear user need.
- **Passing full operator config to containers.** Agent containers get only what they need via the message contract.
- **Inferring config from data.** Never derive a provider, mode, or policy from data values (e.g. model name → LLM provider). Configuration must be explicit. If `LLM_PROVIDER` is absent, fail fast — do not guess.
- **Assuming `.env` values reach container processes.** Docker Compose reads `.env` for YAML variable substitution only. A value does not enter a container's environment unless it is declared in the service's `environment:` block (or `env_file:`). Use `${VAR:-}` passthrough entries for operator-supplied secrets that must reach spawned containers:

  ```yaml
  # docker-compose.yaml — worker service
  environment:
    LLM_PROVIDER: ${LLM_PROVIDER:-}
    LLM_API_KEY_OPENROUTER: ${LLM_API_KEY_OPENROUTER:-}
    # ...
  ```

  The `:-` syntax makes the entry optional (empty string if unset), which is falsy and safely skipped by conditional forwarding code.
- **Applying bot blueprint risk defaults as agent constraints.** When an agent is the actor, risk config fields in the bot blueprint are data the agent reasons over, not platform-enforced constraints. Never silently enforce a default stop-loss, position cap, or portfolio stop over an agent's decisions unless the user's goal explicitly specifies it. See [Agent Mode Purity](../tech/agents/runtime-boundary-and-message-contract.md#agent-mode-purity).

---

## Three Config Surfaces — Never Mix Them

| Surface | Home | Lifecycle |
|---|---|---|
| Operator config | `config/default.yaml` + `packages/domain/src/config/schema.ts` | Deploy/restart |
| Env overrides | `apps/worker/src/config.ts` `ENV_OVERRIDES` map | Deploy/restart — secrets and infra wiring only |
| Agent container payload | `apps/worker/src/index.ts` + `docker-agent-manager.ts` | Runtime, derived from resolved operator config |

**Schema presence does not imply env override support.** Not every operator-config field needs an env override. The burden of proof for a new env override is operational need, not schema existence.

**Env overrides are justified for:** secrets, deployment-specific scalars infra injects (URLs, ports, provider names), and existing scalar LLM runtime values already in the `ENV_OVERRIDES` map.

**Env overrides are not justified for:** structured policy objects (trading hours, market-data budgets, context diff policy, sandbox limits, retry backoff arrays). These belong in YAML.

**Container payload fields** (`TRADING_HOURS_JSON`, `MARKET_DATA_CONFIG_JSON`, `EXTERNAL_BACKEND_CONFIG_JSON`, `AGENT_CONFIG`, `TOOL_POLICY`, `AGENT_RUNTIME_CONFIG_JSON`) are internal worker-to-agent transport contract. `EXTERNAL_BACKEND_CONFIG_JSON` carries the resolved `{ definition, hmacSecret }` for the trading backend (the HMAC secret reaches the agent only here, never as an operator env var on the container). They are not operator env vars, must not appear in `docker-compose.yaml`, and must always be derived from resolved `appConfig` in `index.ts`.

**`docker-compose.yaml`** is infra wiring only: service URLs, Docker runtime wiring, and secret passthrough into worker. It is not a second home for structured operator policy.
