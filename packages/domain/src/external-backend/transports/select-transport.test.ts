import { describe, expect, it } from 'vitest';
import { ExternalBackendClient } from '../client.js';
import type { SigningIdentity } from '../sign.js';
import { McpTransport } from './mcp-transport.js';
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
    const select = createTransportSelector({
      ...BASE,
      toolProtocolOverrides: { submit_decision: 'mcp' },
      mcpPath: '/internal/v1/mcp',
    });

    // The endpoint protocol (rest) backs every tool without an override; the
    // override routes submit_decision to the shared mcp instance.
    expect(select('get_positions')).toBeInstanceOf(RestTransport);
    expect(select('submit_decision')).toBeInstanceOf(McpTransport);
    expect(select('submit_decision')).not.toBe(select('get_positions'));
  });

  it.each<[string, TransportSelectorOptions]>([
    ['as the endpoint protocol', { ...BASE, protocol: 'mcp', mcpPath: '/internal/v1/mcp' }],
    ['in a tool override', { ...BASE, toolProtocolOverrides: { get_quote: 'mcp' }, mcpPath: '/internal/v1/mcp' }],
  ])('registers the mcp transport for protocol mcp and per-tool overrides %s', (_label, options) => {
    const select = createTransportSelector(options);
    const forMcpTool = options.protocol === 'mcp' ? select(undefined) : select('get_quote');
    expect(forMcpTool).toBeInstanceOf(McpTransport);
  });

  it.each<[string, TransportSelectorOptions]>([
    ['as the endpoint protocol', { ...BASE, protocol: 'mcp' }],
    ['in a tool override', { ...BASE, toolProtocolOverrides: { get_quote: 'mcp' } }],
  ])('refuses protocol mcp without an mcpPath %s', (_label, options) => {
    expect(() => createTransportSelector(options)).toThrow(/^external_backend\.mcp_path_missing/);
  });

  it('a client configured for an unregistered protocol throws protocol_unavailable at construction', () => {
    // No transport is registered beyond rest + mcp; a protocol outside the set
    // is a fatal misconfiguration. (Exercised via a cast only in this guard
    // test — the config schema rejects an unknown protocol at load time.)
    const options = { ...BASE, protocol: 'grpc' as unknown as TransportSelectorOptions['protocol'] };
    expect(() => createTransportSelector(options)).toThrow(/^external_backend\.protocol_unavailable/);
  });

  it('a client configured for mcp without an mcpPath throws mcp_path_missing at construction', () => {
    expect(
      () =>
        new ExternalBackendClient({
          baseUrl: 'http://boundary.unit.test',
          consumerId: 'herobids',
          keyId: 'current',
          hmacSecret: 'unit-secret',
          requestTimeoutMs: 1_000,
          protocol: 'mcp',
        }),
    ).toThrow(/^external_backend\.mcp_path_missing/);
  });
});
