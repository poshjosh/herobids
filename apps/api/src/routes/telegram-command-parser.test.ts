import { describe, expect, it } from 'vitest';
import { parseTelegramCommand } from './telegram-command-parser.js';

describe('parseTelegramCommand', () => {
  it('returns null for non-command messages', () => {
    expect(parseTelegramCommand('hello there')).toBeNull();
  });

  it('parses a single bare target', () => {
    expect(parseTelegramCommand('/to Agent1 buy BTC')).toEqual({
      targets: ['Agent1'],
      body: 'buy BTC',
    });
  });

  it('parses an unknown bare target — target name is syntax-only, no lookup required', () => {
    expect(parseTelegramCommand('/to UnknownAgent buy BTC')).toEqual({
      targets: ['UnknownAgent'],
      body: 'buy BTC',
    });
  });

  it('parses multiple quoted targets', () => {
    expect(parseTelegramCommand('/to "DCA Bot" run')).toEqual({
      targets: ['DCA Bot'],
      body: 'run',
    });
    expect(parseTelegramCommand("/to 'DCA Bot' \"Agent2\" run")).toEqual({
      targets: ['DCA Bot', 'Agent2'],
      body: 'run',
    });
  });

  it('stops at the first bare token — second bare word is body, not another target', () => {
    expect(parseTelegramCommand('/to Agent1 Agent2 check P&L')).toEqual({
      targets: ['Agent1'],
      body: 'Agent2 check P&L',
    });
  });

  it('parses broadcast targets', () => {
    expect(parseTelegramCommand('/to all stop')).toEqual({
      targets: ['all'],
      body: 'stop',
    });
    expect(parseTelegramCommand('/to * stop')).toEqual({
      targets: ['*'],
      body: 'stop',
    });
  });

  it('parses the first bare token as a target even when it could be a body word', () => {
    expect(parseTelegramCommand('/to check BTC')).toEqual({
      targets: ['check'],
      body: 'BTC',
    });
  });

  it('returns empty targets and body for /to alone', () => {
    expect(parseTelegramCommand('/to')).toEqual({
      targets: [],
      body: '',
    });
  });
});