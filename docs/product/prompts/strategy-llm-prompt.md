# Strategy LLM Prompt

## Purpose

These are the prompts used by `packages/strategy/src/llm.ts` for `LlmStrategy`, which evaluates a single market snapshot and asks an LLM for a direct trading intent.

## Source

- `packages/strategy/src/llm.ts` - `buildPrompt(...)`
- `packages/strategy/src/llm.ts` - `callLlmProvider(...)` message assembly

## System Prompt

```text
You are a quantitative trading assistant. Respond with JSON only.
```

## User Prompt Template

```text
Analyze the following market data and provide a trading decision.

Symbol: {{symbol}}
Current Price: {{current_price}}
Timestamp: {{timestamp}}
{{if_additional_data}}Additional Data: {{snapshot_data_json}}

Respond with a JSON object containing:
- "intent": one of "go_long", "go_short", "go_flat", "hold"
- "confidence": a number between 0 and 1
- "reasoning": a brief explanation

Example: {"intent": "go_long", "confidence": 0.8, "reasoning": "Upward momentum detected"}
```

## Important Shape Details

- This prompt pair is simpler than the agent runtime prompts. It sends one system message and one user message only.
- The response parser accepts JSON wrapped in other text as long as a JSON object can be extracted.
- The parsed `reasoning` field may be stored in strategy decision metadata, but this is ordinary visible output, not provider-hidden thinking.