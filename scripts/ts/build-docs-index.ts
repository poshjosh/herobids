/**
 * Build script: regenerates apps/worker/src/tools/platform-docs-data.ts
 * from the public-pages markdown files plus hardcoded schema/mapping/skill entries.
 *
 * Usage: tsx scripts/ts/build-docs-index.ts
 *
 * Run this whenever you add, rename, or update a markdown file under
 * apps/web/src/features/public-pages/content/en/.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative, dirname, basename } from 'node:path';

// ─── Configuration ──────────────────────────────────────────────────────────

const CONTENT_ROOT = resolve(
  import.meta.dirname,
  '../../apps/web/src/features/public-pages/content/en',
);
const OUTPUT_FILE = resolve(
  import.meta.dirname,
  '../../apps/worker/src/tools/platform-docs-data.ts',
);

// ─── Markdown walking ───────────────────────────────────────────────────────

interface MarkdownEntry {
  /** Relative path ID, e.g. "docs/agents/index" */
  id: string;
  /** First # heading */
  title: string;
  /** Full markdown content */
  content: string;
  /** All ## and ### headings */
  headings: string[];
}

function walkMarkdown(dir: string, baseDir: string): MarkdownEntry[] {
  const entries: MarkdownEntry[] = [];
  const dirents = readdirSync(dir, { withFileTypes: true });

  for (const d of dirents) {
    const fullPath = resolve(dir, d.name);
    if (d.isDirectory()) {
      entries.push(...walkMarkdown(fullPath, baseDir));
    } else if (d.name.endsWith('.md')) {
      const raw = readFileSync(fullPath, 'utf-8');
      const relPath = relative(baseDir, fullPath).replace(/\\/g, '/');
      const id = relPath.replace(/\.md$/, '');

      const title = extractTitle(raw);
      const headings = extractHeadings(raw);

      entries.push({
        id,
        title,
        content: raw.trim(),
        headings,
      });
    }
  }

  return entries;
}

function extractTitle(markdown: string): string {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match ? match[1]!.trim() : 'Untitled';
}

function extractHeadings(markdown: string): string[] {
  const headings: string[] = [];
  const regex = /^#{2,3}\s+(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(markdown)) !== null) {
    headings.push(match[1]!.trim());
  }
  return headings;
}

// ─── Kind detection ─────────────────────────────────────────────────────────

function detectKind(id: string): 'markdown' | 'faq' {
  if (id.endsWith('faqs')) return 'faq';
  return 'markdown';
}

// ─── Tag derivation ─────────────────────────────────────────────────────────

function deriveTags(id: string, headings: string[], content: string): string[] {
  const tags = new Set<string>();

  // Directory segments as tags
  const segments = id.split('/');
  for (const seg of segments.slice(0, -1)) {
    tags.add(seg);
  }

  // Filename stem (without extension) as tag
  const stem = segments[segments.length - 1] ?? id;
  if (stem && stem !== 'index') {
    tags.add(stem);
  }

  return [...tags].sort();
}

// ─── TypeScript generation ──────────────────────────────────────────────────

function escapeTemplateString(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$');
}

function indent(text: string, level: number): string {
  const prefix = '  '.repeat(level);
  return text
    .split('\n')
    .map((line) => (line.trim() === '' ? '' : prefix + line))
    .join('\n');
}

function generateMarkdownEntries(entries: MarkdownEntry[]): string {
  if (entries.length === 0) return '  // (none)';

  return entries
    .map((e, i) => {
      const comma = i < entries.length - 1 ? ',' : '';
      return `  {
    id: '${e.id}',
    title: '${e.title.replace(/'/g, "\\'")}',
    kind: '${detectKind(e.id)}',
    content: \`${escapeTemplateString(e.content)}\`,
    headings: [${e.headings.map((h) => `'${h.replace(/'/g, "\\'")}'`).join(', ')}],
    tags: [${deriveTags(e.id, e.headings, e.content).map((t) => `'${t}'`).join(', ')}],
  }${comma}`;
    })
    .join('\n');
}

// ─── Hardcoded entries ──────────────────────────────────────────────────────
// These are derived from code structures (Zod schemas, skill definitions,
// domain mappings, UI conventions) — not from markdown files.

function hardcodedEntries(): string {
  return `
// ─── UI Terminology Reference ───────────────────────────────────────────────

const UI_TERMINOLOGY_ENTRY: DocsIndexEntry = {
  id: 'reference/ui-terminology',
  title: 'UI Terminology Reference',
  kind: 'reference',
  content: \`
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
\`,
  headings: ['Agent presets', 'Risk styles', 'Execution modes', 'Chains', 'Connection types'],
  tags: ['terminology', 'labels', 'ui', 'display-names'],
};

// ─── Schema Entries ─────────────────────────────────────────────────────────

const CREATE_AGENT_SCHEMA_ENTRY: DocsIndexEntry = {
  id: 'schema/CreateAgentSchema',
  title: 'Create Agent Schema',
  kind: 'schema',
  content: \`
Fields for creating a new agent. All fields are optional unless noted.

name (string, required): The agent's display name. Must not be "all" or "*" (reserved for Telegram broadcast). Must be 1-200 characters.

prompt (string, optional, max 8000 chars): The agent's goal/prompt text. Required when no technical config is provided.

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

executionMode (enum, optional): "paper" | "shadow" | "live".
- paper: simulated trading, no real money (safe to experiment)
- shadow: venue-backed paper trading (with real market data)
- live: real trading with real funds
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
\`,
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
  content: \`
Fields for updating an existing agent. All fields are optional — only provided fields are updated.

name (string, optional): Update the agent's display name.
prompt (string, optional, max 8000 chars): Update the agent's goal/prompt.
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
\`,
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
  content: \`
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
\`,
  headings: ['trading', 'direct-trading', 'trading-assistant', 'personal-assistant', 'custom', 'Available skills'],
  tags: ['skills', 'presets', 'mapping', 'configuration'],
};

// ─── Venue/Chain Mapping ────────────────────────────────────────────────────

const VENUE_CHAIN_ENTRY: DocsIndexEntry = {
  id: 'mapping/venue-chain',
  title: 'Chain to Venue Mapping',
  kind: 'mapping',
  content: \`
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
\`,
  headings: ['Chain to Venue', 'Venue types'],
  tags: ['venues', 'chains', 'mapping', 'trading'],
};

// ─── Agent Style Defaults ───────────────────────────────────────────────────

const AGENT_STYLE_ENTRY: DocsIndexEntry = {
  id: 'mapping/agent-styles',
  title: 'Agent Style Defaults',
  kind: 'mapping',
  content: \`
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
\`,
  headings: ['Careful', 'Balanced', 'Bold'],
  tags: ['styles', 'risk', 'defaults', 'configuration'],
};

// ─── Connection Types ───────────────────────────────────────────────────────

const CONNECTION_TYPES_ENTRY: DocsIndexEntry = {
  id: 'reference/connection-types',
  title: 'Connection Types',
  kind: 'reference',
  content: \`
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
\`,
  headings: ['Exchange connection', 'Wallet connection', 'Email connection', 'Binding requirements'],
  tags: ['connections', 'trading', 'email', 'authentication'],
};

// ─── Execution Modes ────────────────────────────────────────────────────────

const EXECUTION_MODES_ENTRY: DocsIndexEntry = {
  id: 'reference/execution-modes',
  title: 'Execution Modes',
  kind: 'reference',
  content: \`
Execution modes control whether trading is simulated or real:

paper (Paper mode):
  - Simulated trading, no real money at risk
  - Safe to experiment with, no real orders sent to venues
  - Recommended for: learning, testing strategies, onboarding

shadow (Shadow mode):
  - Venue-backed paper trading with real market data
  - Tracks what would have happened if orders were real
  - No real money at risk
  - Recommended for: strategy validation before going live

live (Live mode):
  - Real trading with real funds
  - Orders are sent to venues and executed
  - Real P&L, real risk
  - Recommended for: production trading

Note: Users should start with "paper" mode for initial testing, move to "shadow" for venue-backed validation, and only switch to "live" after confirming their strategy.
\`,
  headings: ['paper', 'shadow', 'live'],
  tags: ['execution', 'modes', 'trading', 'risk'],
};

// ─── Agent Lifecycle ────────────────────────────────────────────────────────

const AGENT_LIFECYCLE_ENTRY: DocsIndexEntry = {
  id: 'reference/agent-lifecycle',
  title: 'Agent Lifecycle',
  kind: 'reference',
  content: \`
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
\`,
  headings: ['Lifecycle phases', 'Agent states', 'Lifecycle actions'],
  tags: ['lifecycle', 'agent', 'states', 'tick'],
};

// ─── Billing Model ──────────────────────────────────────────────────────────

const BILLING_MODEL_ENTRY: DocsIndexEntry = {
  id: 'reference/billing-model',
  title: 'Billing Model Overview',
  kind: 'reference',
  content: \`
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
\`,
  headings: ['LLM costs', 'Runtime costs', 'Billing controls', 'Protective exits', 'Viewing costs'],
  tags: ['billing', 'costs', 'spend', 'limits'],
};`;
}

// ─── Skill entries ──────────────────────────────────────────────────────────

function skillEntries(): string {
  return `
// ─── Individual Skill Entries ───────────────────────────────────────────────

const SKILL_ENTRIES: DocsIndexEntry[] = [
  {
    id: 'skills/bot-management',
    title: 'Bot Management Skill',
    kind: 'reference',
    content: \`
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
\`,
    headings: ['Required tools', 'Instructions'],
    tags: ['skills', 'bot-management', 'bots', 'trading'],
  },
  {
    id: 'skills/trading',
    title: 'Trading Skill',
    kind: 'reference',
    content: \`
Trading skill (id: trading) — used for direct trade decisions and state inspection.

Required tools: get_market_overview, check_regime, get_price, get_funding_rates, search_tokens, discover_tokens, get_risk_limits, get_account_summary, get_analytics, list_positions, watch_token, list_watches, remove_watch, resolve_watch, check_watches, find_instrument, submit_decision, adjust_risk_limits, assess_strategy_preset, change_strategy_preset.

Capability families: trading.

Binding requirements: At least 1 trading binding in "ready" state.

Instructions (by workflow phase):
Observe: get_market_overview, check_regime, get_price, get_funding_rates, search_tokens, discover_tokens.
Assess: get_risk_limits, get_account_summary, get_analytics, list_positions, watch_token, list_watches, remove_watch, resolve_watch, check_watches.
Decide: find_instrument (resolve instrumentId before submit_decision), submit_decision, adjust_risk_limits, assess_strategy_preset, change_strategy_preset.

Use find_instrument to resolve an instrumentId by symbol, name, or pair before calling submit_decision. Filter by venue (e.g. venue="jupiter" for Solana, venue="hyperliquid" for perpetuals).
\`,
    headings: ['Required tools', 'Instructions', 'Observe', 'Assess', 'Decide'],
    tags: ['skills', 'trading', 'decisions', 'market-data'],
  },
  {
    id: 'skills/risk-monitoring',
    title: 'Risk Monitoring Skill',
    kind: 'reference',
    content: \`
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
\`,
    headings: ['Required tools', 'Instructions'],
    tags: ['skills', 'risk-monitoring', 'watches', 'alerts'],
  },
  {
    id: 'skills/programming',
    title: 'Programming Skill',
    kind: 'reference',
    content: \`
Programming skill (id: programming) — code execution tools.

Required tools: execute_code.

Capability families: none.

Binding requirements: none.

Instructions:
- Use execute_code to run JavaScript or Python for custom automation, external API calls, analysis, data processing.
- Supports JavaScript/Node.js and Python runtimes with optional dependency installation.
- Returns stdout/stderr so you can inspect execution results directly.
- Code can access the public internet.
\`,
    headings: ['Required tools', 'Instructions'],
    tags: ['skills', 'programming', 'code', 'automation'],
  },
  {
    id: 'skills/file-management',
    title: 'File Management Skill',
    kind: 'reference',
    content: \`
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
\`,
    headings: ['Required tools', 'Instructions', 'Workspace rules'],
    tags: ['skills', 'file-management', 'workspace', 'files'],
  },
  {
    id: 'skills/web-access',
    title: 'Web Access Skill',
    kind: 'reference',
    content: \`
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
\`,
    headings: ['Required tools', 'Instructions'],
    tags: ['skills', 'web-access', 'search', 'internet'],
  },
  {
    id: 'skills/task-management',
    title: 'Task Management Skill',
    kind: 'reference',
    content: \`
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
\`,
    headings: ['Required tools', 'Instructions'],
    tags: ['skills', 'task-management', 'tasks', 'reminders'],
  },
  {
    id: 'skills/email',
    title: 'Email Skill',
    kind: 'reference',
    content: \`
Email skill (id: email, revision: 1) — send emails on behalf of the user.

Required tools: send_email.

Capability families: email.

Binding requirements: At least 1 email binding in "ready" state.

Instructions:
- Use send_email(to, subject, body) to send emails. May include cc and bcc recipients.
- The prompt context lists your granted email connections — check it for available fromConnectionId values.
- If you have multiple email connections, use fromConnectionId to select a specific sender. Omit to use the default connection.

Rule: Use send_email for external email recipients. Use send_message for communicating with the user.
\`,
    headings: ['Required tools', 'Instructions'],
    tags: ['skills', 'email', 'messaging'],
  },
  {
    id: 'skills/platform-docs',
    title: 'Platform Docs Skill',
    kind: 'reference',
    content: \`
Platform Docs skill (id: platform-docs) — search and read platform documentation, form schemas, and configuration references.

Required tools: search_app_docs, list_app_docs, read_app_docs.

Capability families: none.

Binding requirements: none.

Instructions:
- Use list_app_docs to discover available documentation pages, schemas, and references.
- Use search_app_docs(query) to search for specific topics across all docs.
- Use read_app_docs(id) to read a specific document or schema by its ID.

Use these tools to answer user questions about platform capabilities, guide them through agent creation, explain configuration options, and help them understand connection types, venue options, and risk settings.
\`,
    headings: ['Required tools', 'Instructions'],
    tags: ['skills', 'platform-docs', 'documentation'],
  },
];`;
}

// ─── Main ───────────────────────────────────────────────────────────────────

function main(): void {
  console.log('Walking markdown files in', CONTENT_ROOT);
  const markdownEntries = walkMarkdown(CONTENT_ROOT, CONTENT_ROOT);
  console.log(`Found ${markdownEntries.length} markdown files`);

  const output = `/**
 * Platform Docs Index — searchable index of all platform documentation,
 * schemas, mappings, and terminology references.
 *
 * AUTO-GENERATED by scripts/ts/build-docs-index.ts
 * DO NOT EDIT MANUALLY.
 *
 * Run:  tsx scripts/ts/build-docs-index.ts
 *
 * Sources:
 * - apps/web/src/features/public-pages/content/en/  (auto-parsed from .md files)
 * - CreateAgentSchema / UpdateAgentSchema (hardcoded in build script)
 * - SKILL_PRESET_MAP (hardcoded in build script)
 * - Venue/chain mapping (hardcoded in build script)
 * - Agent style defaults (hardcoded in build script)
 * - Connection types, execution modes, agent lifecycle, billing model
 * - UI terminology reference
 * - Individual skill detail entries (hardcoded in build script)
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
${hardcodedEntries()}

// ─── Auto-generated Markdown Docs ───────────────────────────────────────────

const MARKDOWN_DOCS: DocsIndexEntry[] = [
${generateMarkdownEntries(markdownEntries)}
];
${skillEntries()}

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
`;

  writeFileSync(OUTPUT_FILE, output, 'utf-8');
  console.log('Wrote', OUTPUT_FILE);

  // Summary
  console.log('\nIndex summary:');
  const totalEntries =
    10 + // hardcoded ref/schema/mapping entries
    9 + // skill entries
    markdownEntries.length;
  console.log(`  Total entries: ${totalEntries}`);
  console.log(`  Markdown (auto): ${markdownEntries.length}`);
  console.log(`  Hardcoded: 19 (10 ref/schema/mapping + 9 skills)`);
}

main();
