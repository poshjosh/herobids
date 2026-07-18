# Notes: Platform Preset Assessment and Agent Strategy Transition

**Role:** Source notes and product-intent capture.
**Authority:** Not authoritative for implementation once [001-plan.md](./001-plan.md) and [002-decision-record.md](./002-decision-record.md) exist.

## Read With

- [001-plan.md](./001-plan.md) — root implementation plan
- [002-decision-record.md](./002-decision-record.md) — adopted phase-0 architectural and data-model decisions

1. Keep switching inside the current style tier. A careful agent can only switch to careful based strategy presets.

2. Make the switch decision based on regime plus performance, not regime alone.
A regime label by itself is too coarse. I would give the agent:

  - current regime and scan health
  - recent signal yield by preset
  - realized PnL / win rate / drawdown by preset and regime bucket
  - time since last switch
  - open position state

  That lets it answer a better question: not “is this trending?” but “is the current preset underperforming in this environment, and is another allowed preset materially better?”

3. Change the scanner-gated wake contract slightly.
This is the biggest product caveat. Scanner-gated agents currently suppress non-scanner market wakes, and regime changes are delivered as context-only for them in monitor.ts:700. The hybrid router also only routes scanner wakes through the single-shot evaluator in hybrid-agent-evaluator.ts:26. So a scanner-gated agent will not currently wake just because the market shifts from trending to ranging. I would not loosen that into “all regime changes wake the LLM.” I would instead extend the scanner path so a scan can emit a preset-review wake even when there is no entry signal, for example when:

  - the current preset is regime-incompatible
  - scan health is fine but signal yield has collapsed
  - recent preset performance is materially worse than an alternative allowed preset

  That preserves the existing scanner-gated model while giving the agent a reason to re-evaluate its preset.

4. Preserve creator-locked risk. The current API helper already treats explicit user stop loss and max position size as higher priority than preset defaults in agents.ts:268. The runtime switch tool must reuse that exact rule, or the agent will be able to weaken risk constraints by “switching presets.”

5. An agent with open positions can switch. Agents decide wether the switch should apply to only future positions.

  - The preset switch should define future entry behavior.
  - Open-position adjustments should be explicit position actions created as part of a transition.
  - The new preset should not silently retroactively re-interpret old positions.

  Generally:

  - Always allow tightening risk on existing positions.
  - Allow reducing size or taking partial exits.
  - Allow shortening max hold duration.
  - Do not allow widening stop loss, removing protection, or adding size to an existing losing position unless the creator explicitly enabled that class of transition.
  - Do not let a preset switch bypass user-configured hard limits.  

The agent could use a tool like `recommend_preset_transition` and `apply_preset_transition` which could do one of these:

- entries_only
- entries_and_tighten_existing
- entries_and_full_transition

6. Add hysteresis. Without min dwell time, max switches per day, and a “better by enough” threshold, the agent will thrash between range and momentum on noisy transitions.

7. Audit every switch. Persist old preset, new preset, regime snapshot, performance reason, and whether positions were open. You will need this later to tell good adaptation from random churn.

8. Start with allowed preset rotation, not arbitrary config mutation. The preset boundary is your safety rail.

9. The scanner layer remains dumb and deterministic. A platform assessor is the intelligent shared analyst. The actor agent remains the final decision-maker for its own account. In practice that means:

  - The shared scanner gathers evidence once for a segment such as Hyperliquid orderbook plus a style tier.
  - It computes deterministic inputs like regime, breadth, volatility, liquidity quality, signal yield, and dry-run scorecards for each allowed preset on the same snapshot.
  - It sends that evidence to one platform LLM agent.
  - The platform LLM agent ranks the presets for the current market and returns a cached assessment artifact.
  - Each actor later uses that shared artifact, together with its own local state, to decide whether to switch. 

10. The platform should decide whether and when to wake the actor agent. More precisely:

- The scheduler decides when an assessment runs.
For example: every 6 hours, per market segment, configurable.

- The scanner gathers evidence.
It does not decide in an intelligent sense. It just collects the deterministic inputs.

- The platform LLM agent analyzes the market and produces an assessment.
For example: ranked presets, confidence, explanation, urgency.

- A platform wake gate decides whether to wake actor agents.
This is the important part. I would not let the platform LLM directly wake agents on its own. It should recommend; the wake gate should enforce rules like:

  - minimum interval between review wakes
  - only wake if ranking changed materially
  - only wake if confidence is high enough
  - only wake agents whose current preset is now meaningfully worse
  - max wakes per day
  - segment/style match  
