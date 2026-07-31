/**
 * Telegram slash-command parser and help formatter.
 *
 * Handles all explicit slash commands (except /to, which is delegated to the
 * existing telegram-command-parser). Supports case-insensitive command names,
 * bot-mention suffix stripping, and quoted-string argument tokenization.
 */

// ── Command type ──────────────────────────────────────────────────────────

export const SLASH_COMMANDS = [
  'help',
  'agents',
  'info',
  'log',
  'connections',
  'start',
  'pause',
  'resume',
  'stop',
  'restart',
  'mode',
  'connect',
  'disconnect',
  'to',
  'yes',
  'no',
] as const;

export type SlashCommand = (typeof SLASH_COMMANDS)[number];

// ── Parsed command ────────────────────────────────────────────────────────

export interface ParsedSlashCommand {
  command: SlashCommand | 'unknown';
  /** The original command text including the leading slash (e.g. "/help", "/HELP@MyBot"). */
  rawCommand: string;
  /** Tokenized arguments after the command name (unquoted and trimmed). */
  args: string[];
}

// ── Tokenizer ─────────────────────────────────────────────────────────────

interface Token {
  value: string;
  quoted: boolean;
  end: number;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < input.length) {
    // Skip whitespace
    while (index < input.length && /\s/.test(input[index]!)) {
      index += 1;
    }

    if (index >= input.length) break;

    const quote = input[index];

    // Quoted string (single or double)
    if (quote === '"' || quote === "'") {
      index += 1;
      let value = '';
      while (index < input.length && input[index] !== quote) {
        value += input[index];
        index += 1;
      }
      // Consume closing quote if present
      if (index < input.length && input[index] === quote) {
        index += 1;
      }
      tokens.push({ value, quoted: true, end: index });
      continue;
    }

    // Unquoted token — consume until whitespace
    let value = '';
    while (index < input.length && !/\s/.test(input[index]!)) {
      value += input[index];
      index += 1;
    }
    tokens.push({ value, quoted: false, end: index });
  }

  return tokens;
}

// ── Slash detection ───────────────────────────────────────────────────────

/** Regex that matches a leading slash followed by a command word. */
const SLASH_PREFIX_RE = /^\/([^\s@]+)(?:@[\w_]+)?/i;

/**
 * Parse a Telegram message text into a structured slash command, or null if
 * the message is not a slash command.
 *
 * - Strips bot-mention suffix (e.g. `/help@MyBot` → `/help`).
 * - Command name is case-insensitive.
 * - Arguments are tokenized with support for single- and double-quoted strings.
 * - `/start` with no arguments is parsed as `{ command: 'start', args: [] }`
 *   (the caller decides whether that means lifecycle or onboarding).
 * - Unknown commands produce `{ command: 'unknown', args: [originalCommandName] }`.
 */
export function parseSlashCommand(text: string): ParsedSlashCommand | null {
  const trimmed = text.trim();
  const match = trimmed.match(SLASH_PREFIX_RE);
  if (!match) return null;

  const rawCommand = match[0]!;
  const commandName = match[1]!.toLowerCase();

  const remainder = trimmed.slice(rawCommand.length).trimStart();
  const tokens = tokenize(remainder);
  const args = tokens.map((t) => t.value.trim());

  const known = SLASH_COMMANDS.includes(commandName as SlashCommand);
  if (!known) {
    return { command: 'unknown', rawCommand, args: [commandName] };
  }

  return { command: commandName as SlashCommand, rawCommand, args };
}

// ── Help text ─────────────────────────────────────────────────────────────

interface CommandHelpEntry {
  command: SlashCommand;
  syntax: string;
  description: string;
  category: 'help' | 'discovery' | 'lifecycle' | 'config' | 'approvals' | 'messaging';
}

const COMMAND_HELP: CommandHelpEntry[] = [
  { command: 'help', syntax: '/help [command]', description: 'Show all commands or detailed help for one', category: 'help' },

  { command: 'agents', syntax: '/agents', description: 'List your agents with status', category: 'discovery' },
  { command: 'info', syntax: '/info <agent>', description: 'Full agent details', category: 'discovery' },
  { command: 'log', syntax: '/log <agent>', description: 'Recent activity (last 5 entries)', category: 'discovery' },
  { command: 'connections', syntax: '/connections [agent]', description: 'List connections', category: 'discovery' },

  { command: 'start', syntax: '/start <agent>', description: 'Start a stopped agent', category: 'lifecycle' },
  { command: 'pause', syntax: '/pause <agent>', description: 'Pause a running agent', category: 'lifecycle' },
  { command: 'resume', syntax: '/resume <agent>', description: 'Resume a paused agent', category: 'lifecycle' },
  { command: 'stop', syntax: '/stop <agent>', description: 'Stop an agent', category: 'lifecycle' },
  { command: 'restart', syntax: '/restart <agent>', description: 'Stop then start an agent', category: 'lifecycle' },

  { command: 'mode', syntax: '/mode <agent> [mode]', description: 'Show or set execution mode', category: 'config' },
  { command: 'connect', syntax: '/connect <agent> [id|label]', description: 'Start or assign a connection', category: 'config' },
  { command: 'disconnect', syntax: '/disconnect <agent> <id|label>', description: 'Revoke a connection', category: 'config' },

  { command: 'to', syntax: '/to <agent> <message>', description: 'Send a message to an agent', category: 'messaging' },

  { command: 'yes', syntax: '/yes <code>', description: 'Approve a pending trade (include the short code; omit only when exactly 1 is pending)', category: 'approvals' },
  { command: 'no', syntax: '/no <code>', description: 'Reject a pending trade (include the short code; omit only when exactly 1 is pending)', category: 'approvals' },
];

const DETAILED_HELP: Record<string, string> = {
  help: [
    '/help [command]',
    '',
    'Shows available commands grouped by category, or detailed help for a specific command.',
    'Examples:',
    '  /help           — list all commands',
    '  /help start     — show help for /start',
    '  /help /start    — same as above',
  ].join('\n'),

  agents: [
    '/agents',
    '',
    'Lists all your agents with their current status, one per line.',
    'Example: /agents',
    'Response:',
    '  Momentum: active',
    '  DCA Bot: paused',
    '  Swing Trader: stopped',
  ].join('\n'),

  info: [
    '/info <agent>',
    '',
    'Returns full agent details: status, execution mode, capital,',
    'risk limits, style, strategy, skills, connections, and last session.',
    'Examples:',
    '  /info Momentum',
    '  /info "Swing Trader"',
  ].join('\n'),

  log: [
    '/log <agent>',
    '',
    'Returns the 5 most recent activity entries for an agent',
    '(decisions, messages, errors).',
    'Example: /log Momentum',
  ].join('\n'),

  connections: [
    '/connections [agent]',
    '',
    'Without an agent: lists your active connections.',
    'With an agent: lists connections assigned to that agent.',
    'Examples:',
    '  /connections            — your connections',
    '  /connections Momentum    — connections for Momentum',
  ].join('\n'),

  start: [
    '/start <agent>',
    '',
    'Starts a stopped agent. The agent must be in "stopped" status.',
    'Uses the same validation rules as the web app.',
    'Examples:',
    '  /start Momentum',
    '  /start "DCA Bot"',
    '',
    'Note: bare /start (no agent name) shows this help — use /start <agent>',
    'to start an agent.',
  ].join('\n'),

  pause: [
    '/pause <agent>',
    '',
    'Pauses an active or starting agent.',
    'Example: /pause Momentum',
  ].join('\n'),

  resume: [
    '/resume <agent>',
    '',
    'Resumes a paused agent.',
    'Example: /resume Momentum',
  ].join('\n'),

  stop: [
    '/stop <agent>',
    '',
    'Stops a running agent immediately.',
    'Example: /stop Momentum',
  ].join('\n'),

  restart: [
    '/restart <agent>',
    '',
    'Convenience command: stops the agent, waits for it to settle,',
    'then starts it again. If the agent does not reach "stopped" status',
    'quickly enough, you will be prompted to check /status and try /start.',
    'Example: /restart Momentum',
  ].join('\n'),

  mode: [
    '/mode <agent> [mode]',
    '',
    'Without a mode: shows the current execution mode for the agent.',
    'With a mode: sets the execution mode (agent must be stopped).',
    'Accepted modes: test, paper, shadow (aliases for test), live.',
    'Examples:',
    '  /mode Momentum        — show current mode',
    '  /mode Momentum test   — set to test (simulated)',
    '  /mode Momentum live   — set to live',
  ].join('\n'),

  connect: [
    '/connect <agent> [id|label]',
    '',
    'Starts the connection flow for an agent. The agent must be stopped.',
    'Without an id/label: shows assignable active connections and, when available,',
    '  a one-time setup link for creating a new one.',
    'With an id or label: grants the matching connection to the agent.',
    'Examples:',
    '  /connect Momentum                  — choose a connection or get a setup link',
    '  /connect Momentum conn_abc123      — grant by ID',
    '  /connect Momentum "Hyperliquid Main" — grant by label',
  ].join('\n'),

  disconnect: [
    '/disconnect <agent> <id|label>',
    '',
    'Revokes a connection from an agent. The agent must be stopped.',
    'Accepts connection ID or label (case-insensitive exact or unique prefix).',
    'Examples:',
    '  /disconnect Momentum conn_abc123',
    '  /disconnect Momentum "Hyperliquid Main"',
  ].join('\n'),

  to: [
    '/to <agent> <message>',
    '',
    'Sends a message to an agent. Supports multiple targets with',
    'broadcast (* or all) and quoted agent names.',
    'Examples:',
    '  /to Momentum what\'s the market looking like?',
    '  /to "DCA Bot" check my positions',
    '  /to all status report',
  ].join('\n'),

  yes: [
    '/yes <code>',
    '',
    'Approve a pending trade proposal using the short code from the approval message.',
    'Example: /yes 26B8D',
    '',
    'You may omit the code only when you have exactly one unresolved approval.',
    'If you have zero or multiple pending approvals, the code is required.',
  ].join('\n'),

  no: [
    '/no <code>',
    '',
    'Reject a pending trade proposal using the short code from the approval message.',
    'Example: /no 26B8D',
    '',
    'You may omit the code only when you have exactly one unresolved approval.',
    'If you have zero or multiple pending approvals, the code is required.',
  ].join('\n'),
};

const CATEGORY_ORDER: CommandHelpEntry['category'][] = ['help', 'discovery', 'lifecycle', 'config', 'approvals', 'messaging'];

const CATEGORY_LABELS: Record<CommandHelpEntry['category'], string> = {
  help: 'Help',
  discovery: 'Discovery',
  lifecycle: 'Lifecycle',
  config: 'Config (agent must be stopped)',
  approvals: 'Trade Approvals',
  messaging: 'Messaging',
};

/**
 * Build the general help listing grouped by category.
 */
function buildGeneralHelp(): string {
  const lines: string[] = ['Available commands:', ''];

  for (const category of CATEGORY_ORDER) {
    const entries = COMMAND_HELP.filter((e) => e.category === category);
    if (entries.length === 0) continue;

    lines.push(`${CATEGORY_LABELS[category]}:`);
    for (const entry of entries) {
      lines.push(`${entry.syntax} — ${entry.description}`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

/**
 * Normalize a help target string: strip leading `/` and lowercase.
 */
function normalizeHelpTarget(raw: string): string {
  let target = raw.trim();
  if (target.startsWith('/')) {
    target = target.slice(1);
  }
  return target.toLowerCase();
}

/**
 * Format help text for Telegram.
 *
 * - No argument → general help listing (all commands grouped by category).
 * - With argument → detailed help for the specific command.
 *   Accepts both `/help start` and `/help /start`.
 * - Unknown command → general help with a note.
 */
export function formatCommandHelp(command?: string): string {
  if (!command) {
    return buildGeneralHelp();
  }

  const normalized = normalizeHelpTarget(command);
  const detail = DETAILED_HELP[normalized];
  if (!detail) {
    return `Unknown command "${command}".\n\n${buildGeneralHelp()}`;
  }

  return detail;
}

/**
 * Format a response for an unknown slash command.
 */
export function formatUnknownCommandResponse(attemptedCommand: string): string {
  return [
    `Unknown command: /${attemptedCommand}`,
    '',
    buildGeneralHelp(),
  ].join('\n');
}

/**
 * Format a response for an ambiguous /yes or /no (no code, but not exactly
 * one pending approval). Prefers codeful syntax in the example.
 */
export function formatAmbiguousApprovalResponse(
  action: 'approve' | 'reject',
  pendingCount: number,
): string {
  const command = action === 'approve' ? '/yes' : '/no';
  if (pendingCount === 0) {
    return [
      'You have no pending trade approvals.',
      '',
      'When an approval is pending, use the short code from the approval message:',
      `  ${command} 26B8D`,
      '',
      `${command} without a code only works when you have exactly one unresolved approval.`,
    ].join('\n');
  }

  return [
    `You have ${pendingCount} pending trade approvals. Use the short code from the approval message:`,
    '',
    `  /yes 26B8D  — approve`,
    `  /no 26B8D   — reject`,
  ].join('\n');
}

/**
 * Format a safe "not found" response for an invalid/foreign/expired code.
 * Does not leak whether the code belongs to another user.
 */
export function formatApprovalCodeNotFound(): string {
  return [
    'Approval code not found.',
    '',
    'It may have expired or already been resolved.',
    'Use /yes <code> or /no <code> with the exact code from your approval message.',
  ].join('\n');
}
