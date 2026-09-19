# Decision Brief B3: LLM-surface placement — which trading-adjacent intelligence stays in the platform brain?

- **Question:** Three platform-side LLM components carry trading semantics: (1) **base-skill trading tools** (`get_risk_limits` + `get_account_summary` in every agent's requiredTools — including non-trading agents), (2) the **hybrid evaluator** (single-shot LLM trade decisions + USD→base sizing policy), (3) **preset assessment** (market-intelligence assessor, billable). Do they stay as the platform "brain consuming trading capability", or are any of them trading logic that belongs behind the boundary?
- **Status:** ✅ **RATIFIED (2026-09-19) as [ADR 012](../../../../tech/architecture/adrs/2026/09/012-capability-scoped-llm-surface.md)** — the confirmed legal/compliance interpretation permits platform-side, non-enforcing agent reasoning. B4 is unblocked.
- **Evidence:** audit §5.2 (esp. item 4), §7-S1; skills.ts (`BASE_SKILL.requiredTools`), hybrid-agent-evaluator/prompt/sizing, market-intelligence/*.

## The framing that resolves it

The extraction's line was never "no trading intelligence in herobids" — it was "trading **execution and enforcement** behind the boundary; herobids is the generic agent brain that consumes capability". A decision is *thinking*; enforcement of it is *trading*. Under that line, ask each component: is this **thinking about trading** (stays) or **trading rules** (moves)?

## Component analysis

### 1. Base-skill trading read tools (every agent)

`BASE_SKILL.requiredTools` includes `get_risk_limits`/`get_account_summary`; a personal-assistant agent carries trading-account tools it can never use meaningfully. With A3 unfixed they're currently *broken tools* advertised to non-trading agents — the worst combination.
- **Options:** (a) remove both from base skill, add to TRADING_SKILL (and RISK_MONITORING where apt); (b) keep in base (availability to any agent is a feature); (c) keep + runtime-hide unless the agent has a trading capability family (visibility gate).
- **Recommendation: (a)** — with A3's fix, trading agents still get them via their skills; non-trading agents stop advertising dead surface. The `requiredTools` list is also load-bearing for skill dependency resolution, so the change is small but must be tested against the skill-assignment flows. Fallback if (a) is rejected: (c).

### 2. Hybrid evaluator + sizing policy

Single LLM call that *is* a trading decision (go_long/go_flat + sizeUsd), plus a USD→base sizing conversion (`hybrid-decision-sizing.ts`) and a per-position sizing-cap hint in the prompt. Enforcement stays traderton-side (payload → risk gate), so by the framing this is **thinking**: the platform decides *what it wants*; traderton decides *what it may do*. The sizing policy, though, is closer to the line — it's arithmetic that shapes order sizes.
- **Options:** (a) keep all of it (status quo); (b) keep the evaluator, move the USD→base conversion + sizing-cap policy behind the boundary (a `size_decision`-style tool or a submit_decision enrichment); (c) move the whole hybrid path behind the boundary (traderton gets its own LLM loop — rejected: violates "generic agent brain" and duplicates LLM plumbing).
- **Recommendation: (a) keep, with one honesty fix:** document `confidence`-and-sizing as platform *preference* signals that traderton's gate may clamp — they already are (the gate rejects oversized positions); no code move needed. Revisit only if traderton-side sizing rules ever conflict with the hint (they can't — gate wins).

### 3. Preset assessment subsystem

Billable per-symbol assessment (candle/ATR/liquidity evidence over the SYSTEM read boundary → deterministic scorecard + LLM ranker → artifacts). Evidence-gathering is boundary-served already; the *ranking* is platform product (users pay herobids for it). By the framing: thinking, stays. Its trading-identity data model (instrumentKind/venueFamily tables — audit §3.2) is B4's question, not B3's.
- **Recommendation: keep in herobids** — it's a platform monetization feature whose inputs are already external. The only trade-adjacent piece worth flagging: `strategy-presets` catalogs it reads (B2).

## Cascade

- (1a) removes trading tools from every non-trading agent's LLM surface → also resolves audit §7-S1 and shrinks the "generic agent" gap visibly.
- (2a) means hybrid path stays in Track A's regression scope (A8) as-is.
- (3) means B4 discusses only the *data tables and wake/blueprint edges*, not the assessor itself.

## Decision (2026-09-19)

**The recommendations are ratified as ADR 012.** The confirmed legal/compliance interpretation permits herobids to host generic agent reasoning that consumes a trading capability, but not execution, enforcement, or risk-gate authority.

1. Remove `get_risk_limits` and `get_account_summary` from the base skill; assign them only through trading-appropriate skills.
2. Keep the hybrid evaluator and its sizing preference in herobids. Its output remains non-binding; traderton validates, clamps, or rejects it.
3. Keep preset assessment in herobids as platform product intelligence. B4 decides the remaining data-model and blueprint boundaries.
