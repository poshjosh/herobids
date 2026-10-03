import { describe, expect, it } from 'vitest';
import { ExternalBackendClient } from '../client.js';
import type { SigningIdentity } from '../sign.js';
import { RestTransport } from './rest-transport.js';
import { createTransportSelector, type TransportSelectorOptions } from './select-transport.js';

const IDENTITY: SigningIdentity = { consumerId: 'herobids', keyId: 'current', secret: 'unit-secret' };
const BASE: TransportSelectorOptions = { baseUrl: 'http://boundary.unit.test', identity: IDENTITY, protocol: 'rest' };

describe('createTransportSelector', () => {
  it('uses the endpoint protocol for every tool by default', () => {
    const select = createTransportSelector(BASE);

    expect(select(undefined)).toBeInstanceOf(RestTransport);
    expect(select('submit_decision')).toBe(select(undefined));
    expect(select('get_positions')).toBe(select(undefined));
  });

  it('uses a per-tool override when present, with one instance per protocol', () => {
    // Only `rest` is registered until T2.3, so the override resolves to the shared rest instance.
    const select = createTransportSelector({ ...BASE, toolProtocolOverrides: { submit_decision: 'rest' } });

    expect(select('submit_decision')).toBeInstanceOf(RestTransport);
    expect(select('submit_decision')).toBe(select('get_positions'));
  });

  it.each<[string, TransportSelectorOptions]>([
    ['as the endpoint protocol', { ...BASE, protocol: 'mcp', mcpPath: '/mcp' }],
    ['in a tool override', { ...BASE, toolProtocolOverrides: { get_quote: 'mcp' }, mcpPath: '/mcp' }],
  ])('refuses at construction a protocol with no registered transport %s', (_label, options) => {
    expect(() => createTransportSelector(options)).toThrow(/^external_backend\.protocol_unavailable: .*'mcp'/);
  });

  it('a client configured for mcp throws external_backend.protocol_unavailable at construction', () => {
    expect(
      () =>
        new ExternalBackendClient({
          baseUrl: 'http://boundary.unit.test',
          consumerId: 'herobids',
          keyId: 'current',
          hmacSecret: 'unit-secret',
          requestTimeoutMs: 1_000,
          protocol: 'mcp',
          mcpPath: '/mcp',
        }),
    ).toThrow(/^external_backend\.protocol_unavailable/);
  });
});
