import { describe, it, expect } from 'vitest';
import { redact, redactJson } from './redaction.js';

describe('redact', () => {
  it('redacts OpenAI API key patterns', () => {
    const input = 'Using key sk-proj-abcdefghijklmnopqrstuvwxyz1234567890 for the request';
    const result = redact(input);
    expect(result).not.toContain('sk-proj-');
    expect(result).toContain('[REDACTED]');
  });

  it('redacts GitHub token patterns', () => {
    const input = 'Token: ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const result = redact(input);
    expect(result).not.toContain('ghp_');
    expect(result).toContain('[REDACTED]');
  });

  it('redacts AWS access key patterns', () => {
    const input = 'AWS key: AKIA1234567890ABCDEF';
    const result = redact(input);
    expect(result).not.toContain('AKIA');
    expect(result).toContain('[REDACTED]');
  });

  it('redacts JWT token patterns', () => {
    const input = 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0t5HpTBhD_nGoKYmEgQPfdEpQ';
    const result = redact(input);
    expect(result).not.toContain('eyJhbGci');
    expect(result).toContain('[REDACTED]');
  });

  it('does not redact benign text', () => {
    const input = 'The quick brown fox jumps over the lazy dog';
    const result = redact(input);
    expect(result).toBe(input);
  });

  it('redacts private key headers', () => {
    const input = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...';
    const result = redact(input);
    expect(result).not.toContain('PRIVATE KEY');
    expect(result).toContain('[REDACTED]');
  });

  it('handles empty string', () => {
    expect(redact('')).toBe('');
  });
});

describe('redactJson', () => {
  it('redacts secrets in string values', () => {
    const input = { message: 'key: sk-proj-abc123def456ghi789jkl012mno345pqr678stu', ok: true };
    const result = redactJson(input) as Record<string, unknown>;
    expect(result['message']).toContain('[REDACTED]');
    expect(result['ok']).toBe(true);
  });

  it('redacts secrets deeply in nested objects', () => {
    const input = {
      events: [
        { type: 'msg', payload: { text: 'token ghp_abc123def456ghi789jkl012mno345pqr678' } },
        { type: 'ok', value: 42 },
      ],
    };
    const result = redactJson(input) as Record<string, unknown>;
    const events = result['events'] as Array<Record<string, unknown>>;
    expect(events[0]!['payload']).toEqual({ text: 'token [REDACTED]' });
    expect(events[1]!['value']).toBe(42);
  });

  it('returns primitives unchanged', () => {
    expect(redactJson(42)).toBe(42);
    expect(redactJson(null)).toBe(null);
    expect(redactJson(true)).toBe(true);
  });

  it('returns non-mutated copy', () => {
    const input = { key: 'sk-proj-test1234567890abcdefghijklmn', extra: 'keep' };
    const result = redactJson(input);
    expect(input['key']).toBe('sk-proj-test1234567890abcdefghijklmn'); // original untouched
    expect((result as Record<string, unknown>)['key']).toBe('[REDACTED]');
  });
});
