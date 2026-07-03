## LLM Optimization Gap Analysis

### 🟡 Medium impact, medium effort — do this sprint

| # | Feature | What it does | Why we need it |
|---|---------|-------------|----------------|
| 1 | **Compact number formatting** | `1234567` → `"1.23M"`, `12345` → `"12.3K"`. Piped table format for market data instead of prose. | The user context payload is ~4K tokens. Compact formatting reduces this by ~30-40%. Market data tables (price, volume, liquidity) are the biggest offenders. |

### 🟢 Lower impact or already partially done — backlog

| # | Feature | Status | When |
|---|---------|--------|------|
| 2 | Memory entry truncation (`maxMemoryEntryChars`) | We have `maxToolResultChars: 4000` but no memory-specific truncation with `"... [read_memory for full]"` marker | When agents start using memory heavily |
| 3 | Older memory keys-only display | Not implemented | When memory key count grows past ~15 |
| 4 | Output `maxLength` constraints on reason fields | Not implemented — agent can emit 1,000-char rationales | When we see output token waste |
| 5 | `stripEmptyValues()` on LLM output | Not implemented | When we see parse failures from null/zero fields |