import { describe, expect, it } from 'vitest';
import { parseTelegramCommand } from './telegram-command-parser.js';

describe('parseTelegramCommand', () => {
  const knownNames = ['Agent1', 'Agent2', 'DCA Bot', 'Momentum'];

  it('returns null for non-command messages', () => {
    expect(parseTelegramCommand('hello there', knownNames)).toBeNull();
  });

  it('parses a single bare target', () => {
    expect(parseTelegramCommand('/to Agent1 buy BTC', knownNames)).toEqual({
      targets: ['Agent1'],
      body: 'buy BTC',
    });
  });

  it('parses multiple bare targets', () => {
    expect(parseTelegramCommand('/to Agent1 Agent2 check P&L', knownNames)).toEqual({
      targets: ['Agent1', 'Agent2'],
      body: 'check P&L',
    });
  });

  it('parses quoted targets', () => {
    expect(parseTelegramCommand('/to "DCA Bot" run', knownNames)).toEqual({
      targets: ['DCA Bot'],
      body: 'run',
    });
    expect(parseTelegramCommand("/to 'DCA Bot' Agent2 run", knownNames)).toEqual({
      targets: ['DCA Bot', 'Agent2'],
      body: 'run',
    });
  });

  it('parses broadcast targets', () => {
    expect(parseTelegramCommand('/to all stop', knownNames)).toEqual({
      targets: ['all'],
      body: 'stop',
    });
    expect(parseTelegramCommand('/to * stop', knownNames)).toEqual({
      targets: ['*'],
      body: 'stop',
    });
  });

  it('falls back to default-routing input when no known target name is present', () => {
    expect(parseTelegramCommand('/to check BTC', knownNames)).toEqual({
      targets: [],
      body: 'check BTC',
    });
  });

  it('returns empty targets and body for /to alone', () => {
    expect(parseTelegramCommand('/to', knownNames)).toEqual({
      targets: [],
      body: '',
    });
  });
});