// Cross-stack transport parity (Phase 3 T2.3, n36 → P3-43). The REAL herobids
// client — RestTransport AND McpTransport — against the REAL traderton boundary
// route over a local cross-stack docker bring-up. It is the executable guard
// that the signer↔verifier contract and the §2.5 wire mapping hold end to end:
// real McpTransport → real `/internal/v1/mcp` route → real Postgres.
//
// GATED, never run in the ordinary suites: it only runs when
// HEROBIDS_XSTACK_TRANSPORT_PARITY=1 (set process-scoped by run-all-tests.sh
// step 5, so G3's shell stays clean). It reads config from the worker's real
// loadConfig() + resolveConfiguredExternalBackend (secret from the herobids
// .env), and ASSERTS baseUrl === http://localhost:8080 before any call — it
// never contacts an ambient URL. The MCP legs skip with a loud warning if the
// boundary was not brought up with the MCP route (GET → not 405).
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ExternalBackendProtocol } from '@herobids/domain';
import {
  buildExternalBackendClientConfig,
  createExternalBackendClient,
  type ExternalBackendClientConfig,
  type ExternalBackendClientResult,
  type ExternalBackendSubject,
} from '@herobids/domain/external-backend';
import { loadConfig, resolveConfiguredExternalBackend } from '../../config.js';

const ENABLED = process.env['HEROBIDS_XSTACK_TRANSPORT_PARITY'] === '1';
// Hard-coded (n36): the cross-stack boundary is always published here. The test
// never reads a URL from the ambient env — it ASSERTS the config resolves to it.
const EXPECTED_BASE_URL = 'http://localhost:8080';
const MCP_PATH = '/internal/v1/mcp';

const SUBJECT: ExternalBackendSubject = {
  ownerId: `xstack-parity-${randomUUID()}`,
  actor: { type: 'system', id: 'xstack-transport-parity' },
};

interface Resolved {
  base: ExternalBackendClientConfig;
}

function clientFor(base: ExternalBackendClientConfig, protocol: ExternalBackendProtocol): ReturnType<typeof createExternalBackendClient> {
  return createExternalBackendClient({ ...base, protocol, ...(protocol === 'mcp' ? { mcpPath: MCP_PATH } : {}) });
}

/** Whether the boundary exposes the MCP route — a 405 on GET means "mounted, POST-only". */
async function mcpRouteMounted(): Promise<boolean> {
  try {
    const response = await fetch(`${EXPECTED_BASE_URL}${MCP_PATH}`, { method: 'GET' });
    return response.status === 405;
  } catch {
    return false;
  }
}

describe.skipIf(!ENABLED)('cross-stack transport parity against the local traderton boundary', () => {
  let resolved: Resolved | undefined;
  let mcpAvailable = false;

  beforeAll(async () => {
    const config = loadConfig();
    const result = resolveConfiguredExternalBackend(config, config.tradingBackendId);
    if (!result.ok) {
      throw new Error(`xstack parity: the trading backend did not resolve (${result.error.code}); check the herobids .env`);
    }
    const base = buildExternalBackendClientConfig(result.data.definition, result.data.hmacSecret);
    // The leg asserts the real config points at the known cross-stack address
    // before any call — a misconfigured baseUrl must fail loudly, not silently
    // hit something else.
    expect(base.baseUrl).toBe(EXPECTED_BASE_URL);
    resolved = { base };

    mcpAvailable = await mcpRouteMounted();
    if (!mcpAvailable) {
      // Loud warning (R5): a herobids checkout run against a traderton without
      // the MCP route must show the MCP legs skipped, not silently pass.
      console.warn(
        '[xstack parity] MCP route not mounted at ' +
          `${EXPECTED_BASE_URL}${MCP_PATH} (GET did not return 405). ` +
          'MCP legs are SKIPPED. To run them, rebuild the traderton boundary from a ' +
          'checkout that always mounts the MCP route.',
      );
    }
  });

  function base(): ExternalBackendClientConfig {
    if (!resolved) throw new Error('xstack parity: config not resolved');
    return resolved.base;
  }

  // Each protocol leg: REST always runs; MCP runs only when the route is mounted.
  function legIt(name: string, body: (protocol: ExternalBackendProtocol) => Promise<void>): void {
    it(`${name} over rest`, async () => {
      await body('rest');
    });
    it(`${name} over mcp`, async () => {
      if (!mcpAvailable) {
        console.warn(`[xstack parity] skipping MCP leg "${name}" — route not mounted`);
        return;
      }
      await body('mcp');
    });
  }

  const DEADLINE_MS = 15_000;
  function deadline(): string {
    return new Date(Date.now() + DEADLINE_MS).toISOString();
  }

  // A read tool with no seeded state (traderton registry: ownerScopedNoVenue).
  legIt('a read tool returns the same success outcome', async (protocol) => {
    const result = await clientFor(base(), protocol).invoke({
      toolName: 'get_operator_defaults',
      payload: {},
      subject: SUBJECT,
      deadlineAt: deadline(),
    });
    expect(result.kind).toBe('success');
  });

  // remove_watch on an unknown uuid is a deterministic terminal result the
  // store replays for a same key (traderton: validation.invalid_payload "watch
  // … not found", stored and replayable). A fresh uuid per run keeps the key
  // state-free.
  legIt('a same-key write replays the first terminal result', async (protocol) => {
    const client = clientFor(base(), protocol);
    const idempotencyKey = `xstack-replay-${randomUUID()}`;
    const payload = { watchId: randomUUID() };
    const write = { toolName: 'remove_watch', payload, subject: SUBJECT, idempotencyKey, deadlineAt: deadline() };

    const first = await client.invokeAndAwait(write);
    const second = await client.invokeAndAwait(write);

    expect(terminalKind(first)).not.toBe('transport_error');
    expect(second).toEqual(first);
  });

  legIt('a reused key with a changed payload is rejected as validation.invalid_payload', async (protocol) => {
    const client = clientFor(base(), protocol);
    const idempotencyKey = `xstack-changed-${randomUUID()}`;

    await client.invokeAndAwait({
      toolName: 'remove_watch',
      payload: { watchId: randomUUID() },
      subject: SUBJECT,
      idempotencyKey,
      deadlineAt: deadline(),
    });
    const changed = await client.invokeAndAwait({
      toolName: 'remove_watch',
      payload: { watchId: randomUUID() }, // different payload, same key
      subject: SUBJECT,
      idempotencyKey,
      deadlineAt: deadline(),
    });

    expect(changed).toMatchObject({ kind: 'failure', code: 'validation.invalid_payload' });
  });

  it('a key first used over rest replays over mcp without a second execution', async () => {
    if (!mcpAvailable) {
      console.warn('[xstack parity] skipping cross-transport replay — MCP route not mounted');
      return;
    }
    const idempotencyKey = `xstack-cross-${randomUUID()}`;
    const payload = { watchId: randomUUID() };
    const write = { toolName: 'remove_watch', payload, subject: SUBJECT, idempotencyKey, deadlineAt: deadline() };

    const viaRest = await clientFor(base(), 'rest').invokeAndAwait(write);
    const viaMcp = await clientFor(base(), 'mcp').invokeAndAwait({ ...write, deadlineAt: deadline() });

    // Same stored terminal result replayed across transports (same requestId).
    expect(terminalKind(viaRest)).not.toBe('transport_error');
    expect(viaMcp.requestId).toBe(viaRest.requestId);
    if (viaRest.kind === 'failure' && viaMcp.kind === 'failure') {
      expect(viaMcp.code).toBe(viaRest.code);
    } else {
      expect(viaMcp.kind).toBe(viaRest.kind);
    }
  });
});

function terminalKind(result: ExternalBackendClientResult): ExternalBackendClientResult['kind'] {
  return result.kind;
}
