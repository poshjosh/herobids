# Frontend - Q and A

## Prompt 1

Our vision is to bring the use of AI agents to the masses. How we implement our frontend should align with this vision.

Our first solution space for agentic use is crypto trading. We should design our UI first for agents, then for crypto trading.

For example before having a trading dashboard, we should consider first having an activity feed that conveys what the agent is doing; for example: when the agent makes profit or loss, which should be emphasized to denote an important event. 
For example trading dashboard should not be too intimidating with technical jargon. 

We acknowledge that the activity feed is not sufficient and cannot replace a trading dashboard. 

Is there any additional way to display trading info? Any alternatives?

## Response 1

Implementation note:

- Frontend work for agent activity, decision detail, health, and lifecycle should align to the canonical agent contract in [../../../../tech/agents/runtime-boundary-and-message-contract.md](../../../../tech/agents/runtime-boundary-and-message-contract.md) and [../../../../tech/agents/message-catalog.md](../../../../tech/agents/message-catalog.md), rather than inventing a separate UI-facing message model.

Yes. An activity feed is a good primary surface, but it should be only one of several surfaces. If the product is agent-first, the UI should answer three questions before it shows charts or jargon:

1. What is my agent trying to do?
2. What is it doing right now?
3. Is it helping me or hurting me?

For that reason, I would not make the trading dashboard the first mental model. I would make the first mental model an agent operating on the user's behalf, with trading data revealed through simpler views.

**Recommended UI model**

Use a small set of complementary surfaces instead of one dashboard:

1. **Agent Overview**
A single top-level summary card for each agent:
“Growing your BTC exposure conservatively”
“Paused due to volatility spike”
“Up 3.2% this week”
This gives users the purpose, current state, and outcome without making them parse market structure.

2. **Activity Feed**
Keep this. It is the best surface for showing behavior over time.
Good entries:
“Bought ETH because momentum strengthened across 3 timeframes”
“Reduced position after risk limit triggered”
“Daily result: +$42.10”
This makes the agent feel legible, which matters more than raw data for mainstream users.

3. **Outcome Board**
This is different from a feed. A feed says what happened; an outcome board says whether the agent is succeeding.
Show:
PnL
Win/loss trend
Capital at work
Risk level
Drawdown
Goal progress
This should feel like a scorecard, not a trader terminal.

4. **Portfolio / Exposure View**
Users still need to know what they currently hold and where risk sits.
Show:
Current positions
Exposure by asset
Cash available
Largest winner
Largest loser
This is more intuitive than a traditional order-centric dashboard.

5. **Decision Detail Drawer**
When users want depth, let them open a single event and see:
What the agent saw
What it decided
Why it decided it
What changed after
This preserves simplicity while still supporting trust and auditability.

6. **Health / Safety Strip**
Agentic UX needs visible safeguards.
Show:
Running / paused / needs input
Risk guard active
Execution venue
Alerts
Failures or degraded mode
This prevents the product from feeling magical in a bad way.

**Better alternatives to a traditional dashboard**

If you want something less intimidating than a trading dashboard, these are strong alternatives:

1. **Mission Control**
This is an agent control center, not a market terminal.
Focus on goals, status, actions, and exceptions.
This is probably the best fit for your vision.

2. **Daily Briefing / Report**
A generated summary:
“What your agent did today”
“What changed in your portfolio”
“What needs your attention”
This is very good for non-technical users who do not want to monitor continuously.

3. **Timeline / Story View**
Present trading as a story:
Observed opportunity
Entered position
Adjusted exposure
Hit stop
Took profit
This makes complex behavior understandable.

4. **Inbox / Notifications Model**
Important events appear as actionable messages:
“Agent paused because slippage exceeded limit”
“Profit target hit on SOL”
“Add funds to continue strategy”
This is useful because most users do not want to stare at dashboards.

5. **Goals and Constraints View**
For mass adoption, this may matter more than technical market metrics.
Show:
Target outcome
Allowed risk
Time horizon
Assets allowed
Autonomy level
This keeps the UI centered on user intent rather than trading mechanics.

**What I would recommend specifically**

If I had to choose a first version, I would build the product around these 4 surfaces:

1. Agent Overview
2. Activity Feed
3. Outcome Board
4. Portfolio / Exposure View

That combination gives:
narrative,
performance,
holdings,
and trust.

It is much stronger than either:
just a feed,
or a classic trading dashboard.

**What to avoid**

1. Leading with candlestick charts unless the product is explicitly targeting traders first.
2. Using exchange-native vocabulary too early: order book, leverage mode, maker/taker, routing, perp, liquidation price.
3. Making the user infer agent intent from raw actions.
4. Treating “dashboard” as the default homepage. For an agentic product, the homepage should feel like supervising an operator, not piloting the market manually.

**A useful framing**

Design the first screen like this:

- Top: “What your agent is doing”
- Middle: “How your money is doing”
- Bottom: “Why it acted” and “What changed”

That ordering is better aligned with your vision than:
market data first,
agent behavior second.

**Open questions worth resolving before designing**

1. Is the primary user a non-trader who wants outcomes, or a trader who wants delegation?
2. How much autonomy should feel visible versus abstracted away?
3. Should the main unit of organization be the user’s agent, portfolio, or strategy?
4. Do you want the UI to feel more like a copilot, an operator, or a financial app?

My recommendation is: make it feel like **an operator you supervise**, not **a bot you configure** and not **a terminal you manually trade from**.
