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
- `agentRuntime` — agent container policy (tool limits, sandbox, LLM budgets), and `agentRuntime.peer` for agent-to-agent messages (see [Agent-to-agent messaging limits](#agent-to-agent-messaging-limits))
- `agentCreation` — rate limits, depth and API timeout for agent-created agents (see [Agent creation limits](#agent-creation-limits))
- `sharedServices` — shared Postgres and Redis hosts, and `apiBaseUrl`, the platform API URL that agent containers call
- `llm` — LLM provider, model, timeout, tick interval
- `marketData` — discovery source rate limits and configs
- `streams` — WebSocket reconnection policy
- `liveRollout` — fail-closed gating for live execution mode
- `auth` — JWT, Google OAuth
- `plans` — subscription plan definitions and entitlements (includes `childAgentLimitCeiling`, see [Agent creation limits](#agent-creation-limits))
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

---

## Agent creation limits

Agents can create child agents only when a user sets a child allowance on the agent. The settings below cap what an allowance can do. They live under `agentCreation` in `config/default.yaml` and are validated in `packages/domain/src/config/schema.ts`.

| Key | Default | Meaning |
|---|---|---|
| `agentCreation.agentCreateRatePerMinute` | `10` | Token bucket for `create_child_agent` attempts, per user across the whole agent tree. Every attempt uses a token, including refused ones. `0` refuses all attempts. |
| `agentCreation.creatorMessageRatePerMinute` | `10` | Token bucket per creator-child pair for messages the creator sends to a child. `0` refuses all of them. |
| `agentCreation.maxAgentDepth` | `6` | Max generations below a user-created agent. At this depth an agent cannot create children. |
| `agentCreation.duplicateChildWindowSeconds` | `300` | A `create_child_agent` whose name matches a direct child of the same parent, created within this many seconds, returns that child with `duplicate: true` and starts nothing. `0` disables the check. |
| `agentCreation.platformApiTimeoutMs` | `10000` | Timeout for each agent-container call to the platform API (create, allowance read, creator actions). Minimum `100`. |

The plan entitlement `childAgentLimitCeiling` sets the highest child allowance a user may set on an agent. It is set per plan under `plans.<plan>.entitlements.limits`, next to `maxAgents`. When unset, the ceiling is `max(0, maxAgents - 1)`, so no explicit value is needed to keep creation off. Child agents start with an allowance of `0`.

## Agent-to-agent messaging limits

Agents of one user can message each other with `message_peer_agent` (see [peer messaging tools](agents/tools/peer-messaging-tools.md)). The MVP has one send limit, and the keys below it tune how a receiving agent reads the owner's stop switch. All are set under `agentRuntime.peer` in `config/default.yaml` and validated in `packages/domain/src/config/schema.ts`.

| Key | Default | Meaning |
|---|---|---|
| `agentRuntime.peer.rateLimitPerMinute` | `10` | Peer messages one user's agents may send in any rolling minute, across all their agents. Over the limit, a send is refused with `peer.rate_limited` and recorded as refused. Minimum `1`. |
| `agentRuntime.peer.messageMaxChars` | `4000` | Longest peer message body. A longer one is refused with `peer.message_too_long` and not recorded. Minimum `1`, maximum `20000` (the protocol safety cap). |
| `agentRuntime.peer.switchCacheMs` | `2000` | How long a receiving agent reuses one read of the owner's stop switch, so a batch, or a wake and the tick after it, share one read. `0` reads every time. A newly set switch reaches a queued peer message at most this much later. Maximum `30000`. |
| `agentRuntime.peer.switchReadRetries` | `2` | Extra attempts to read the stop switch when a read fails, before the receiving agent drops the peer message fail closed (the thread row becomes `refused`, detail `paused_check_failed`). `0` drops on the first failure. Maximum `5`. |
| `agentRuntime.peer.switchRetryBackoffMs` | `250` | Wait between two attempts to read the stop switch. Maximum `5000`. |

The owner's stop switch is not operator config. It is a per-user setting (`users.peer_messaging_paused`, set on `PATCH /auth/me` as `peerMessagingPaused`).

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
| `SHARED_API_BASE_URL` | `sharedServices.apiBaseUrl`. Platform API URL that agent containers call (default `http://api:3000`). Remote Nomad nodes need the API's private address. |

For the full list, check the inline comments in `config/default.yaml` — every field that supports env override is annotated with `# override: VAR_NAME`.

---

## Adding a new config field

1. Add the default value to `config/default.yaml`
2. Add the Zod schema in `packages/domain/src/config/schema.ts`
3. Add the TypeScript type to the relevant interface
4. If it's operator-level, validate at startup (`AppConfigSchema.parse`)
5. If it's instance-level, validate at API write time
6. Run `pnpm lint` to confirm types align
