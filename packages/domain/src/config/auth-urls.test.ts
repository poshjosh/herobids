import { describe, expect, it } from 'vitest';
import { findLocalhostAuthViolations } from './auth-urls.js';

const REAL = { publicBaseUrl: 'https://staging.openaidom.com', frontendOrigin: 'https://staging.openaidom.com' };

describe('findLocalhostAuthViolations', () => {
  it.each([
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://127.5.5.5',
    'http://0.0.0.0:3000',
    'http://app.localhost:3000',
    'http://[::1]:3000',
  ])('flags %s in staging and production', (url) => {
    for (const environment of ['staging', 'production']) {
      expect(findLocalhostAuthViolations({ publicBaseUrl: url }, environment)).toHaveLength(1);
    }
  });

  it('flags every local auth URL, naming the env var', () => {
    const violations = findLocalhostAuthViolations(
      { publicBaseUrl: 'http://localhost:3000', frontendOrigin: 'http://localhost:5173' },
      'production',
    );
    expect(violations).toHaveLength(2);
    expect(violations[0]).toContain('AUTH_PUBLIC_BASE_URL');
    expect(violations[1]).toContain('AUTH_FRONTEND_ORIGIN');
  });

  it('flags an unparseable URL', () => {
    const violations = findLocalhostAuthViolations({ publicBaseUrl: 'not a url' }, 'staging');
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('not a valid URL');
  });

  it('accepts real hosts in staging and production', () => {
    expect(findLocalhostAuthViolations(REAL, 'staging')).toEqual([]);
    expect(findLocalhostAuthViolations({ publicBaseUrl: 'https://openaidom.com' }, 'production')).toEqual([]);
  });

  it('does not flag localhost-like hostnames that are not local', () => {
    expect(findLocalhostAuthViolations({ publicBaseUrl: 'https://localhost.example.com' }, 'staging')).toEqual([]);
  });

  it('ignores localhost in other environments', () => {
    for (const environment of ['development', 'test']) {
      expect(findLocalhostAuthViolations({ publicBaseUrl: 'http://localhost:3000' }, environment)).toEqual([]);
    }
  });

  it('skips keys that are not provided', () => {
    expect(findLocalhostAuthViolations({}, 'production')).toEqual([]);
  });
});
