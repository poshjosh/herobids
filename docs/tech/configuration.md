# Configuration Reference

Practical reference for every config file — what it controls, where it lives, and when changes take effect.
For the design philosophy behind the two config layers, see [Best Practices: Configuration](../best-practices/configuration.md).

---

## File index

| File | Layer | Lifecycle | What it configures |
|---|---|---|---|
| `config/default.yaml` | Operator | Deploy/restart | DB, Redis, venue endpoints, risk ceilings, agent runtime policy, billing, auth, feature flags |
| `config/providers.yaml` | Operator | Deploy/restart | LLM provider registry (static model lists, pricing, catalog modes) |
| `config/strategy-presets/economy.yaml` | Operator | Deploy/restart | Strategy default parameters for careful-style agents |
| `config/strategy-presets/standard.yaml` | Operator | Deploy/restart | Strategy default parameters for balanced-style agents (fallback) |
| `config/strategy-presets/premium.yaml` | Operator | Deploy/restart | Strategy default parameters for bold-style agents |
| `config/development.yaml` | Operator | Deploy/restart | Per-env overrides merged over `default.yaml` |
| `config/production.yaml` | Operator | Deploy/restart | Per-env overrides (gitignored if contains secrets) |
| `config/staging.yaml` | Operator | Deploy/restart | Per-env overrides |
| `config/personal-assistant.yaml` | Operator | Deploy/restart | Preset for non-trading personal-assistant agents |
| Postgres `trading_instances.config` | Instance | Runtime | Per-instance strategy params, risk limits, execution mode set via API |

---

## Operator config files

### `config/default.yaml`

**The base layer.** Self-documenting with inline comments. Every operator-level setting lives here with its default value. Per-env YAMLs and env vars only override, never duplicate.

Resolution order: `default.yaml → config/{NODE_ENV}.yaml → env vars`

Key sections:
- `app` — port, log level
- `database` / `redis` — connection URLs and pool sizes
- `venues` — exchange/swap endpoint URLs, rate limits, timeouts
- `execution` — slippage defaults, order timeouts, retry counts
- `simulation` — paper/shadow fee and slippage parameters
- `risk` — global drawdown cap, open position limits
- `agentRiskDefaults` — operator ceilings for agent risk parameters
- `agentRuntime` — agent container policy (tool limits, sandbox, LLM budgets)
- `llm` — LLM provider, model, timeout, tick interval
- `marketData` — discovery source rate limits and configs
- `streams` — WebSocket reconnection policy
- `liveRollout` — fail-closed gating for live execution mode
- `auth` — JWT, Google OAuth
- `plans` — subscription plan definitions and entitlements
- `billing` — payment provider config (Stripe, Creem, mock)
- `usageBilling` — metering, rate cards, credit top-up products

### `config/providers.yaml`

LLM provider registry. Each provider has a `catalogMode`:
- `static` — models and pricing defined in the file (OpenAI, Anthropic, DeepSeek, Google)
- `dynamic` — models fetched at runtime (OpenRouter, Ollama)

Dynamic provider pricing is refreshed hourly into the `llm_pricing_snapshots` DB table.

### `config/strategy-presets/*.yaml`

Per-style strategy defaults. When an agent is created with a given style, the corresponding file provides the starting values for strategy parameters (stop loss, take profit, indicator configs, position sizing, etc.).

Style → file mapping:

| Agent style | Preset file |
|---|---|
| `careful` | `economy.yaml` |
| `balanced` | `standard.yaml` |
| `bold` | `premium.yaml` |
| (none / unknown) | `standard.yaml` (fallback) |

Each file contains all 7 strategy presets: `momentum`, `momentum-position`, `dca`, `range`, `swing`, `scalper`, `contrarian`.

These are **defaults**, not constraints. Users can override any parameter when creating a blueprint. The values are capital-agnostic — position sizes use `percent_equity` mode, not fixed USD amounts.

See [Agent Style Mapping](../../apps/web/src/features/agents/style-mapping.ts) for how styles map to runtime policy (tick interval, LLM budgets, weekend pause, etc.) — those are separate from strategy presets.

### `config/{development,production,staging}.yaml`

Environment-specific overrides. Only include values that differ from `default.yaml`. Production files should be gitignored if they contain environment secrets.

### `config/personal-assistant.yaml`

Blueprint preset for non-trading personal-assistant agents. Separate from the strategy presets since it does not involve trading parameters.

---

## Instance config

Stored in Postgres as JSONB on `trading_instances.config`. Validated by Zod at API write time. Changes notify the engine via Redis pub/sub, triggering a reload without restart.

```json
{
  "strategy": {
    "type": "momentum",
    "decisionMode": "mechanical",
    "params": { "stopLossPct": 3, "takeProfitPct": 8 }
  },
  "risk": { "maxPositionSizePct": 10 },
  "execution": { "mode": "paper" }
}
```

---

## Environment variable overrides

Any config path can be overridden via env var. Convention: uppercase, underscore-delimited, `CONFIG_` prefix for nested paths. Examples:

| Env var | Overrides |
|---|---|
| `DATABASE_URL` | `database.url` |
| `REDIS_URL` | `redis.url` |
| `AUTH_JWT_SECRET` | `auth.jwtSecret` |
| `GOOGLE_CLIENT_ID` | `auth.googleClientId` |
| `NODE_ENV` | Selects which per-env YAML to merge |

For the full list, check the inline comments in `config/default.yaml` — every field that supports env override is annotated with `# override: VAR_NAME`.

---

## Adding a new config field

1. Add the default value to `config/default.yaml`
2. Add the Zod schema in `packages/domain/src/config/schema.ts`
3. Add the TypeScript type to the relevant interface
4. If it's operator-level, validate at startup (`AppConfigSchema.parse`)
5. If it's instance-level, validate at API write time
6. Run `pnpm lint` to confirm types align
