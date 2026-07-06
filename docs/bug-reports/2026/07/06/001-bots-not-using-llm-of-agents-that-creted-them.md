# Bug Report: Agent-created LLM bots do not inherit the creator agent's LLM configuration

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-07-06
- **Summary:** Bots created by agents with `decisionMode: 'llm'` or `decisionMode: 'hybrid'` do not inherit the creator agent's resolved LLM provider/model. Instead, bot strategy evaluation falls back to hardcoded defaults in the strategy layer, which caused 13,515 `strategy.error` events on production when the platform was configured for OpenRouter but the bot strategy defaulted to OpenAI.

## Impact

Observed in production:

| Bot ID | Symbol | Strategy | Decision Mode | Error Count |
|---|---|---|---|---:|
| `aba70a13-e885-4f26-b7ab-4f83bd8123fa` | `HYPE` | momentum | `llm` | 6,768 |
| `748562b9-addd-42aa-ba54-b8f6be14a523` | `MEME` | contrarian | `llm` | 6,753 |

All recorded bot `strategy.error` payloads had:

```text
code: strategy.llm_provider_error
message: No API key found for provider "openai"
```

The worker container had `LLM_API_KEY_OPENROUTER` configured, but not `LLM_API_KEY_OPENAI`.

## Root Cause

There is a configuration split between agent runtime LLM selection and bot strategy LLM selection.

### Agent runtime

Agent containers resolve their effective provider/model from the agent runtime config plus user defaults.

- [apps/worker/src/agent.ts](apps/worker/src/agent.ts)
- [packages/domain/src/llm-selection.ts](packages/domain/src/llm-selection.ts)

### Bot runtime

Bots persist a trading config with `strategy.type`, `strategy.decisionMode`, and `strategy.params`, but agent-created bots do not get the creator agent's resolved LLM provider/model stamped into that config.

- [apps/worker/src/agents/agent-message-broker.ts](apps/worker/src/agents/agent-message-broker.ts)
- [apps/worker/src/tools/bots.ts](apps/worker/src/tools/bots.ts)

The LLM strategy then falls back to hardcoded defaults:

- [packages/strategy/src/llm.ts](packages/strategy/src/llm.ts)

Current behavior:

```typescript
provider: (raw['provider'] as string) ?? 'openai'
model: (raw['model'] as string) ?? 'gpt-4'
```

That fallback is unsafe because it ignores the agent's actual resolved provider/model and can point the bot at a provider with no credentials configured.

## Desired Behavior

For **agent-created bots only**:

1. If bot `strategy.decisionMode` is `llm` or `hybrid`, the broker must stamp the creator agent's resolved LLM provider/model into the bot strategy config before persisting/starting the bot.
2. `create_bot` and `adjust_bot_config` should **not require** the agent to pass `provider` or `model` as tool arguments.
3. `adjust_bot_config` should preserve previously stamped `provider` and `model` unless the platform intentionally re-resolves them during the broker-managed update path.
4. The strategy layer must no longer silently fall back to `'openai'` / `'gpt-4'` when provider/model are missing.

For **non-agent-created bots**:

5. No inheritance behavior is required. This bug is specifically about `bots.creator_type = 'agent'`.

## Required Fix

### 1. Stamp agent LLM selection into agent-created bot configs

In the broker-managed `create_and_start` path, after venue stamping and before `BotConfigSchema` validation/persistence, inject the creator agent's resolved provider/model into `config.strategy.params` when the bot uses `llm` or `hybrid` decision mode.

Relevant code:

- [apps/worker/src/agents/agent-message-broker.ts](apps/worker/src/agents/agent-message-broker.ts)
- [packages/domain/src/llm-selection.ts](packages/domain/src/llm-selection.ts)

Required behavior:

- Resolve the effective provider/model from the creating agent's config.
- Use the agent's resolved heavy model for LLM bot decisions when available; otherwise fall back to its resolved light model.
- Persist the stamped values into the bot config so the bot is self-contained after creation.

### 2. Preserve stamped provider/model during `adjust_bot_config`

Agent-facing bot config tools should continue to omit `provider` / `model` from the public tool contract.

Relevant code:

- [apps/worker/src/tools/bots.ts](apps/worker/src/tools/bots.ts)

Required behavior:

- `create_bot` should not ask the agent for `provider` or `model`.
- `adjust_bot_config` should not ask the agent for `provider` or `model`.
- The merge/update path must not accidentally drop the previously stamped provider/model from `strategy.params`.

### 3. Remove unsafe strategy defaults

The LLM strategy config parser must stop silently defaulting to a provider/model that may not exist in platform config.

Relevant code:

- [packages/strategy/src/llm.ts](packages/strategy/src/llm.ts)

Required behavior:

- Missing provider/model must become a clear, structured strategy failure.
- Do not replace missing fields with hardcoded `'openai'` / `'gpt-4'`.

### 4. Halt bots on provider-misconfiguration loops

The bot strategy circuit breaker currently halts on `strategy.config_invalid` and `strategy.execution_error`, but not `strategy.llm_provider_error`.

Relevant code:

- [apps/worker/src/trading-actor.ts](apps/worker/src/trading-actor.ts)
- [config/default.yaml](config/default.yaml)

Required behavior:

- Add a dedicated threshold for `strategy.llm_provider_error`.
- Default threshold should be `1` consecutive failure.
- Emit `strategy.fatal` and stop the bot once the threshold is reached.

## Acceptance Criteria

1. Creating an `llm` or `hybrid` bot from an agent configured for `openrouter` persists `strategy.params.provider = 'openrouter'` and a non-empty model into the bot config.
2. The same bot no longer emits `strategy.llm_provider_error` because of an implicit fallback to `openai`.
3. `create_bot` and `adjust_bot_config` schemas do not require the agent to supply provider/model fields.
4. Adjusting unrelated bot config fields preserves the stamped provider/model.
5. If provider/model are absent in persisted bot config, strategy evaluation fails loudly with a structured error instead of silently defaulting.
6. Repeated `strategy.llm_provider_error` halts the bot after the configured threshold and emits `strategy.fatal`.
7. User-created bots are unaffected by the inheritance logic unless a separate feature explicitly adds that behavior.

## Suggested Tests

Add or update tests around these areas:

- [apps/worker/src/agents/agent-message-broker.ts](apps/worker/src/agents/agent-message-broker.ts)
  Verify `create_and_start` stamps provider/model into agent-created LLM bot configs.
- [apps/worker/src/tools/bots.ts](apps/worker/src/tools/bots.ts)
  Verify agent tool schemas do not expose provider/model as required input.
- [packages/strategy/src/llm.test.ts](packages/strategy/src/llm.test.ts)
  Verify missing provider/model produces a structured strategy failure instead of using hardcoded defaults.
- [apps/worker/src/trading-actor.ts](apps/worker/src/trading-actor.ts)
  Verify `strategy.llm_provider_error` triggers the fatal circuit breaker at threshold 1.

## Non-Goals

- Do not require agents to manually pass provider/model in `create_bot` or `adjust_bot_config`.
- Do not change user-created bot behavior as part of this fix.
- Do not solve unrelated venue symbol issues in the same change.

## Notes

- This fix should follow the same pattern already used for platform-managed bot fields like venue and venue type: the public tool contract stays minimal, and the broker stamps infrastructure-specific fields.
- The production incident was triggered specifically because the platform used OpenRouter while the bot strategy layer silently defaulted to OpenAI.