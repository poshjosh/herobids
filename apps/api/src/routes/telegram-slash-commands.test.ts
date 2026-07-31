import { describe, expect, it } from 'vitest';
import {
  parseSlashCommand,
  formatCommandHelp,
  formatUnknownCommandResponse,
  formatAmbiguousApprovalResponse,
  formatApprovalCodeNotFound,
} from './telegram-slash-commands.js';

// ─── parseSlashCommand ────────────────────────────────────────────────────

describe('parseSlashCommand', () => {
  it('returns null for plain text (non-slash message)', () => {
    expect(parseSlashCommand('hello there')).toBeNull();
    expect(parseSlashCommand('')).toBeNull();
    expect(parseSlashCommand('   ')).toBeNull();
  });

  it('parses a simple command with no args', () => {
    expect(parseSlashCommand('/agents')).toEqual({
      command: 'agents',
      rawCommand: '/agents',
      args: [],
    });
  });

  it('parses a command with a single arg', () => {
    expect(parseSlashCommand('/info Momentum')).toEqual({
      command: 'info',
      rawCommand: '/info',
      args: ['Momentum'],
    });
  });

  it('parses a command with multiple args', () => {
    expect(parseSlashCommand('/mode Momentum live')).toEqual({
      command: 'mode',
      rawCommand: '/mode',
      args: ['Momentum', 'live'],
    });
  });

  it('handles quoted agent names (double quotes)', () => {
    expect(parseSlashCommand('/start "DCA Bot"')).toEqual({
      command: 'start',
      rawCommand: '/start',
      args: ['DCA Bot'],
    });
  });

  it('handles quoted agent names (single quotes)', () => {
    expect(parseSlashCommand("/info 'Swing Trader'")).toEqual({
      command: 'info',
      rawCommand: '/info',
      args: ['Swing Trader'],
    });
  });

  it('handles mixed quoted and unquoted args', () => {
    expect(parseSlashCommand('/connect Momentum "Hyperliquid Main"')).toEqual({
      command: 'connect',
      rawCommand: '/connect',
      args: ['Momentum', 'Hyperliquid Main'],
    });
  });

  it('is case-insensitive for command names', () => {
    expect(parseSlashCommand('/HELP')).toEqual({
      command: 'help',
      rawCommand: '/HELP',
      args: [],
    });
    expect(parseSlashCommand('/Agents')).toEqual({
      command: 'agents',
      rawCommand: '/Agents',
      args: [],
    });
    expect(parseSlashCommand('/To agent msg')).toEqual({
      command: 'to',
      rawCommand: '/To',
      args: ['agent', 'msg'],
    });
  });

  it('strips bot mention suffix', () => {
    expect(parseSlashCommand('/help@MyBot')).toEqual({
      command: 'help',
      rawCommand: '/help@MyBot',
      args: [],
    });
    expect(parseSlashCommand('/start@TradingBot Momentum')).toEqual({
      command: 'start',
      rawCommand: '/start@TradingBot',
      args: ['Momentum'],
    });
  });

  it('handles /start with no args as start with empty args', () => {
    const result = parseSlashCommand('/start');
    expect(result).toEqual({
      command: 'start',
      rawCommand: '/start',
      args: [],
    });
  });

  it('handles /start with an agent name', () => {
    expect(parseSlashCommand('/start Momentum')).toEqual({
      command: 'start',
      rawCommand: '/start',
      args: ['Momentum'],
    });
  });

  it('handles /to with args (delegated to existing parser at call site)', () => {
    expect(parseSlashCommand('/to Momentum check BTC')).toEqual({
      command: 'to',
      rawCommand: '/to',
      args: ['Momentum', 'check', 'BTC'],
    });
  });

  it('returns unknown for unrecognized commands', () => {
    const result = parseSlashCommand('/foo bar');
    expect(result).toEqual({
      command: 'unknown',
      rawCommand: '/foo',
      args: ['foo'],
    });
  });

  it('strips bot suffix from unknown commands too', () => {
    const result = parseSlashCommand('/unknown@SomeBot');
    expect(result).toEqual({
      command: 'unknown',
      rawCommand: '/unknown@SomeBot',
      args: ['unknown'],
    });
  });

  it('handles /help with a command argument', () => {
    expect(parseSlashCommand('/help start')).toEqual({
      command: 'help',
      rawCommand: '/help',
      args: ['start'],
    });
    expect(parseSlashCommand('/help /start')).toEqual({
      command: 'help',
      rawCommand: '/help',
      args: ['/start'],
    });
  });

  it('handles extra whitespace gracefully', () => {
    expect(parseSlashCommand('  /info   Momentum  ')).toEqual({
      command: 'info',
      rawCommand: '/info',
      args: ['Momentum'],
    });
  });

  it('treats /to alone as having empty args', () => {
    expect(parseSlashCommand('/to')).toEqual({
      command: 'to',
      rawCommand: '/to',
      args: [],
    });
  });

  it('returns null for only a slash character', () => {
    // A single "/" is not a valid slash command prefix
    expect(parseSlashCommand('/')).toBeNull();
  });

  it('returns null for slash followed by only whitespace', () => {
    expect(parseSlashCommand('/   ')).toBeNull();
  });

  it('handles input with leading/trailing newlines', () => {
    expect(parseSlashCommand('\n/agents\n')).toEqual({
      command: 'agents',
      rawCommand: '/agents',
      args: [],
    });
    expect(parseSlashCommand('\r\n/info Momentum\r\n')).toEqual({
      command: 'info',
      rawCommand: '/info',
      args: ['Momentum'],
    });
  });

  it('handles very long command names', () => {
    const longCmd = '/verylongcommandname12345678901234567890 arg1';
    const result = parseSlashCommand(longCmd);
    expect(result).not.toBeNull();
    expect(result!.command).toBe('unknown');
    expect(result!.args).toEqual(['verylongcommandname12345678901234567890']);
  });

  it('handles command names with underscores and digits', () => {
    // Underscores and digits in bot names are stripped as part of the suffix
    const result = parseSlashCommand('/help@my_bot_123');
    expect(result).toEqual({
      command: 'help',
      rawCommand: '/help@my_bot_123',
      args: [],
    });
  });

  it('returns null for text containing a slash but not at start', () => {
    expect(parseSlashCommand('hello /agents')).toBeNull();
    expect(parseSlashCommand('check /info Momentum')).toBeNull();
  });

  it('parses /yes with no args', () => {
    expect(parseSlashCommand('/yes')).toEqual({
      command: 'yes',
      rawCommand: '/yes',
      args: [],
    });
  });

  it('parses /yes with a code', () => {
    expect(parseSlashCommand('/yes 26B8D')).toEqual({
      command: 'yes',
      rawCommand: '/yes',
      args: ['26B8D'],
    });
  });

  it('parses /no with no args', () => {
    expect(parseSlashCommand('/no')).toEqual({
      command: 'no',
      rawCommand: '/no',
      args: [],
    });
  });

  it('parses /no with a code', () => {
    expect(parseSlashCommand('/no 26B8D')).toEqual({
      command: 'no',
      rawCommand: '/no',
      args: ['26B8D'],
    });
  });

  it('parses /yes and /no case-insensitively', () => {
    expect(parseSlashCommand('/YES 26B8D')).toEqual({
      command: 'yes',
      rawCommand: '/YES',
      args: ['26B8D'],
    });
    expect(parseSlashCommand('/No 26B8D')).toEqual({
      command: 'no',
      rawCommand: '/No',
      args: ['26B8D'],
    });
  });

  it('strips bot suffix from /yes and /no', () => {
    expect(parseSlashCommand('/yes@MyBot 26B8D')).toEqual({
      command: 'yes',
      rawCommand: '/yes@MyBot',
      args: ['26B8D'],
    });
    expect(parseSlashCommand('/no@TradingBot AB12C')).toEqual({
      command: 'no',
      rawCommand: '/no@TradingBot',
      args: ['AB12C'],
    });
  });
});

// ─── formatCommandHelp ────────────────────────────────────────────────────

describe('formatCommandHelp', () => {
  it('returns general help when no argument is given', () => {
    const help = formatCommandHelp();
    expect(help).toContain('Available commands');
    expect(help).toContain('Help');
    expect(help).toContain('Discovery');
    expect(help).toContain('Lifecycle');
    expect(help).toContain('Config');
    expect(help).toContain('Messaging');
    expect(help).toContain('/help');
    expect(help).toContain('/agents');
    expect(help).toContain('/start');
    expect(help).toContain('/to');
  });

  it('returns detailed help for a known command (without slash)', () => {
    const help = formatCommandHelp('start');
    expect(help).toContain('/start <agent>');
    expect(help).toContain('Starts a stopped agent');
  });

  it('returns detailed help for a known command (with slash)', () => {
    const help = formatCommandHelp('/start');
    // Should normalize the leading slash away
    expect(help).toContain('/start <agent>');
    expect(help).toContain('Starts a stopped agent');
  });

  it('/help /start and /help start return the same detailed help', () => {
    const withSlash = formatCommandHelp('/start');
    const withoutSlash = formatCommandHelp('start');
    expect(withSlash).toBe(withoutSlash);
  });

  it('returns detailed help for /help command', () => {
    const help = formatCommandHelp('help');
    expect(help).toContain('/help [command]');
    expect(help).toContain('Shows available commands');
  });

  it('returns detailed help for all known commands', () => {
    const knownCommands = [
      'help', 'agents', 'info', 'log',
      'connections', 'start', 'pause', 'resume', 'stop',
      'restart', 'mode', 'connect', 'disconnect', 'to',
      'yes', 'no',
    ];
    for (const cmd of knownCommands) {
      const help = formatCommandHelp(cmd);
      expect(help, `Help for /${cmd} should not be empty`).toBeTruthy();
      expect(help.length, `Help for /${cmd} should have content`).toBeGreaterThan(10);
    }
  });

  it('returns general help with note for unknown command', () => {
    const help = formatCommandHelp('nonexistent');
    expect(help).toContain('Unknown command');
    expect(help).toContain('Available commands');
  });

  it('handles /help with a command prefixed by slash', () => {
    // /help /start should give the same as /help start
    const help = formatCommandHelp('/start');
    expect(help).toContain('/start <agent>');
    expect(help).toContain('Starts a stopped agent');
  });

  it('is case-insensitive for help targets', () => {
    const help = formatCommandHelp('START');
    expect(help).toContain('/start <agent>');
    expect(help).toContain('Starts a stopped agent');
  });

  it('handles empty string as no-arg general help', () => {
    const help = formatCommandHelp('');
    expect(help).toContain('Available commands');
  });

  it('general help includes /yes and /no in the approvals category', () => {
    const help = formatCommandHelp();
    expect(help).toContain('Trade Approvals');
    expect(help).toContain('/yes');
    expect(help).toContain('/no');
  });

  it('returns detailed help for /yes', () => {
    const help = formatCommandHelp('yes');
    expect(help).toContain('/yes [code]');
    expect(help).toContain('Approve a pending trade proposal');
    expect(help).toContain('/yes 26B8D');
  });

  it('returns detailed help for /no', () => {
    const help = formatCommandHelp('no');
    expect(help).toContain('/no [code]');
    expect(help).toContain('Reject a pending trade proposal');
    expect(help).toContain('/no 26B8D');
  });
});

// ─── formatUnknownCommandResponse ─────────────────────────────────────────

describe('formatUnknownCommandResponse', () => {
  it('includes the attempted command name and general help', () => {
    const response = formatUnknownCommandResponse('foobar');
    expect(response).toContain('Unknown command: /foobar');
    expect(response).toContain('Available commands');
  });
});

// ─── formatAmbiguousApprovalResponse ──────────────────────────────────────

describe('formatAmbiguousApprovalResponse', () => {
  it('returns no-pending message when count is 0', () => {
    const response = formatAmbiguousApprovalResponse('approve', 0);
    expect(response).toContain('no pending trade approvals');
    expect(response).toContain('/yes 26B8D');
    expect(response).not.toContain('/no');
  });

  it('returns no-pending message for reject when count is 0', () => {
    const response = formatAmbiguousApprovalResponse('reject', 0);
    expect(response).toContain('no pending trade approvals');
    expect(response).toContain('/no 26B8D');
  });

  it('returns multiple-pending message with codeful syntax', () => {
    const response = formatAmbiguousApprovalResponse('approve', 3);
    expect(response).toContain('3 pending trade approvals');
    expect(response).toContain('Approve: /yes 26B8D');
    expect(response).toContain('Reject:  /no 26B8D');
  });

  it('prefers codeful syntax in all cases', () => {
    for (const count of [0, 2, 5]) {
      const response = formatAmbiguousApprovalResponse('approve', count);
      expect(response).toContain('26B8D');
    }
  });
});

// ─── formatApprovalCodeNotFound ───────────────────────────────────────────

describe('formatApprovalCodeNotFound', () => {
  it('returns a safe message without leaking user information', () => {
    const response = formatApprovalCodeNotFound();
    expect(response).toContain('not found');
    expect(response).toContain('expired');
    expect(response).toContain('/yes CODE');
    expect(response).toContain('/no CODE');
    // Must not mention userId or ownership
    expect(response).not.toContain('belongs');
    expect(response).not.toContain('another user');
    expect(response).not.toContain('owner');
  });
});
