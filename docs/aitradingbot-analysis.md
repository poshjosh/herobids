## Prompt 1

What kind of performance do we analyse in this repo. List only, don't explain

## Response 1

- Backtest performance
- Portfolio performance
- Bot trading performance
- Agent trading performance
- Account-wide trading performance
- Playbook performance
- Strategy performance
- Session performance
- LLM model performance
- Token performance
- Exit-reason performance
- Daily performance
- Weekly performance
- Win/loss performance
- PnL performance
- Hold-time performance
- Drawdown performance
- Expectancy performance
- Profit-factor performance
- Sharpe-ratio performance
- Confidence performance

## Prompt 2

How are the listed performances analses done?

## Response 2

Most of them are done by the same analytics pipeline, not by separate feature-specific analyzers.

**Core Path**

Trade performance is computed from closed trades in the analytics engine: queries.ts:100, index.ts:10, aggregators.ts:3.
The engine filters trades by scope and attributes, then computes the metrics in types.ts:21 and types.ts:31.
The metrics are: total trades, wins, losses, win rate, total PnL, average PnL, average PnL %, average hold time, max drawdown, expectancy, profit factor, Sharpe ratio, and average confidence in aggregators.ts:55.

**How The Different Performance Types Are Done**
Bot performance: call analytics with botIds, or export a bot Performance Report via export.ts:173.
Agent performance: call analytics with agentIds plus the agent’s child botIds, or export via agent-export.ts:267.
Account-wide performance: call analytics with just userId, or export via export.ts:241.
Playbook performance: use groupBy: ['playbook'] via analytics.ts:116 and index.ts:42.
Strategy performance: use groupBy: ['strategy'] via index.ts:44.
Session performance: use groupBy: ['session'] via index.ts:46.
LLM model performance: use groupBy: ['llmModel'] via index.ts:48.
Token performance: use groupBy: ['token'] via index.ts:50.
Exit-reason performance: use groupBy: ['exitReason'] via index.ts:52.
Daily performance: use groupBy: ['day'] via index.ts:54.
Weekly performance: use groupBy: ['week'] via index.ts:56.
Win/loss, PnL, hold-time, drawdown, expectancy, profit-factor, Sharpe, and confidence performance are not separate systems; they are fields returned by the same aggregator in aggregators.ts:3.

**Where They’re Exposed**
Generic analytics API: analytics.ts:116 and analytics.ts:127.
Bot export UI “Performance Report”: ExportDropdown.tsx:15.
Agent export UI “Performance Report”: AgentExportDropdown.tsx:19.
Account export UI “Performance Report”: Settings.tsx:181.
Backtest AI narrative analysis: Backtests.tsx:202 -> backtests.ts:617.
Portfolio AI narrative analysis: backend route only at ai.ts:285.

One important distinction: most of the “performance types” I listed are either scopes or groupings over the same closed-trade analytics engine, while the backtest and portfolio features are LLM-generated narrative analyses layered on top.