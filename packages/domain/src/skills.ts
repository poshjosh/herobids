// ── Slug helpers ────────────────────────────────────────────────────────────

/** Convert a human-readable name to a kebab-case slug component. */
export function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, '')  // strip non-alphanumeric (keep spaces, hyphens & underscores)
    .replace(/[\s_-]+/g, '-')       // collapse whitespace/underscores/hyphens to single hyphen
    .replace(/^-+|-+$/g, '');       // trim leading/trailing hyphens
}

/** Build a full skill slug: `<authorHandle>/<slugified-name>`. */
export function buildSkillSlug(authorHandle: string, name: string): string {
  return `${authorHandle.toLowerCase()}/${slugify(name)}`;
}

// ── Source kind ──────────────────────────────────────────────────────────────

export type SourceKind = 'system' | 'user' | 'external';

// ── Skill definitions ───────────────────────────────────────────────────────

/**
 * System skill definitions — seeded at deploy time.
 * Each skill defines what tools and context sections an agent can access.
 *
 * The `base` skill is auto-injected at runtime and NOT stored in the DB.
 * All other skills are stored as rows in the `skills` table.
 */

export interface SkillDefinition {
  id: string;
  /** Unique human-readable slug: `author/name` (e.g. `system/trading`). */
  slug?: string;
  /** Optional skill revision — incremented when the definition changes materially. */
  revision?: number;
  name: string;
  description: string;
  instructions: string;
  /** Optional hint shown to the creator near the agent goal/prompt field —
   *  describes what kind of goal works well with this skill. */
  promptHint?: string;
  /** Optional starter text pre-populated in the agent goal field.
   *  Takes priority over promptHint for in-field display. */
  promptTemplate?: string;
  requiredTools: string[];
  capabilityFamilies: string[];
  bindingRequirements: Record<string, {
    minBindings: number;
    requireReady: boolean;
  }>;
  contextRequirements: string[];
  requiredContextBlocks: string[];
  promptRendererHints: string[];
  requiredGuardrails: string[];
  suggestedTickIntervalMs: number;
  visibility: 'public' | 'private';
}

/**
 * `base` skill — auto-injected at runtime for every agent.
 * Provides memory, messaging, cost-awareness, and introspection tools.
 * NOT stored in DB; merged into any agent's capability set at tick time.
 */
export const BASE_SKILL: SkillDefinition = {
  id: 'base',
  slug: 'system/base',
  name: 'Base',
  description: 'Core tools: memory, messaging, cost tracking, schema fetching, and account summary. Auto-injected into every agent.',
  instructions: `You have access to core tools.

Use memory to remember information. For example, if you need find information from the past or set a reminder for the future, you can:
- Use \`set_memory\` to persist a value by key across ticks.
- Use \`get_memory\` to retrieve a previously stored value by key.
- Use \`list_memory_keys\` to list all stored memory keys.
- Use \`delete_memory\` to remove one or more memory keys.

You can use skills to gain additional capabilities/expertise. For example, if you have a task but are not sure how to accomplish it, you can search for, then add skills related to the task:
- Use \`search_skills\` to find skills by keyword. It searches both the platform catalog and external skills.
- Use \`add_skills\` to add skills by slug. Dependencies are added automatically unless you set includeDependencies to false. For external skills (e.g. twostraws/swiftui-agent-skill), the platform installs them and adds the file-management skill so you can read the installed instructions.
- Use \`list_skills\` to see what skills you currently have. Skills are identified by their slug (e.g. system/trading, system/programming).
- Use \`remove_skills\` to drop skills by slug.

You can also:
- Use \`publish_artifact\` to publish structured outputs.
- Use \`send_message\` to communicate important updates, alerts, or status reports to the user. Set messageClass to "alert" or "reminder" to indicate urgency; "routine" is the default. Use contextRef to link the message to a specific context. Use \`send_email\` for email delivery.
- Use \`get_risk_limits\` to inspect your effective risk limits, including which are mutable and which are locked by the creator.
- Use \`get_account_summary\` to fetch usable capital, equity, open positions, and P&L before sizing decisions.
- Use \`get_schema\` to fetch JSON Schema for a named config parameter or tool sub-schema. Call with name="all" to list available schemas before constructing config payloads.`,
  requiredTools: ['send_message', 'publish_artifact', 'set_memory', 'get_memory', 'list_memory_keys', 'delete_memory', 'get_risk_limits', 'get_account_summary', 'get_schema', 'list_skills', 'add_skills', 'remove_skills', 'search_skills'],
  capabilityFamilies: [],
  bindingRequirements: {},
  contextRequirements: ['costs', 'session_elapsed'],
  requiredContextBlocks: ['corePlatformContext'],
  promptRendererHints: ['core-system'],
  requiredGuardrails: ['token-budget'],
  suggestedTickIntervalMs: 900_000, // 15 minutes
  visibility: 'public',
};

/**
 * `bot-management` skill — used by the `trading` preset.
 * Allows the agent to create, start, stop, and monitor bots.
 */
export const BOT_MANAGEMENT_SKILL: SkillDefinition = {
  id: 'bot-management',
  slug: 'system/bot-management',
  name: 'Bot Management',
  description: 'Create, start, stop, and monitor trading bots.',
  instructions: `You have access to bot-management tools.

- Use \`create_bot\` to create a trading bot.
- Use \`list_bots\` to inspect existing bots.
- Use \`get_bot_status\` to inspect a bot's current state.
- Use \`start_bot\` to start a bot.
- Use \`stop_bot\` to stop a bot.
- Use \`adjust_bot_config\` to update a bot's configuration.
- Use \`get_analytics\` to inspect bot performance.
- Use \`list_positions\` to inspect open positions tied to managed bots.
- Use \`resolve_bot\` to find a bot ID by name or symbol before calling stop_bot, start_bot, get_bot_status, or adjust_bot_config when you don't have the UUID.
- Use \`send_message\` to report actions, status, or issues to the user.`,
  requiredTools: ['create_bot', 'stop_bot', 'start_bot', 'adjust_bot_config', 'list_bots', 'get_bot_status', 'get_analytics', 'list_positions', 'resolve_bot', 'send_message'],
  capabilityFamilies: ['trading'],
  bindingRequirements: {
    trading: {
      minBindings: 1,
      requireReady: true,
    },
  },
  contextRequirements: ['bot_statuses', 'positions', 'costs'],
  requiredContextBlocks: ['corePlatformContext', 'tradingContext'],
  promptRendererHints: ['readiness-summary', 'trading'],
  requiredGuardrails: ['token-budget', 'daily-loss', 'bot-limit'],
  suggestedTickIntervalMs: 900_000, // 15 minutes
  visibility: 'public',
  promptHint: 'Describe what trading bots to create and how to configure them (e.g., "Create a momentum bot for SOL with $500 capital and 5% stop-loss")',
};

/**
 * `trading` skill — used for direct trade decisions and state inspection.
 */
export const TRADING_SKILL: SkillDefinition = {
  id: 'trading',
  slug: 'system/trading',
  name: 'Trading',
  description: 'Submit trade decisions and inspect trading state.',
  instructions: `You have access to trading tools, grouped by workflow phase.

To observe, gather market context, you can:
- Use \`get_market_overview\` to inspect broad market state.
- Use \`check_regime\` to assess current market conditions.
- Use \`get_price\` for focused price checks.
- Use \`get_funding_rates\` to inspect perpetual funding conditions.
- Use \`search_tokens\` to find a token by name or symbol.
- Use \`discover_tokens\` to explore available trading candidates.

To assess, check your risk and position before acting, you can:
- Use \`get_risk_limits\` to inspect your effective risk limits and their sources. If you are blocked (e.g. daily loss limit exceeded), DO NOT submit any trade — wait for the cooldown to expire.
- Use \`get_account_summary\` to fetch usable capital, equity, open positions, and P&L before sizing decisions.
- Use \`get_analytics\` to inspect recent trading outcomes and exposure.
- Use \`list_positions\` to inspect current open positions.
- Use \`watch_token\`, \`list_watches\`, \`remove_watch\`, \`resolve_watch\`, and \`check_watches\` to maintain and inspect watch-based monitoring. Use resolve_watch to find a watch ID by note or symbol before calling remove_watch.

To decide, you can:
- Use \`find_instrument\` to resolve an instrumentId by symbol, name, or pair before calling submit_decision. Filter by venue (e.g. venue="jupiter" for Solana, venue="hyperliquid" for perpetuals).
- Use \`submit_decision\` to submit a trade intent for a specific instrument. Only call this after completing the Observe and Assess phases above.
- Use \`adjust_risk_limits\` to adjust mutable (default-derived) risk limits within operator ceilings.`,
  requiredTools: ['get_market_overview', 'check_regime', 'get_price', 'get_funding_rates', 'search_tokens', 'discover_tokens', 'get_risk_limits', 'get_account_summary', 'get_analytics', 'list_positions', 'watch_token', 'list_watches', 'remove_watch', 'resolve_watch', 'check_watches', 'find_instrument', 'submit_decision', 'adjust_risk_limits', 'assess_strategy_preset', 'change_strategy_preset'],
  capabilityFamilies: ['trading'],
  bindingRequirements: {
    trading: {
      minBindings: 1,
      requireReady: true,
    },
  },
  contextRequirements: ['positions', 'fills', 'analytics', 'costs'],
  requiredContextBlocks: ['corePlatformContext', 'tradingContext'],
  promptRendererHints: ['readiness-summary', 'trading'],
  requiredGuardrails: ['token-budget', 'daily-loss'],
  suggestedTickIntervalMs: 300_000,
  visibility: 'public',
  promptHint: 'Describe your trading strategy, which assets to focus on, and your risk tolerance (e.g., "Trade SOL and BTC using momentum signals, keep positions under $500 each")',
};

/**
 * `risk-monitoring` skill — watches positions and alerts on drawdowns.
 */
export const RISK_MONITORING_SKILL: SkillDefinition = {
  id: 'risk-monitoring',
  slug: 'system/risk-monitoring',
  name: 'Risk Monitoring',
  description: 'Watch open positions and alert the user when risk thresholds are approaching.',
  instructions: `You have access to risk-monitoring and alerting tools.

- Use \`list_positions\` to inspect current open positions and exposure.
- Use \`get_analytics\` to inspect realized and unrealized performance context.
- Use \`get_price\` for focused price checks.
- Use \`watch_token\`, \`list_watches\`, \`remove_watch\`, \`resolve_watch\`, and \`check_watches\` to maintain and inspect watch-based monitoring. Use resolve_watch to find a watch ID by note or symbol before calling remove_watch.
- Use \`send_message\` to alert the user.
- Use \`publish_artifact\` to publish structured monitoring outputs.
- Use \`get_risk_limits\` to inspect effective risk limits and sources.
- Use \`adjust_risk_limits\` to adjust mutable risk limits within operator ceilings.`,
  requiredTools: ['send_message', 'publish_artifact', 'list_positions', 'get_analytics', 'get_price', 'watch_token', 'list_watches', 'remove_watch', 'resolve_watch', 'check_watches', 'get_risk_limits', 'adjust_risk_limits'],
  capabilityFamilies: ['trading'],
  bindingRequirements: {
    trading: {
      minBindings: 1,
      requireReady: true,
    },
  },
  contextRequirements: ['positions', 'fills', 'analytics'],
  requiredContextBlocks: ['corePlatformContext', 'tradingContext'],
  promptRendererHints: ['readiness-summary', 'trading'],
  requiredGuardrails: ['token-budget', 'daily-loss'],
  suggestedTickIntervalMs: 300_000, // 5 minutes
  visibility: 'public',
  promptHint: 'Describe which positions or risk thresholds to monitor (e.g., "Watch all open positions and alert me if any drop 5% from entry")',
};

/**
 * `programming` skill — code execution tools.
 */
export const PROGRAMMING_SKILL: SkillDefinition = {
  id: 'programming',
  slug: 'system/programming',
  name: 'Programming',
  description: 'Code execution tools',
  instructions: `You have access to programming tools for code-driven automation, external API calls etc.

- Use \`execute_code\` to run JavaScript or Python for custom automation, external API calls, analysis, data processing etc.
- Use \`execute_shell\` to run shell commands for git operations, build tools, package management, and system tasks.
- The tools available to you depend on your permission level. If \`execute_shell\` is not available, use \`execute_code\` instead.
- The tools support JavaScript/Node.js and Python runtimes as well as optional dependency installation.
- The tools return stdout/stderr so you can inspect execution results directly.
- Code can access the public internet.`,
  requiredTools: ['execute_code', 'execute_shell'],
  capabilityFamilies: [],
  bindingRequirements: {},
  contextRequirements: ['costs', 'session_elapsed'],
  requiredContextBlocks: ['corePlatformContext'],
  promptRendererHints: ['core-system'],
  requiredGuardrails: ['token-budget'],
  suggestedTickIntervalMs: 900_000,
  visibility: 'public',
  promptHint: 'Describe what automation or data processing the agent should perform (e.g., "Fetch token prices hourly and log them to a workspace file")',
};

/**
 * `file-management` skill — workspace file read, write, list, and delete.
 */
export const FILE_MANAGEMENT_SKILL: SkillDefinition = {
  id: 'file-management',
  slug: 'system/file-management',
  name: 'File Management',
  description: 'Manage a per-agent workspace for intermediate files and outputs.',
  instructions: `You have access to workspace file-management tools.

- Use \`write_file\` to create or overwrite a file under the agent workspace.
- Use \`read_file\` to inspect file contents.
- Use \`list_files\` to inspect workspace directories and discover available files.
- Use \`delete_file\` to remove files you no longer need.
- Use \`stat_file\` to check if a path exists, whether it is a file or directory, and its size before calling read_file, list_files, or delete_file.

Workspace rules:
- Workspace files persist across ticks in the same runtime.
- Workspace files do not persist across runtime restarts.
- The \`sandbox\` directory is reserved for code execution internals.
- For data that must survive runtime restarts, memory tools from the base skill are the durable storage path.`,
  requiredTools: ['write_file', 'read_file', 'list_files', 'delete_file', 'stat_file'],
  capabilityFamilies: [],
  bindingRequirements: {},
  contextRequirements: ['costs', 'session_elapsed'],
  requiredContextBlocks: ['corePlatformContext'],
  promptRendererHints: ['core-system'],
  requiredGuardrails: ['token-budget'],
  suggestedTickIntervalMs: 900_000,
  visibility: 'public',
  promptHint: 'Describe what files or outputs the agent should maintain (e.g., "Keep a daily trading journal in workspace/journal/")',
};

/**
 * `web-access` skill — internet search, URL reading, and document fetching.
 */
export const WEB_ACCESS_SKILL: SkillDefinition = {
  id: 'web-access',
  slug: 'system/web-access',
  name: 'Web Access',
  description: 'Search the internet, read web pages, fetch documents, and make structured HTTP requests for research and information gathering.',
  instructions: `You have access to internet research tools.

- Use \`search_web(query)\` to search the internet. Returns a list of results with titles, URLs, and text extracts.
- Use \`browse_url(url)\` to fetch and read the contents of a specific web page. Only \`https://\` URLs are allowed.
- Use \`read_document(url)\` to fetch and extract text from a document URL (e.g. PDF). Only \`https://\` URLs are allowed.
- Use \`make_http_request\` to make structured HTTP requests (GET, POST, PUT, PATCH, DELETE, HEAD) to external APIs. Returns status, headers, and truncated body. Useful for calling REST or GraphQL APIs with custom headers and authentication.
- Use \`send_message\` to share findings with the user.
- Use \`publish_artifact\` when findings are substantial enough to warrant a structured output.`,
  requiredTools: ['search_web', 'browse_url', 'read_document', 'make_http_request', 'send_message', 'publish_artifact'],
  capabilityFamilies: [],
  bindingRequirements: {},
  contextRequirements: ['costs', 'session_elapsed'],
  requiredContextBlocks: ['corePlatformContext'],
  promptRendererHints: ['core-system'],
  requiredGuardrails: ['token-budget'],
  suggestedTickIntervalMs: 900_000,
  visibility: 'public',
  promptHint: "e.g. 'Research the best noise-cancelling headphones under $200 and send me a comparison'",
};

/**
 * `task-management` skill — durable task tracking and reminder scheduling.
 */
export const TASK_MANAGEMENT_SKILL: SkillDefinition = {
  id: 'task-management',
  slug: 'system/task-management',
  name: 'Task Management',
  description: 'Create, track, and complete durable tasks; schedule one-shot reminders.',
  instructions: `You have access to task management tools.

- Use \`create_task\` to create a durable task with a title, optional notes, and optional due datetime.
- Use \`list_tasks\` to list your current tasks and their status.
- Use \`resolve_task\` to find a task ID by title before calling complete_task when you don't have the exact UUID.
- Use \`complete_task\` to mark a task as completed by its ID.
- Use \`schedule_reminder\` to schedule a one-shot reminder at a specific datetime. The reminder will reach you at the scheduled time with structured context. Scheduling a reminder is not the reminder itself; when the reminder arrives, you may need to take action (e.g send a notification) based on the structured context.`,
  requiredTools: ['create_task', 'list_tasks', 'resolve_task', 'complete_task', 'schedule_reminder'],
  capabilityFamilies: [],
  bindingRequirements: {},
  contextRequirements: ['costs', 'session_elapsed'],
  requiredContextBlocks: ['corePlatformContext'],
  promptRendererHints: ['core-system'],
  requiredGuardrails: ['token-budget'],
  suggestedTickIntervalMs: 900_000,
  visibility: 'public',
  promptHint: "e.g. 'Remind me next Tuesday at 9 AM to wish Jane a happy birthday'",
};

/**
 * `email` skill — send emails on behalf of the user.
 *
 * Send-only for now — inbox-read (`search_emails`) is deferred until the
 * `gmail.readonly` OAuth scope is reintroduced after Google review approval.
 */
export const EMAIL_SKILL: SkillDefinition = {
  id: 'email',
  slug: 'system/email',
  revision: 1,
  name: 'Email',
  description: 'Send emails on behalf of the user.',
  instructions: `You can send email on the user's behalf.

- Use \`send_email(to, subject, body)\` to send emails. You may include cc and bcc recipients.
- The prompt context lists your granted email connections under "Email Connections" — check it for available \`fromConnectionId\` values.
- If you have multiple email connections, use \`fromConnectionId\` to select a specific sender. Omit \`fromConnectionId\` to use the default connection (marked [DEFAULT]).

Examples:
- "Email bob@example.com the weekly summary" → send_email
- "Message me when the position closes" → send_message
- "ETH just dropped below $2000 — alert me" → send_message with messageClass="alert"

Rule: Use send_email for any external email recipient. Use send_message for communicating with the user.`,
  promptHint: "e.g. 'Forward any invoice from the accounting firm to my personal inbox'",
  requiredTools: ['send_email'],
  capabilityFamilies: ['email'],
  bindingRequirements: {
    email: { minBindings: 1, requireReady: true },
  },
  contextRequirements: [],
  requiredContextBlocks: ['corePlatformContext'],
  promptRendererHints: ['core-system'],
  requiredGuardrails: [],
  suggestedTickIntervalMs: 300_000, // 5 min — email is not real-time
  visibility: 'public',
};

/**
 * `platform-docs` skill — read platform documentation, schemas, and mappings.
 * Used by the onboarding chat agent and any agent that needs to understand
 * platform capabilities, form schemas, or configuration options.
 */
export const PLATFORM_DOCS_SKILL: SkillDefinition = {
  id: 'platform-docs',
  slug: 'system/platform-docs',
  name: 'Platform Docs',
  description: 'Search and read platform documentation, form schemas, and configuration references.',
  instructions: `You have access to platform documentation tools.

- Use \`list_app_docs\` to discover available documentation pages, schemas, and references.
- Use \`search_app_docs(query)\` to search for specific topics across all docs.
- Use \`read_app_docs(id)\` to read a specific document or schema by its ID.

Use these tools to answer user questions about platform capabilities, guide them through agent creation, explain configuration options, and help them understand connection types, venue options, and risk settings.`,
  requiredTools: ['search_app_docs', 'list_app_docs', 'read_app_docs'],
  capabilityFamilies: [],
  bindingRequirements: {},
  contextRequirements: [],
  requiredContextBlocks: ['corePlatformContext'],
  promptRendererHints: ['core-system'],
  requiredGuardrails: ['token-budget'],
  suggestedTickIntervalMs: 900_000, // 15 minutes
  visibility: 'public',
  promptHint: 'Ask me about platform features, agent configuration, or how to get started.',
};

/**
 * `browser` skill — interactive browser automation via a shared browser pool.
 * Separate from web-access because browser sessions have different resource
 * requirements and cost — the agent should explicitly opt in.
 */
export const BROWSER_SKILL: SkillDefinition = {
  id: 'browser',
  slug: 'system/browser',
  name: 'Browser',
  description: 'Interactive browser automation: open pages, click, fill forms, take screenshots, and read page content.',
  instructions: `You have two browser automation options.

**browse_interactive**

Actions: open, snapshot, click, fill, screenshot, get_text, close.
Single session per agent. Structured JSON responses.

Strengths:
- Native tool — no shell needed
- Snapshot returns a compact accessibility tree (cheap, fast, directly actionable)
- Screenshot returns base64 PNG (use when you need visual verification; requires vision)

Limitations:
- Single session only — cannot run parallel browser sessions
- No command chaining or background execution
- No named sessions

**agent-browser CLI**

Requires the system/programming skill. Run commands via execute_shell.

\`\`\`
execute_shell({ command: 'agent-browser open https://example.com' })
execute_shell({ command: 'agent-browser snapshot -i' })
execute_shell({ command: 'agent-browser click @e2' })
execute_shell({ command: 'agent-browser close' })
\`\`\`

Strengths:
- Named sessions (--session <name>) — run multiple independent browser contexts
- Command chaining (&&) and parallel execution (&, wait)
- Element refs (@eN) from snapshots for precise interaction
- Full command set (hover, drag, scroll, pdf, eval, etc.)

Limitations:
- Requires system/programming skill for execute_shell access
- Output is plain text (stdout/stderr), not structured JSON

Run agent-browser --help for the full command list.
Always close browser sessions when done to free resources.

When following a skill's instructions, prefer whichever browser automation option the skill suggests.`,
  promptHint: "e.g. 'Navigate to a website, fill out a form, and capture the results'",
  requiredTools: ['browse_interactive', 'send_message', 'publish_artifact'],
  capabilityFamilies: [],
  bindingRequirements: {},
  contextRequirements: ['costs', 'session_elapsed'],
  requiredContextBlocks: ['corePlatformContext'],
  promptRendererHints: ['core-system'],
  requiredGuardrails: ['token-budget'],
  suggestedTickIntervalMs: 900_000,
  visibility: 'public',
};

/**
 * Preset → skill ID mapping.
 * When a user selects a preset in the UI, this is what gets stored as skillIds.
 */
export const SKILL_PRESET_MAP: Record<string, string[]> = {
  trading: ['trading', 'bot-management'],
  'direct-trading': ['trading'],
  'trading-assistant': ['trading'],
  'personal-assistant': ['task-management', 'web-access', 'email'],
  custom: [],       // user configures skills manually
};

/** All seeded system skills (excluding base which is auto-injected). */
export const SYSTEM_SKILLS: SkillDefinition[] = [
  BOT_MANAGEMENT_SKILL,
  TRADING_SKILL,
  RISK_MONITORING_SKILL,
  PROGRAMMING_SKILL,
  FILE_MANAGEMENT_SKILL,
  WEB_ACCESS_SKILL,
  TASK_MANAGEMENT_SKILL,
  EMAIL_SKILL,
  PLATFORM_DOCS_SKILL,
  BROWSER_SKILL,
];

/**
 * Map from system skill slug → skill ID for fast lookup.
 *
 * Excludes `BASE_SKILL` — it is auto-injected at runtime and never the
 * target of `add_skills`/`remove_skills`.
 */
export const SYSTEM_SKILL_SLUGS: ReadonlyMap<string, string> = new Map(
  SYSTEM_SKILLS
    .filter((s): s is SkillDefinition & { slug: string } => s.slug != null)
    .map(s => [s.slug, s.id]),
);


// ── Read-time dependency inference ──────────────────────────────────────────

/**
 * Explicit canonical owner for tools that appear in multiple skills.
 * Exported for testability.
 */
export const TOOL_OWNER_OVERRIDES: Readonly<Record<string, string>> = {
  get_analytics: 'trading',
  list_positions: 'trading',
  get_price: 'trading',
  adjust_risk_limits: 'trading',
  watch_token: 'trading',
  list_watches: 'trading',
  remove_watch: 'trading',
  resolve_watch: 'trading',
  check_watches: 'trading',
};

const baseToolSet = new Set(BASE_SKILL.requiredTools);

let cachedOwnershipMap: ReadonlyMap<string, string> | undefined;

/**
 * Builds (and caches) a map from tool name → canonical owner skill ID.
 *
 * Rules:
 * 1. BASE_SKILL tools are excluded — they are universal and not "owned".
 * 2. Explicit overrides in TOOL_OWNER_OVERRIDES take precedence.
 * 3. For non-overridden tools, the first skill in SYSTEM_SKILLS that lists
 *    the tool wins.
 */
export function buildToolOwnershipMap(): ReadonlyMap<string, string> {
  if (cachedOwnershipMap) return cachedOwnershipMap;

  const map = new Map<string, string>();

  for (const skill of SYSTEM_SKILLS) {
    for (const tool of skill.requiredTools) {
      if (baseToolSet.has(tool)) continue;
      if (map.has(tool)) continue;
      map.set(tool, skill.id);
    }
  }

  // Apply explicit overrides — they win over first-seen order.
  for (const [tool, owner] of Object.entries(TOOL_OWNER_OVERRIDES)) {
    if (!baseToolSet.has(tool)) {
      map.set(tool, owner);
    }
  }

  cachedOwnershipMap = map;
  return cachedOwnershipMap;
}

/**
 * Derives the list of skill IDs that a given skill depends on, based on
 * which skills canonically own the tools it requires.
 *
 * - BASE_SKILL tools are excluded (universal).
 * - The skill itself is excluded.
 * - Returns a deduplicated, sorted array.
 */
export function inferDependsOn(requiredTools: string[], selfSkillId: string): string[] {
  const ownershipMap = buildToolOwnershipMap();
  const deps = new Set<string>();

  for (const tool of requiredTools) {
    if (baseToolSet.has(tool)) continue;
    const owner = ownershipMap.get(tool);
    if (owner && owner !== selfSkillId) {
      deps.add(owner);
    }
  }

  return [...deps].sort();
}
