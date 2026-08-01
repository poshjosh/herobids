/**
 * Platform Docs Index — static searchable index of all platform documentation,
 * schemas, mappings, and terminology references.
 *
 * Generated at build time from:
 * - apps/web/src/features/public-pages/content/en/** /*.md
 * - CreateAgentSchema / UpdateAgentSchema (apps/api/src/routes/agents.ts)
 * - SKILL_PRESET_MAP (packages/domain/src/skills.ts)
 * - Venue/chain mapping (apps/web/src/features/agents/venue-mapping.ts)
 * - Agent style → defaults (apps/web/src/features/agents/style-mapping.ts)
 * - Connection types, execution modes, agent lifecycle, billing model
 * - UI terminology reference
 */

export interface DocsIndexEntry {
  /** Unique path identifier, e.g. "docs/agents/billing-limits" or "schema/CreateAgentSchema" */
  id: string;
  /** Human-readable title */
  title: string;
  /** Content type */
  kind: 'markdown' | 'schema' | 'mapping' | 'faq' | 'reference';
  /** Searchable plaintext content */
  content: string;
  /** Section headings extracted from content */
  headings: string[];
  /** Tags for filtering */
  tags: string[];
}

// ─── UI Terminology Reference ───────────────────────────────────────────────

const UI_TERMINOLOGY_ENTRY: DocsIndexEntry = {
  id: 'reference/ui-terminology',
  title: 'UI Terminology Reference',
  kind: 'reference',
  content: `
When referring to platform concepts in the chat UI, use these exact terms:

Agent presets (what the user is creating):
- "AI crypto trader" — autonomous trading agent (skillPresetId: trading)
- "AI direct trader" — manual-style trading agent (skillPresetId: direct-trading)
- "AI trading assistant" — advisory trading agent (skillPresetId: trading-assistant)
- "AI personal assistant" — task, email, and research agent (skillPresetId: personal-assistant)
- "Custom AI" — user selects skills manually (skillPresetId: custom)

Risk styles (how aggressive the agent is):
- "Careful" — lower risk, smaller positions, tighter stops
- "Balanced" — moderate risk, default settings
- "Bold" — higher risk, larger positions, wider stops

Execution modes:
- "Test mode" — simulated trading, no real money, safe to experiment
- "Live mode" — real trading with real funds

Chains (user-facing; map to venues internally):
- "Ethereum" or "Arbitrum" → Hyperliquid (perpetual futures)
- "Solana" → Jupiter (DEX spot/swaps)
- "Base" → 1inch (DEX spot/swaps)
- "BSC" → 1inch (DEX spot/swaps)
- "Any" → let the platform choose

Connection types:
- "Exchange connection" — for trading venues (Hyperliquid, etc.)
- "Wallet connection" — for DEX trading (Jupiter, 1inch, etc.)
- "Email connection" — for sending email on your behalf (Gmail, Outlook)
`,
  headings: ['Agent presets', 'Risk styles', 'Execution modes', 'Chains', 'Connection types'],
  tags: ['terminology', 'labels', 'ui', 'display-names'],
};

// ─── Schema Entries ─────────────────────────────────────────────────────────

const CREATE_AGENT_SCHEMA_ENTRY: DocsIndexEntry = {
  id: 'schema/CreateAgentSchema',
  title: 'Create Agent Schema',
  kind: 'schema',
  content: `
Fields for creating a new agent. All fields are optional unless noted.

name (string, required): The agent's display name. Must not be "all" or "*" (reserved for Telegram broadcast). Must be 1-200 characters.

prompt (string, optional, max 4000 chars): The agent's goal/prompt text. Required when no technical config is provided.

skillPresetId (enum, optional): Selects a preset skill bundle. Values:
- "trading" → AI crypto trader: bot-management + trading skills
- "direct-trading" → AI direct trader: trading skill only
- "trading-assistant" → AI trading assistant: trading skill only
- "personal-assistant" → AI personal assistant: task-management + web-access + email skills
- "custom" → Custom AI: user selects skills manually

skillIds (string[], optional): Manual skill selection. Used when skillPresetId is "custom".

style (enum, optional): Agent risk style. Values: "careful", "balanced", "bold".
- careful: costPreset=minimal, tickInterval=90min, dailySpend=$3/day
- balanced: costPreset=standard, tickInterval=30min, dailySpend=$10/day
- bold: costPreset=premium, tickInterval=10min, dailySpend=$30/day

executionMode (enum, optional): "paper" | "shadow" | "live" | "test".
- test: simulated trading, no real money
- paper: simulated with realistic fills
- shadow: paper trading alongside live data
- live: real trading with real funds

executionVenue (string, optional): The venue to execute trades on. Examples: "hyperliquid", "jupiter", "bybit", "1inch".

capital (string, optional): Starting capital amount as a decimal string (e.g. "1000.00").

dailyLossLimit (string, optional): Maximum daily realized loss as a decimal string.

maxDrawdownPct (number, optional, 0-100): Maximum peak-to-current drawdown percentage.

maxBots (number, optional, positive integer): Maximum number of bots this agent can create.

maxSlippageBps (number, optional, ≥0): Maximum slippage in basis points.

maxOpenPositions (number, optional, positive integer): Maximum concurrent open positions.

maxPositionSizePct (number, optional, 0-100): Maximum position size as percentage of equity.

stopLossPct (number, optional, 0-100): Default stop-loss percentage for positions.

stopLossCooldownMs (number, optional, ≥0): Cooldown after stop-loss trigger in milliseconds.

tickIntervalMs (number, optional, ≥1000): Agent tick interval in milliseconds.

strategyPreset (enum, optional): Trading strategy. Values: "momentum", "momentum-position", "range", "swing", "scalper", "contrarian".

connectionIds (string[], optional, max 20): Connection IDs to bind to this agent.

capabilityMode (enum, optional): "intelligence" (LLM-only) or "hybrid" (LLM + technical strategy). hybrid requires technical config or strategy preset.

authorizationMode (enum, optional): "direct" (execute immediately) or "approval_required" (requires user approval).

provider (string, optional): LLM provider name (e.g. "openrouter").

lightModel (string, optional): Scout/lightweight model ID.

heavyModel (string, optional): Judge/heavy model ID.

costPreset (enum, optional): "minimal" | "standard" | "premium". Controls cost tier.

dailySpendBudgetUsd (number, optional, positive): Daily LLM spend budget in USD.

dexWatchlistSymbols (string[], optional, max 25): DEX tokens to watch.

notificationPolicy (object, optional, nullable): Email notification settings.

platformAssessment (object, optional): Automated platform assessment settings.
  - enabled (boolean, optional): Enable periodic assessments.
  - reviewIntervalMs (number, optional): Assessment review interval.

runtimePolicyOverrides (object, optional): Per-field runtime policy overrides for the style defaults.

capabilityMode (enum, optional): "intelligence" | "hybrid".

hybridMode (object, optional): Hybrid mode configuration (only valid when capabilityMode is "hybrid").

openPositionEscalationToJudgePolicy (enum, optional): "never" | "uncovered_or_triggered" | "always".

wakePreferences (object, optional): Scheduled wake preferences for the agent.

telegramChatId (string, optional): Telegram chat ID for notifications.
`,
  headings: [
    'name', 'prompt', 'skillPresetId', 'skillIds', 'style',
    'executionMode', 'executionVenue', 'capital', 'dailyLossLimit',
    'maxDrawdownPct', 'maxBots', 'maxSlippageBps', 'maxOpenPositions',
    'maxPositionSizePct', 'stopLossPct', 'stopLossCooldownMs',
    'tickIntervalMs', 'strategyPreset', 'connectionIds',
    'capabilityMode', 'authorizationMode', 'provider', 'lightModel',
    'heavyModel', 'costPreset', 'dailySpendBudgetUsd',
    'dexWatchlistSymbols', 'notificationPolicy', 'platformAssessment',
    'runtimePolicyOverrides', 'hybridMode',
    'openPositionEscalationToJudgePolicy', 'wakePreferences', 'telegramChatId',
  ],
  tags: ['schema', 'agent', 'create', 'api', 'fields'],
};

const UPDATE_AGENT_SCHEMA_ENTRY: DocsIndexEntry = {
  id: 'schema/UpdateAgentSchema',
  title: 'Update Agent Schema',
  kind: 'schema',
  content: `
Fields for updating an existing agent. All fields are optional — only provided fields are updated.

name (string, optional): Update the agent's display name.
prompt (string, optional, max 4000 chars): Update the agent's goal/prompt.
style (enum, optional, nullable): Update agent risk style. Set to null to clear.
skillIds (string[], optional): Update skill assignments.
toolPolicy (object, optional): Update tool access policy.
modelPolicy (object, optional): Update model selection policy.
provider (string, optional): Update LLM provider.
lightModel (string, optional): Update scout/lightweight model.
heavyModel (string, optional): Update judge/heavy model.
costPreset (enum, optional): Update cost tier.
dailySpendBudgetUsd (number, optional): Update daily spend budget.
executionMode (enum, optional): Update execution mode.
executionVenue (string, optional): Update execution venue.
dailyLossLimit (string, optional): Update daily loss limit.
maxDrawdownPct (number, optional): Update max drawdown.
maxBots (number, optional): Update max bots limit.
maxSlippageBps (number, optional): Update max slippage.
maxOpenPositions (number, optional): Update max open positions.
maxPositionSizePct (number, optional): Update max position size.
stopLossPct (number, optional): Update stop-loss percentage.
stopLossCooldownMs (number, optional): Update stop-loss cooldown.
tickIntervalMs (number, optional): Update tick interval.
capital (string, optional): Update capital amount.
strategyPreset (enum, optional): Update strategy preset.
connectionIds (string[], optional): Update bound connections.
authorizationMode (enum, optional): Update authorization mode.
capabilityMode (enum, optional): Update capability mode.
openPositionEscalationToJudgePolicy (enum, optional): Update escalation policy.
platformAssessment (object, optional): Update assessment settings.
runtimePolicyOverrides (object, optional): Update runtime policy overrides.
wakePreferences (object, optional): Update wake schedule.
notificationPolicy (object, optional): Update notification settings.
dexWatchlistSymbols (string[], optional): Update DEX watchlist.
telegramChatId (string, optional): Update Telegram chat ID.
hybridMode (object, optional): Update hybrid mode config.
`,
  headings: [
    'name', 'prompt', 'style', 'skillIds', 'executionMode', 'executionVenue',
    'capital', 'dailyLossLimit', 'maxDrawdownPct', 'maxBots', 'maxSlippageBps',
    'maxOpenPositions', 'maxPositionSizePct', 'stopLossPct', 'stopLossCooldownMs',
    'tickIntervalMs', 'strategyPreset', 'connectionIds', 'authorizationMode',
    'capabilityMode', 'costPreset', 'dailySpendBudgetUsd',
    'openPositionEscalationToJudgePolicy', 'platformAssessment',
    'runtimePolicyOverrides', 'wakePreferences', 'notificationPolicy',
  ],
  tags: ['schema', 'agent', 'update', 'api', 'fields'],
};

// ─── Skill Preset Mapping ───────────────────────────────────────────────────

const SKILL_PRESET_ENTRY: DocsIndexEntry = {
  id: 'mapping/skill-presets',
  title: 'Skill Preset to Skill Mapping',
  kind: 'mapping',
  content: `
When a user selects a preset in the UI, these are the skills assigned:

trading (AI crypto trader):
  - bot-management: Create, start, stop, and monitor trading bots
  - trading: Submit trade decisions and inspect trading state

direct-trading (AI direct trader):
  - trading: Submit trade decisions and inspect trading state

trading-assistant (AI trading assistant):
  - trading: Submit trade decisions and inspect trading state

personal-assistant (AI personal assistant):
  - task-management: Create, track, and complete tasks; schedule reminders
  - web-access: Search the internet, read web pages, fetch documents
  - email: Send emails on behalf of the user

custom (Custom AI):
  - No preset skills; user selects skills manually

Available skills (all public):
  - base: Core tools (memory, messaging, cost, schema) — auto-injected
  - bot-management: Bot lifecycle management
  - trading: Direct trade decisions and state inspection
  - risk-monitoring: Watch positions and alert on drawdowns
  - programming: Code execution (JS/Python)
  - file-management: Per-agent workspace file operations
  - web-access: Internet search, URL reading, document fetching
  - task-management: Durable task tracking and reminders
  - email: Send emails on user's behalf
  - platform-docs: Search and read platform documentation and schemas
`,
  headings: ['trading', 'direct-trading', 'trading-assistant', 'personal-assistant', 'custom', 'Available skills'],
  tags: ['skills', 'presets', 'mapping', 'configuration'],
};

// ─── Venue/Chain Mapping ────────────────────────────────────────────────────

const VENUE_CHAIN_ENTRY: DocsIndexEntry = {
  id: 'mapping/venue-chain',
  title: 'Chain to Venue Mapping',
  kind: 'mapping',
  content: `
User-facing chain names map to backend venues:

Chain → Venue (type):
- Ethereum → hyperliquid (orderbook/perpetual futures)
- Arbitrum → hyperliquid (orderbook/perpetual futures)
- Solana → jupiter (swap/DEX spot)
- Base → 1inch (swap/DEX spot)
- BSC → 1inch (swap/DEX spot)
- Bybit → bybit (orderbook/perpetual futures)

"Any" → let the platform choose the best venue.

Venue types:
- orderbook: Central limit order book (Hyperliquid, Bybit) — used for perpetual futures
- swap: DEX aggregator (Jupiter, 1inch) — used for spot token swaps
`,
  headings: ['Chain to Venue', 'Venue types'],
  tags: ['venues', 'chains', 'mapping', 'trading'],
};

// ─── Agent Style Defaults ───────────────────────────────────────────────────

const AGENT_STYLE_ENTRY: DocsIndexEntry = {
  id: 'mapping/agent-styles',
  title: 'Agent Style Defaults',
  kind: 'mapping',
  content: `
Risk styles determine default agent behavior. The user picks a style; the platform fills in defaults.

Careful:
  - costPreset: minimal
  - tickInterval: 90 minutes
  - dailySpendBudget: $3/day
  - openPositionEscalationToJudgePolicy: never
  - scoutMaxTurns: 10, judgeMaxTurns: 25
  - scoutMaxTokens: 512, judgeMaxTokens: 2,048
  - allowedHoursUtc: 14-20 (US market hours)
  - weekendPause: false
  - maxHoldDuration: 450 minutes (7.5 hours)

Balanced:
  - costPreset: standard
  - tickInterval: 30 minutes
  - dailySpendBudget: $10/day
  - openPositionEscalationToJudgePolicy: uncovered_or_triggered
  - scoutMaxTurns: 30, judgeMaxTurns: 75
  - scoutMaxTokens: 1,024, judgeMaxTokens: 4,096
  - allowedHoursUtc: all (24/7)
  - weekendPause: false
  - maxHoldDuration: 90 minutes (1.5 hours)

Bold:
  - costPreset: premium
  - tickInterval: 10 minutes
  - dailySpendBudget: $30/day
  - openPositionEscalationToJudgePolicy: always
  - scoutMaxTurns: 100, judgeMaxTurns: 300
  - scoutMaxTokens: 2,048, judgeMaxTokens: 8,192
  - allowedHoursUtc: all (24/7)
  - weekendPause: false
  - maxHoldDuration: 30 minutes
`,
  headings: ['Careful', 'Balanced', 'Bold'],
  tags: ['styles', 'risk', 'defaults', 'configuration'],
};

// ─── Connection Types ───────────────────────────────────────────────────────

const CONNECTION_TYPES_ENTRY: DocsIndexEntry = {
  id: 'reference/connection-types',
  title: 'Connection Types',
  kind: 'reference',
  content: `
Connection types determine what an agent can do:

Exchange connection (type: trading, venueType: orderbook):
  - Used for centralized exchange trading (Hyperliquid, Bybit)
  - Provides API key + secret authentication
  - Allows: submit_decision, list_positions, get_market_overview
  - Required for: perpetual futures trading

Wallet connection (type: trading, venueType: swap):
  - Used for DEX trading (Jupiter, 1inch)
  - Provides wallet address + signature authentication
  - Allows: submit_decision, list_positions, swap execution
  - Required for: spot token swaps on DEXs

Email connection (type: email):
  - Used for sending email on the user's behalf
  - Providers: Gmail (OAuth), Outlook (OAuth)
  - Allows: send_email
  - Required for: email delivery of agent messages

Binding requirements:
- An agent must have at least 1 trading binding to use trading tools
- An agent must have at least 1 email binding to use send_email
- Bindings must be in "ready" state for the agent to use them
`,
  headings: ['Exchange connection', 'Wallet connection', 'Email connection', 'Binding requirements'],
  tags: ['connections', 'trading', 'email', 'authentication'],
};

// ─── Execution Modes ────────────────────────────────────────────────────────

const EXECUTION_MODES_ENTRY: DocsIndexEntry = {
  id: 'reference/execution-modes',
  title: 'Execution Modes',
  kind: 'reference',
  content: `
Execution modes control whether trading is simulated or real:

test (Test mode):
  - Simulated trading, no real money
  - Safe to experiment with
  - No real orders sent to venues
  - Recommended for: learning, testing strategies, onboarding

paper (Paper mode):
  - Simulated trading with realistic fills
  - No real money at risk
  - Orders are simulated with real market data
  - Recommended for: strategy validation before going live

shadow (Shadow mode):
  - Paper trading alongside live data
  - Tracks what would have happened if orders were real
  - No real money at risk
  - Recommended for: comparing strategy performance against live

live (Live mode):
  - Real trading with real funds
  - Orders are sent to venues and executed
  - Real P&L, real risk
  - Recommended for: production trading

Note: Users should start with "test" mode and only switch to "live" after validating their strategy.
`,
  headings: ['test', 'paper', 'shadow', 'live'],
  tags: ['execution', 'modes', 'trading', 'risk'],
};

// ─── Agent Lifecycle ────────────────────────────────────────────────────────

const AGENT_LIFECYCLE_ENTRY: DocsIndexEntry = {
  id: 'reference/agent-lifecycle',
  title: 'Agent Lifecycle',
  kind: 'reference',
  content: `
Agents operate on a tick-based lifecycle:

1. Created: Agent is defined with a goal, skills, and configuration. Not yet active.
2. Running: Agent ticks at its configured interval. Each tick:
   a. Wake: Agent receives context (market data, positions, costs, messages)
   b. Scout: Lightweight reasoning phase — observes and gathers information
   c. Judge: Heavy reasoning phase — makes decisions and takes actions
   d. Sleep: Agent waits until next tick interval
3. Paused: Agent stops ticking but retains all state (positions, memory, bots). Can be resumed.
4. Stopped: Agent is fully stopped. All bots stopped. State preserved. Can be restarted.

Agent states:
- idle: Created but not yet started
- running: Actively ticking
- paused: Temporarily suspended (bots remain active, agent doesn't tick)
- stopped: Fully stopped (bots stopped, agent doesn't tick)
- error: Encountered an unrecoverable error

Lifecycle actions:
- Start: Transitions from idle → running
- Pause: Transitions from running → paused
- Resume: Transitions from paused → running
- Stop: Transitions from any active state → stopped
- Restart: Transitions from stopped → running

Bots share the agent's lifecycle but can be independently started/stopped while the agent runs.
`,
  headings: ['Lifecycle phases', 'Agent states', 'Lifecycle actions'],
  tags: ['lifecycle', 'agent', 'states', 'tick'],
};

// ─── Billing Model ──────────────────────────────────────────────────────────

const BILLING_MODEL_ENTRY: DocsIndexEntry = {
  id: 'reference/billing-model',
  title: 'Billing Model Overview',
  kind: 'reference',
  content: `
The platform charges based on usage:

LLM costs:
- Charged per token (input + output) at the provider's rate
- Controlled by costPreset (minimal/standard/premium) and dailySpendBudgetUsd
- Cost tracking is per-agent, visible in real-time

Runtime costs:
- Agent runtime is metered per millisecond
- Charged only while the agent is in "running" state

Billing controls:
- dailySpendBudgetUsd: Hard cap on daily LLM spend per agent
- costPreset: Controls which models are used (economy vs premium)
  - minimal: Uses cheapest available models
  - standard: Uses balanced cost/performance models
  - premium: Uses best available models (higher cost)
- maxBots: Limits concurrent bot count (runtime cost multiplier)

Protective exits:
- If dailySpendBudgetUsd is exhausted, the agent pauses automatically
- If dailyLossLimit is breached, trading is suspended
- If maxDrawdownPct is exceeded, all positions are closed

Viewing costs:
- get_account_summary includes current spend
- Cost context is provided to the agent each tick
- Runtime billing is tracked in the billing_usage table
`,
  headings: ['LLM costs', 'Runtime costs', 'Billing controls', 'Protective exits', 'Viewing costs'],
  tags: ['billing', 'costs', 'spend', 'limits'],
};

// ─── Markdown Docs ──────────────────────────────────────────────────────────

const MARKDOWN_DOCS: DocsIndexEntry[] = [
  {
    id: 'docs/agents/index',
    title: 'Understanding AI Agents',
    kind: 'markdown',
    content: `
AI agents are autonomous digital workers that can trade crypto, manage tasks, send emails, and more. Each agent has a goal (prompt), a set of skills (tools), and configuration (risk limits, budget, execution mode).

Agents operate on a tick-based cycle: wake, observe, decide, act, sleep. The tick interval determines how often the agent checks in — from every few minutes for active traders to every few hours for monitoring agents.

Key concepts:
- Skills determine what an agent can do (trade, email, search web, etc.)
- Presets bundle skills for common use cases (AI crypto trader, AI personal assistant)
- Style controls risk tolerance and cost profile (Careful, Balanced, Bold)
- Execution mode controls real vs simulated trading (Test, Live)
- Connections grant access to venues and services (exchanges, wallets, email)
`,
    headings: ['Key concepts'],
    tags: ['agents', 'overview', 'concepts'],
  },
  {
    id: 'docs/agents/agent-style',
    title: 'Agent Style & Risk Profiles',
    kind: 'markdown',
    content: `
Agent style determines the default risk profile and cost tier. Choose from three styles:

Careful: Lower risk, smaller positions, tighter stops. Best for conservative traders or beginners. Uses minimal cost preset with $3/day budget.

Balanced: Moderate risk with default settings. Best for most users. Uses standard cost preset with $10/day budget.

Bold: Higher risk, larger positions, wider stops. Best for experienced traders. Uses premium cost preset with $30/day budget.

Each style also affects:
- How often the agent ticks (90min / 30min / 10min)
- Maximum trading turns per tick
- Token budgets for LLM reasoning
- Whether positions escalate to the judge phase
- Maximum position hold duration
`,
    headings: ['Careful', 'Balanced', 'Bold'],
    tags: ['agents', 'style', 'risk', 'cost'],
  },
  {
    id: 'docs/agents/billing-limits',
    title: 'Billing & Usage Limits',
    kind: 'markdown',
    content: `
Billing is usage-based. You pay for:
- LLM tokens consumed by your agents (input + output)
- Agent runtime (metered per millisecond)

Controls:
- dailySpendBudgetUsd caps daily LLM spend per agent
- costPreset selects the model tier:
  - minimal: economy models, lowest cost
  - standard: balanced models
  - premium: best models, highest cost

Protective exits prevent runaway costs:
- Agent pauses when daily spend budget is exhausted
- Trading suspends when daily loss limit is breached
- All positions close when max drawdown is exceeded

Monitor costs via get_account_summary or the dashboard.
`,
    headings: ['Controls', 'Protective exits'],
    tags: ['billing', 'costs', 'limits', 'agents'],
  },
  {
    id: 'docs/messaging/index',
    title: 'Messaging & Notifications',
    kind: 'markdown',
    content: `
Agents can communicate with you through multiple channels:

- In-app messages: Sent via send_message, appear in the chat UI
- Email: Sent via send_email, delivered to any recipient
- Telegram: Notifications sent to a configured Telegram chat
- Artifacts: Structured outputs (reports, charts) published for review

Message classes:
- routine: Standard informational messages
- alert: Urgent notifications requiring attention
- reminder: Scheduled reminders from task management

Configure notification preferences per agent via notificationPolicy.
`,
    headings: ['Message classes'],
    tags: ['messaging', 'notifications', 'email', 'telegram'],
  },
  {
    id: 'docs/messaging/telegram/slash-commands',
    title: 'Telegram Slash Commands',
    kind: 'markdown',
    content: `
Telegram slash commands for interacting with your agents:

/status — Get current agent status
/positions — List open positions
/analytics — View trading performance
/pause — Pause the agent
/resume — Resume the agent
/stop — Stop the agent
/help — Show available commands

Commands are sent to the agent's configured Telegram chat.
`,
    headings: [],
    tags: ['telegram', 'commands', 'messaging'],
  },
  {
    id: 'docs/messaging/telegram/reply-threading',
    title: 'Telegram Reply Threading',
    kind: 'markdown',
    content: `
Messages in Telegram are threaded by conversation context. Reply threading ensures:
- Agent responses appear in the correct conversation thread
- Multiple agents in the same chat don't interfere
- Context is preserved across messages

Technical: Each message includes a contextRef linking it to the originating conversation.
`,
    headings: [],
    tags: ['telegram', 'threading', 'messaging'],
  },
  {
    id: 'help/get-started',
    title: 'Getting Started',
    kind: 'markdown',
    content: `
Welcome to the platform! Here's how to get started:

1. Create a connection: Add an exchange connection (for trading) or wallet connection (for DEX trading)
2. Create an agent: Choose a preset (AI crypto trader is the most popular) and configure your preferences
3. Configure your agent: Set a goal, choose a style (Careful/Balanced/Bold), and set your budget
4. Start in test mode: Always begin with test mode to validate your strategy
5. Monitor and adjust: Watch your agent's performance and tweak settings as needed

Tips:
- Start small — use test mode and minimal budgets until you're comfortable
- Use the AI personal assistant preset for non-trading tasks
- Check the FAQs for common questions
`,
    headings: ['Tips'],
    tags: ['getting-started', 'onboarding', 'guide'],
  },
  {
    id: 'help/faqs',
    title: 'Frequently Asked Questions',
    kind: 'faq',
    content: `
Q: What is an AI agent?
A: An AI agent is an autonomous digital worker that can trade crypto, manage tasks, send emails, and more based on a goal you provide.

Q: Is my money safe?
A: In test mode, no real money is used. In live mode, the agent only trades with the capital you allocate. Risk limits (stop-loss, max drawdown, daily loss limit) protect your funds.

Q: How much does it cost?
A: You pay for LLM tokens consumed and agent runtime. Daily spend is capped by your dailySpendBudgetUsd setting. Typical costs range from $1-30/day depending on style and activity.

Q: What venues are supported?
A: Hyperliquid (perpetual futures on Ethereum/Arbitrum), Jupiter (spot swaps on Solana), 1inch (spot swaps on Base/BSC), and Bybit (perpetual futures).

Q: Can I have multiple agents?
A: Yes, you can create as many agents as you need. Each has its own configuration, budget, and state.

Q: What happens if my agent loses money?
A: Protective exits pause trading when daily loss limits or max drawdown thresholds are hit. You remain in control of risk limits.

Q: Can I use my own LLM provider?
A: Yes, you can configure a custom provider and model selection per agent.
`,
    headings: [],
    tags: ['faq', 'help', 'common-questions'],
  },
  {
    id: 'help/pricing',
    title: 'Pricing',
    kind: 'markdown',
    content: `
Platform pricing is usage-based:

LLM tokens: Charged per 1M tokens at the provider's rate. Controlled by your costPreset and dailySpendBudgetUsd.

Agent runtime: Metered per millisecond while the agent is running. Billed at a flat rate.

Cost tiers (costPreset):
- minimal: ~$0.20-0.40/1M input tokens, ~$0.80-1.60/1M output tokens
- standard: ~$0.40-0.80/1M input tokens, ~$1.60-3.20/1M output tokens
- premium: ~$0.80-2.00/1M input tokens, ~$3.20-8.00/1M output tokens

Daily spend estimates by style:
- Careful: ~$1-3/day
- Balanced: ~$5-10/day
- Bold: ~$15-30/day

Actual costs vary based on market activity, number of tools called, and reasoning depth.
`,
    headings: ['Cost tiers', 'Daily spend estimates'],
    tags: ['pricing', 'costs', 'billing'],
  },
  {
    id: 'help/trading-venues/index',
    title: 'Trading Venues',
    kind: 'markdown',
    content: `
Supported trading venues:

Hyperliquid: Perpetual futures exchange. Trade with leverage on Ethereum and Arbitrum. Orderbook-based execution.

Jupiter: Solana DEX aggregator. Best execution across all Solana DEXs. Swap-based execution.

1inch: Multi-chain DEX aggregator. Best execution on Base and BSC. Swap-based execution.

Bybit: Perpetual futures exchange. Trade with leverage. Orderbook-based execution.

Each venue requires a connection:
- Hyperliquid/Bybit: Exchange connection (API key)
- Jupiter/1inch: Wallet connection
`,
    headings: ['Hyperliquid', 'Jupiter', '1inch', 'Bybit'],
    tags: ['venues', 'trading', 'exchanges', 'dex'],
  },
  {
    id: 'help/trading-venues/hyperliquid',
    title: 'Hyperliquid Trading Venue',
    kind: 'markdown',
    content: `
Hyperliquid is a high-performance perpetual futures exchange.

Key features:
- Orderbook-based trading
- Up to 50x leverage on major pairs
- Low fees (maker 0.02%, taker 0.05%)
- Fast execution

Supported chains: Ethereum, Arbitrum
Connection type: Exchange connection (API key + secret)

Available tools: submit_decision, list_positions, get_market_overview, get_funding_rates, check_regime

Setup:
1. Create a Hyperliquid account and generate API credentials
2. Add an Exchange connection with your API key and secret
3. Bind the connection to your agent
4. Set executionVenue to "hyperliquid"
`,
    headings: ['Key features', 'Setup'],
    tags: ['hyperliquid', 'venue', 'perpetual', 'futures'],
  },
  {
    id: 'help/trading-venues/jupiter',
    title: 'Jupiter Trading Venue',
    kind: 'markdown',
    content: `
Jupiter is the leading DEX aggregator on Solana.

Key features:
- Swap-based execution
- Best price routing across all Solana DEXs
- Low slippage
- No KYC required

Supported chains: Solana
Connection type: Wallet connection

Available tools: submit_decision, list_positions, search_tokens, discover_tokens

Setup:
1. Create a Solana wallet
2. Add a Wallet connection with your wallet address
3. Bind the connection to your agent
4. Set executionVenue to "jupiter"
`,
    headings: ['Key features', 'Setup'],
    tags: ['jupiter', 'venue', 'solana', 'dex'],
  },
  {
    id: 'help/trading-venues/1inch',
    title: '1inch Trading Venue',
    kind: 'markdown',
    content: `
1inch is a multi-chain DEX aggregator.

Key features:
- Swap-based execution
- Best price routing across multiple DEXs
- Multi-chain support (Base, BSC)
- Low slippage

Supported chains: Base, BSC
Connection type: Wallet connection

Available tools: submit_decision, list_positions, search_tokens, discover_tokens

Setup:
1. Create a wallet for your target chain (Base or BSC)
2. Add a Wallet connection with your wallet address
3. Bind the connection to your agent
4. Set executionVenue to "1inch"
`,
    headings: ['Key features', 'Setup'],
    tags: ['1inch', 'venue', 'base', 'bsc', 'dex'],
  },
  {
    id: 'help/trading-venues/bybit',
    title: 'Bybit Trading Venue',
    kind: 'markdown',
    content: `
Bybit is a centralized perpetual futures exchange.

Key features:
- Orderbook-based trading
- Leverage trading
- Competitive fees
- Deep liquidity

Connection type: Exchange connection (API key + secret)

Available tools: submit_decision, list_positions, get_market_overview

Setup:
1. Create a Bybit account and generate API credentials
2. Add an Exchange connection with your API key and secret
3. Bind the connection to your agent
4. Set executionVenue to "bybit"
`,
    headings: ['Key features', 'Setup'],
    tags: ['bybit', 'venue', 'perpetual', 'futures'],
  },
  {
    id: 'company/about-us',
    title: 'About Us',
    kind: 'markdown',
    content: `
OpenAIdom — bringing the power of AI agents to everyone.

Vision: To bring the power of AI agents to everyone.

Mission: Make using AI agents as simple as describing what you want to an AI agent that knows what to do to get what you want.

Core concepts:
1. AI agents should do the work — give an agent instructions, it handles the rest continuously and reliably within the limits you define.
2. AI agents should remain in contact — you stay in contact with any agent working for you via messaging apps or email.
3. AI agents can be subject matter experts — we use skills to make agents experts. Our core skills relate to crypto trading and personal assistance.
4. AI agents are unique — each user can run one or more agents, each operating independently with its own goals and constraints.

AI-first, not AI-wrapped: OpenAIdom was built from the ground up around AI agents. The agent is the product. The dashboard, tools, and trading bots exist to support the agent, not the other way around.
`,
    headings: ['Vision', 'Mission', 'Core concepts'],
    tags: ['company', 'about'],
  },
  {
    id: 'company/contact-us',
    title: 'Contact Us',
    kind: 'markdown',
    content: `
We are here to help.

Email: Reach us at admin@openaidom.com for account and billing questions, technical support, feature requests, bug reports, and feedback. We aim to respond within 24 hours on business days.

Telegram: Once your account is linked, your agents communicate with you directly on Telegram. For human support, email is the primary channel.

Status: Check the OpenAIdom status page for service uptime and incident reports.
`,
    headings: ['Email', 'Telegram', 'Status'],
    tags: ['company', 'contact', 'support'],
  },
  {
    id: 'legal/privacy-policy',
    title: 'Privacy Policy',
    kind: 'markdown',
    content: `
Last updated: 2026-07-06

OpenAIdom ("we", "our", or "us") is an AI agent platform. This policy explains how we collect, use, and protect your data.

Data we collect:
- Account data: email address (required for sign-in), Telegram Chat ID (optional)
- Trading data: trading activity (orders, fills, positions, P&L), agent configuration (goals, styles, risk limits), agent reasoning logs and decisions
- Usage data: API access logs, WebSocket connection metadata, LLM usage and cost metrics

How we use your data:
- Service operation: to run your agents and deliver the platform
- Billing: to calculate and display your usage costs
- Support: to investigate issues and respond to your inquiries
- Improvement: aggregated, anonymized data may inform product improvements. We never sell your data

Data storage: All data is encrypted in transit (TLS) and at rest. Stored in persistent storage (database) and cache.

Third-party services: We share necessary data with LLM providers (agent reasoning), trading venues (order data), and Telegram (agent messages). We do not share your data with third parties for marketing or analytics.

Your rights: You can update your account details and agent configurations at any time. Request account deletion by contacting admin@openaidom.com. Trading records required for regulatory compliance may be retained.
`,
    headings: ['Data we collect', 'How we use your data', 'Data storage', 'Third-party services', 'Your rights'],
    tags: ['legal', 'privacy'],
  },
  {
    id: 'legal/user-agreement',
    title: 'User Agreement',
    kind: 'markdown',
    content: `
Last updated: 2026-07-06

By using OpenAIdom ("the platform"), you agree to these terms.

Service description: OpenAIdom offers AI agents as a service. You create and run agents that act on your instructions.

Your responsibilities:
- AI Agents: You are responsible for the instructions, goals, permissions, and information you provide to your AI agents. AI agents may generate inaccurate or misleading information — verify important outputs. AI agents may perform tasks on your behalf using connected services. You are responsible for ensuring actions are appropriate and authorized. Do not rely on AI agents as a substitute for legal, medical, financial, tax, or other professional advice.
- Trading: You are solely responsible for all trading decisions made by or through your agents. Trading carries significant risk of financial loss. Past performance does not guarantee future results.
- Account security: Maintain the security of your account credentials, API keys, and connected accounts.
- Compliance: Comply with all applicable laws and regulations in your jurisdiction.

Platform limitations: AI agents may generate inaccurate outputs. The platform does not provide professional advice. AI agent behavior may be unexpected — monitor your agents. Third-party services may be unavailable, delayed, or inaccurate.

Execution modes:
- Test: Simulated trading. No real orders are placed.
- Live: Real orders are placed on supported trading venues using real funds.
You are responsible for verifying which execution mode your agents are operating in.

Limitation of liability: To the fullest extent permitted by law, OpenAIdom shall not be liable for any direct, indirect, incidental, or consequential damages arising from your use of the platform, including trading losses or data loss.

Contact: For questions about these terms, contact admin@openaidom.com.
`,
    headings: ['Service description', 'Your responsibilities', 'Platform limitations', 'Limitation of liability'],
    tags: ['legal', 'terms'],
  },
  {
    id: 'docs/reference/glossary',
    title: 'Glossary',
    kind: 'markdown',
    content: `
An alphabetic reference of terms used across the OpenAIdom platform.

Actor: The author of an action, decision, message, or creation event. Valid types: agent, bot, user, system.

Agent: An AI that works on your behalf. Agents respond to you, use tools, and help achieve your goals.

Agent Guardrail: Controls agent behavior — tool allowlists, time budgets, pause state, request limits. Does not replace safety checks.

Agent Mode Purity: Your agent's goal text and your explicit constraints determine how your agent trades. The platform won't add hidden restrictions.

Approval: A trade proposal waiting for your review before execution. When authorization mode is "approval_required", each trade becomes an approval.

Approval Code: A 6-character short code (e.g. 26B8D) identifying a specific pending approval. Use with /yes and /no commands.

Authorization Mode: Controls whether trade decisions execute immediately (direct) or wait for approval (approval_required).

Binding: A permission granted from a connection — "grant agent Y permission to use the link to service X."

Blueprint: The configuration that defines a bot — strategy, exchange account, asset, risk limits, execution mode.

Bot: An automated trading strategy following a predefined, rule-based blueprint. Bots generally do not use AI.

BPS (Basis Point): One-hundredth of a percent (0.01%). 100 BPS = 1%.

Connection: A link between the platform and an external service (e.g. an exchange). May reference a credential.

dailyLossLimit: A hard cap on how much your agent can lose in a rolling 24-hour window.

Decision: A proposal to change exposure on an asset. The platform validates and executes — a decision is a request, not a guarantee.

Execution Mode:
- Test: Simulated trading. No real orders. No real money at risk.
- Live: Real orders on real exchanges. Real capital at risk.

maxDrawdownPct: A hard cap on peak-to-current equity drawdown as a percentage. If exceeded, trading stops.

maxOpenPositions: The maximum number of positions your agent can hold at once.

Platform Safety Alert: A critical notification from the platform itself — for events like crashes, forced stops, or position mismatches.

Reconciliation: Comparing what the platform thinks your positions are against what the exchange says they are.

Skill Preset: A bundled set of capabilities for an agent. Examples: trading, direct-trading, trading-assistant, personal-assistant.

Slippage: The difference between expected price and actual execution price.

Strategy Preset: A bundled configuration for a bot blueprint. Examples: momentum, range, swing, scalper, contrarian.

Tick: One iteration of your agent's thinking cycle — agent reads context, may use tools, may submit decisions.

Venue Account: Your connection to a specific exchange (e.g. Hyperliquid API key, Solana wallet).
`,
    headings: ['Actor', 'Agent', 'Approval', 'Bot', 'Connection', 'Decision', 'Execution Mode', 'Tick'],
    tags: ['glossary', 'terms', 'reference'],
  },
];

// ─── Individual Skill Entries ───────────────────────────────────────────────

const SKILL_ENTRIES: DocsIndexEntry[] = [
  {
    id: 'skills/bot-management',
    title: 'Bot Management Skill',
    kind: 'reference',
    content: `
Bot Management skill (id: bot-management) — used by the trading preset. Allows the agent to create, start, stop, and monitor bots.

Required tools: create_bot, stop_bot, start_bot, adjust_bot_config, list_bots, get_bot_status, get_analytics, list_positions, resolve_bot, send_message.

Capability families: trading.

Binding requirements: At least 1 trading binding in "ready" state.

Instructions:
- Use create_bot to create a trading bot.
- Use list_bots to inspect existing bots.
- Use get_bot_status to inspect a bot's current state.
- Use start_bot to start a bot.
- Use stop_bot to stop a bot.
- Use adjust_bot_config to update a bot's configuration.
- Use get_analytics to inspect bot performance.
- Use list_positions to inspect open positions tied to managed bots.
- Use resolve_bot to find a bot ID by name or symbol before calling stop_bot, start_bot, get_bot_status, or adjust_bot_config.
- Use send_message to report actions, status, or issues to the user.
`,
    headings: ['Required tools', 'Instructions'],
    tags: ['skills', 'bot-management', 'bots', 'trading'],
  },
  {
    id: 'skills/trading',
    title: 'Trading Skill',
    kind: 'reference',
    content: `
Trading skill (id: trading) — used for direct trade decisions and state inspection.

Required tools: get_market_overview, check_regime, get_price, get_funding_rates, search_tokens, discover_tokens, get_risk_limits, get_account_summary, get_analytics, list_positions, watch_token, list_watches, remove_watch, resolve_watch, check_watches, find_instrument, submit_decision, adjust_risk_limits, assess_strategy_preset, change_strategy_preset.

Capability families: trading.

Binding requirements: At least 1 trading binding in "ready" state.

Instructions (by workflow phase):
Observe: get_market_overview, check_regime, get_price, get_funding_rates, search_tokens, discover_tokens.
Assess: get_risk_limits, get_account_summary, get_analytics, list_positions, watch_token, list_watches, remove_watch, resolve_watch, check_watches.
Decide: find_instrument (resolve instrumentId before submit_decision), submit_decision, adjust_risk_limits, assess_strategy_preset, change_strategy_preset.

Use find_instrument to resolve an instrumentId by symbol, name, or pair before calling submit_decision. Filter by venue (e.g. venue="jupiter" for Solana, venue="hyperliquid" for perpetuals).
`,
    headings: ['Required tools', 'Instructions', 'Observe', 'Assess', 'Decide'],
    tags: ['skills', 'trading', 'decisions', 'market-data'],
  },
  {
    id: 'skills/risk-monitoring',
    title: 'Risk Monitoring Skill',
    kind: 'reference',
    content: `
Risk Monitoring skill (id: risk-monitoring) — watches positions and alerts on drawdowns.

Required tools: send_message, publish_artifact, list_positions, get_analytics, get_price, watch_token, list_watches, remove_watch, resolve_watch, check_watches, get_risk_limits, adjust_risk_limits.

Capability families: trading.

Binding requirements: At least 1 trading binding in "ready" state.

Instructions:
- Use list_positions to inspect current open positions and exposure.
- Use get_analytics to inspect realized and unrealized performance.
- Use get_price for focused price checks.
- Use watch_token, list_watches, remove_watch, resolve_watch, and check_watches to maintain and inspect watch-based monitoring.
- Use send_message to alert the user.
- Use publish_artifact to publish structured monitoring outputs.
- Use get_risk_limits to inspect effective risk limits.
- Use adjust_risk_limits to adjust mutable risk limits within operator ceilings.
`,
    headings: ['Required tools', 'Instructions'],
    tags: ['skills', 'risk-monitoring', 'watches', 'alerts'],
  },
  {
    id: 'skills/programming',
    title: 'Programming Skill',
    kind: 'reference',
    content: `
Programming skill (id: programming) — code execution tools.

Required tools: execute_code.

Capability families: none.

Binding requirements: none.

Instructions:
- Use execute_code to run JavaScript or Python for custom automation, external API calls, analysis, data processing.
- Supports JavaScript/Node.js and Python runtimes with optional dependency installation.
- Returns stdout/stderr so you can inspect execution results directly.
- Code can access the public internet.
`,
    headings: ['Required tools', 'Instructions'],
    tags: ['skills', 'programming', 'code', 'automation'],
  },
  {
    id: 'skills/file-management',
    title: 'File Management Skill',
    kind: 'reference',
    content: `
File Management skill (id: file-management) — manage a per-agent workspace for intermediate files and outputs.

Required tools: write_file, read_file, list_files, delete_file, stat_file.

Capability families: none.

Binding requirements: none.

Instructions:
- Use write_file to create or overwrite a file under the agent workspace.
- Use read_file to inspect file contents.
- Use list_files to inspect workspace directories.
- Use delete_file to remove files.
- Use stat_file to check if a path exists, its type, and size.

Workspace rules:
- Files persist across ticks in the same runtime.
- Files do not persist across runtime restarts.
- The sandbox directory is reserved for code execution internals.
- For data that must survive runtime restarts, use memory tools from the base skill.
`,
    headings: ['Required tools', 'Instructions', 'Workspace rules'],
    tags: ['skills', 'file-management', 'workspace', 'files'],
  },
  {
    id: 'skills/web-access',
    title: 'Web Access Skill',
    kind: 'reference',
    content: `
Web Access skill (id: web-access) — search the internet, read web pages, and fetch documents.

Required tools: search_web, browse_url, read_document, send_message, publish_artifact.

Capability families: none.

Binding requirements: none.

Instructions:
- Use search_web(query) to search the internet. Returns results with titles, URLs, and text extracts.
- Use browse_url(url) to fetch and read the contents of a specific web page. HTTPS only.
- Use read_document(url) to fetch and extract text from a document URL (e.g. PDF). HTTPS only.
- Use send_message to share findings with the user.
- Use publish_artifact when findings are substantial enough to warrant a structured output.
`,
    headings: ['Required tools', 'Instructions'],
    tags: ['skills', 'web-access', 'search', 'internet'],
  },
  {
    id: 'skills/task-management',
    title: 'Task Management Skill',
    kind: 'reference',
    content: `
Task Management skill (id: task-management) — durable task tracking and reminder scheduling.

Required tools: create_task, list_tasks, resolve_task, complete_task, schedule_reminder.

Capability families: none.

Binding requirements: none.

Instructions:
- Use create_task to create a durable task with a title, optional notes, and optional due datetime.
- Use list_tasks to list your current tasks and their status.
- Use resolve_task to find a task ID by title before calling complete_task.
- Use complete_task to mark a task as completed by its ID.
- Use schedule_reminder to schedule a one-shot reminder at a specific datetime. The reminder will reach you at the scheduled time.
`,
    headings: ['Required tools', 'Instructions'],
    tags: ['skills', 'task-management', 'tasks', 'reminders'],
  },
  {
    id: 'skills/email',
    title: 'Email Skill',
    kind: 'reference',
    content: `
Email skill (id: email, revision: 1) — send emails on behalf of the user.

Required tools: send_email.

Capability families: email.

Binding requirements: At least 1 email binding in "ready" state.

Instructions:
- Use send_email(to, subject, body) to send emails. May include cc and bcc recipients.
- The prompt context lists your granted email connections — check it for available fromConnectionId values.
- If you have multiple email connections, use fromConnectionId to select a specific sender. Omit to use the default connection.

Rule: Use send_email for external email recipients. Use send_message for communicating with the user.
`,
    headings: ['Required tools', 'Instructions'],
    tags: ['skills', 'email', 'messaging'],
  },
  {
    id: 'skills/platform-docs',
    title: 'Platform Docs Skill',
    kind: 'reference',
    content: `
Platform Docs skill (id: platform-docs) — search and read platform documentation, form schemas, and configuration references.

Required tools: search_app_docs, list_app_docs, read_app_docs.

Capability families: none.

Binding requirements: none.

Instructions:
- Use list_app_docs to discover available documentation pages, schemas, and references.
- Use search_app_docs(query) to search for specific topics across all docs.
- Use read_app_docs(id) to read a specific document or schema by its ID.

Use these tools to answer user questions about platform capabilities, guide them through agent creation, explain configuration options, and help them understand connection types, venue options, and risk settings.
`,
    headings: ['Required tools', 'Instructions'],
    tags: ['skills', 'platform-docs', 'documentation'],
  },
];

// ─── Aggregated Index ───────────────────────────────────────────────────────

export const PLATFORM_DOCS_INDEX: DocsIndexEntry[] = [
  UI_TERMINOLOGY_ENTRY,
  CREATE_AGENT_SCHEMA_ENTRY,
  UPDATE_AGENT_SCHEMA_ENTRY,
  SKILL_PRESET_ENTRY,
  VENUE_CHAIN_ENTRY,
  AGENT_STYLE_ENTRY,
  CONNECTION_TYPES_ENTRY,
  EXECUTION_MODES_ENTRY,
  AGENT_LIFECYCLE_ENTRY,
  BILLING_MODEL_ENTRY,
  ...SKILL_ENTRIES,
  ...MARKDOWN_DOCS,
];
