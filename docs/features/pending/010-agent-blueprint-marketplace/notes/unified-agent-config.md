
# UNIFIED AGENT CONFIG

Agents have a unified agent config. However, it is possible for it to be `null`. Strangely, the model is only used under certain conditions. Here's the full picture:

## What `unified_config` is

The `unified_config` column stores a structured JSON object of type `UnifiedAgentConfig`:

```typescript
{
  technical?: TechnicalConfig,      // indicators, regimes, weights
  intelligence?: IntelligenceConfig, // LLM-based analysis config
  execution?: { mode, positionSizeMode, fixedPositionSize },
  risk?: { maxPositions, maxPositionSizePct, ... }
}
```

It's the **canonical record of the unified agent form** — the dual-panel create/edit UI where you configure technical indicators, intelligence analysis, execution rules, and risk parameters together.

## When it gets written

In the agent create handler (agents.ts, line ~683–737):

```typescript
let finalUnifiedConfig: Record<string, unknown> | null = null;
if (parsed.data.technical) {
  // Explicit technical provided — use it, but preserve preset metadata
  finalUnifiedConfig = {
    ...(presetUnifiedConfig ?? {}),
    technical: parsed.data.technical,
  };
} else if (presetUnifiedConfig) {
  // No explicit technical, but a strategyPreset was given
  finalUnifiedConfig = presetUnifiedConfig;
}

// ...

...(finalUnifiedConfig ? { unifiedConfig: finalUnifiedConfig } : {}),
```

`unifiedConfig` is ONLY written when at least one of these is true at creation time:
1. **`technical`** was provided (explicit technical indicator config)
2. **`strategyPreset`** was provided (generates a preset-based unified config with technical+execution)

If **neither** is provided, `finalUnifiedConfig` stays `null` and the column is never set.

## Your agent `balanced-agent-2`

It was created with:
- `prompt`: "Send me an email with the weather details for today in Sachsen Anhalt, Germany"
- `style`: `balanced`
- **No** `technical` config
- **No** `strategyPreset`

So `unifiedConfig` being `NULL` is **expected and correct** — the agent was created via the simple form (name + prompt only), not the unified agent form. It's not a bug.

This agent is a non-trading personal assistant (just "email me the weather"). For that use case, unified config with technical indicators and risk parameters wouldn't make sense, so the system correctly left it null.