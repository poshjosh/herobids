# Plan 3: Agent-First Experience

**Phase:** 3
**Status:** `not started`
**Depends on:** [Phase 1 — Foundation Cleanup](./001-plan-foundation-cleanup.md), [Phase 2 — Real Agent Runtime](./002-plan-real-agent-runtime.md)
**Roadmap:** [000-roadmap.md](./000-roadmap.md)

## Progress

| Step | Description | Status |
|---|---|---|
| 3.1 | Venue adapters expose `probe(credential)` | `not started` |
| 3.2 | Venue auto-detection at credential registration | `not started` |
| 3.3 | `create_bot` brokered tool implemented | `not started` |
| 3.4 | Goal-driven agent create flow (intent + review steps) | `not started` |
| 3.5 | Progress context injected into agent prompt each tick | `not started` |
| 3.6 | Skill preset UI on agent create | `not started` |
| 3.7 | Strategy preset UI on bot create | `not started` |
| 3.8 | No free-text symbol entry in default bot create | `not started` |
| 3.9 | `pnpm lint` passes, all tests pass | `not started` |

## Goal

Users describe what they want in plain language. Agents figure out the rest. No venue expertise, no symbol format knowledge, no strategy configuration required from the user.

## Context

The vision ([docs/vision.md](../../../vision.md)) states:

> "Make using AI-powered agents as simple as describing what you want. No expertise required, no infrastructure to manage — just idea/intention in, outcomes out."
>
> "Users don't need to understand the underlying systems."

The current product contradicts this in several places:
- Users must select a venue and enter a symbol string (e.g. `BTC-PERP`) when creating a bot
- Users must choose a strategy preset without guidance
- There is no path where a user says "grow this portfolio" and the system figures out the rest
- Agent presets are labelled with trading strategy names (`momentum_trader`)

This phase closes that gap.

---

## Deliverables

### 1. Venue Auto-Detection From Credentials

When a user provides a venue account credential (API key, wallet address), the platform should automatically:

1. Identify the venue type (orderbook vs swap, which chain/network)
2. Enumerate available instruments for that credential
3. Determine supported execution modes (paper, shadow, live)
4. Surface this information to the agent and to the user-facing create flow

**How:**
- `packages/venues/` adapters already exist for Hyperliquid and Jupiter. Extend them to expose a `probe(credential): VenueProfile` method that returns `{ venueType, supportedSymbols, executionModes }`.
- Call `probe` at venue account registration time and cache the result.
- When a user creates a bot (or an agent creates one autonomously), the venue profile drives the available options — no manual symbol entry needed.

Users should never need to know the difference between `BTC-USDC` and `BTC-PERP`. The platform resolves this from the venue profile.

### 2. Agent-Authored Bot Creation

An agent with the `trading` skill preset should be able to create a bot blueprint on the user's behalf when given a goal like "grow this portfolio conservatively."

**How:**
- Add a brokered tool: `create_bot` (capability tier: `brokered`, requires `trading` skill preset)
- `create_bot` accepts: `{ venueAccountId: string, strategyPreset?: string, blueprint: BlueprintConfig }`
- The broker resolves the venue profile, selects compatible instruments, and creates the bot
- The agent immediately starts the bot — no user confirmation step
- The agent notifies the user via `send_message` with a summary of what was created and why

Agents are autonomous. They do not request user permission before creating or starting bots. The user's guard rails (daily loss limit, max bots, execution mode) are the operative constraints — not a confirmation gate.

This is the primary creation path. The direct user-facing "Create Bot" flow remains for users who want manual control.

### 3. Goal-Driven Create Flow

Replace the current multi-field technical create form with a two-step flow:

**Step 1: Intent** — user provides:
- A free-text goal: "Grow my Solana portfolio conservatively over 30 days"
- A venue account (selected from their registered accounts, or add new)
- Optional: time horizon, risk tolerance (simple choices: conservative / moderate / aggressive)

**Step 2: Review** — platform shows what was inferred:
- Agent name and skill preset
- Venue detected from credentials (if provided)
- Execution mode (default: `paper` for new users)
- Guard rails summary (daily token budget, daily loss limit, max bots)

User adjusts if needed, then submits. The agent starts immediately — no separate "start" step required after creation.

The technical fields (symbol, strategy params, risk config) remain accessible under an "Advanced" toggle for power users and internal testing.

### 4. Progress Scoring In Agent Context

The agent prompt must include a progress section at each tick summarising:

- Net P&L (after deducting LLM cost and server/compute cost for this agent session)
- Goal progress relative to stated objective (e.g. "Target: +10% in 30 days. Current: +2.3% after 5 days.")
- A 0–10 performance score based on risk-adjusted returns
- Time remaining in the session (if time-bounded goal)

This gives the agent real feedback on whether its decisions are working.

**Implementation:**
- Add a `buildProgressContext(agentId, sessionId): ProgressContext` function called at each tick
- Query: net fills P&L from `fills` table, LLM cost from `llm_decision_artifacts` or a cost ledger, session elapsed time
- Inject into the system prompt tail before each LLM call

### 5. Skill Preset UI

The agent create flow must show skill-based presets with plain-language descriptions:

| Preset | User-facing label | Description |
|---|---|---|
| `trading` | Trading Agent | "Trades on your behalf within your constraints" |
| `reminder` | Reminder Agent | "Sends you scheduled updates and alerts" |
| `custom` | Custom | "Build your own capability bundle" |

The `custom` preset is deferred to a settings surface in MVP; the create flow only shows `trading` and `reminder`.

### 6. Strategy Preset UI On Bot Create

The bot blueprint create flow must show strategy presets with plain-language descriptions (not code names):

| Preset | User-facing label | Description |
|---|---|---|
| `momentum` | Follow the trend | "Buys when markets are moving up, sells when they turn" |
| `dca` | Steady accumulation | "Buys a fixed amount at regular intervals regardless of price" |
| `range` | Trade the range | "Buys low and sells high within a price band" |

These replace the raw `strategyId` / `config` fields as the primary input.

### 7. Remove Technical Venue/Symbol Exposure From Default User Flows

- No free-text symbol entry in default bot create — instrument is selected from a list derived from the venue profile
- No `venueType` selector in default bot create — derived from venue account credential
- No raw JSON config editor in default bot create — strategy preset populates config automatically
- All raw fields remain accessible under an "Advanced" toggle (for power users and internal testing)

---

## Open Questions

1. **Cost estimation:** How is daily cost estimated at bot creation time? We need a cost model per strategy preset, LLM model, and tick interval. Deferred to Phase 4 or a dedicated cost-modeling plan.

2. **Progress scoring formula:** The 0–10 score should be risk-adjusted. Sharpe ratio is the obvious candidate but requires enough history. For new sessions, fall back to a simpler P&L vs target calculation. Needs a spec before implementation.

---

## Exit Criteria

- [ ] Venue adapters expose `probe(credential)` returning venue type, instruments, and execution modes
- [ ] Venue auto-detection runs at credential registration; result cached and surfaced in bot create flow
- [ ] `create_bot` brokered tool implemented and registered for `trading` skill preset
- [ ] Goal-driven create flow implemented (intent step + review step)
- [ ] Progress context injected into agent prompt at each tick (P&L, goal progress, score)
- [ ] Agent create flow shows skill presets with plain-language labels
- [ ] Bot create flow shows strategy presets with plain-language labels
- [ ] No free-text symbol entry in default bot create flow
- [ ] All technical fields available under "Advanced" toggle
- [ ] `pnpm lint` passes

---

## Decision Log

Append-only. Record decisions made or changed during implementation, with date and reason.

| Date | Decision | Reason |
|---|---|---|
| 2026-06-04 | Agents create and start bots autonomously — no user confirmation gate | Agent mode purity: agents have full lifecycle authority over their own bots |
| 2026-06-04 | Agent infers venue from prompt/credentials; asks via send_message if ambiguous | Users should never need to know symbol formats or venue types |
