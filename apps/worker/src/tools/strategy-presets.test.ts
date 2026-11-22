import { describe, it, expect, vi } from 'vitest';
import type {
  AgentTool,
  ExternalBackendReadResult,
  SelectedVenueAccountResolution,
  ToolResult,
  TradingToolContext,
} from '@herobids/domain';
import type { ExternalBackendClientResult, ExternalBackendSubject } from '@herobids/domain/external-backend';
import { strategyPresetTools } from './strategy-presets.js';
import { mapReadResultToToolResult, mapWriteResultToToolResult } from './external-backend-result.js';
import { createSubjectBoundWriteBoundary, type ExternalBackendWriteBoundary } from '../external-backend/write-adapter.js';

type ToolName = 'list_strategy_presets' | 'assess_strategy_preset' | 'change_strategy_preset';

function getTool(name: ToolName): AgentTool<TradingToolContext> {
  const found = strategyPresetTools.find((tool) => tool.name === name);
  if (!found) throw new Error(`tool not registered: ${name}`);
  return found;
}

const listTool = getTool('list_strategy_presets');
const assessTool = getTool('assess_strategy_preset');
const changeTool = getTool('change_strategy_preset');

type ReadPort = NonNullable<TradingToolContext['externalBackend']>;
type WritePort = NonNullable<TradingToolContext['externalBackendWrite']>;
type Resolver = NonNullable<TradingToolContext['selectedVenueAccountResolver']>;

const READY: SelectedVenueAccountResolution = { status: 'ready', venueAccountId: 'venue-account-1' };

function makeCtx(
  ports: {
    externalBackend?: ReadPort;
    externalBackendWrite?: WritePort;
    selectedVenueAccountResolver?: Resolver;
  } = {},
): TradingToolContext {
  return {
    agentId: 'agent-1',
    sessionId: 'session-1',
    executionMode: 'paper',
    authorizationMode: 'direct',
    ...ports,
  } as TradingToolContext;
}

/** Run a tool the way the runtime does: validate with its schema, then execute the parsed data. */
async function run(tool: AgentTool<TradingToolContext>, input: unknown, ctx: TradingToolContext): Promise<ToolResult> {
  const parsed: unknown = tool.parametersSchema.parse(input);
  return tool.execute(parsed, ctx);
}

function readPort(result: ExternalBackendReadResult) {
  const invoke = vi.fn<ReadPort['invoke']>(async () => result);
  return { port: { invoke }, invoke };
}

function writePort(result: ExternalBackendClientResult) {
  const invokeAndAwait = vi.fn<WritePort['invokeAndAwait']>(async () => result);
  return { port: { invokeAndAwait }, invokeAndAwait };
}

function ready(): Resolver {
  return vi.fn(async () => READY);
}

const WRITE_SUCCESS: ExternalBackendClientResult = {
  kind: 'success',
  requestId: 'req-1',
  correlationId: 'corr-1',
  payload: { ok: true, presetKey: 'trend-follower' },
};

const ASSESS_INPUT = { symbols: ['BTC', 'ETH'], venueFamily: 'hyperliquid' };
const CHANGE_INPUT = {
  assessmentArtifactId: 'artifact-1',
  targetPreset: 'trend-follower',
  mode: 'entries_only',
  reason: 'Trend flags are strong on BTC and ETH.',
};

describe('list_strategy_presets', () => {
  it('sends an empty payload when no style tier is given', async () => {
    const { port, invoke } = readPort({ kind: 'success', data: { presets: [] } });

    const result = await run(listTool, {}, makeCtx({ externalBackend: port }));

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith({ toolName: 'list_strategy_presets', payload: {} });
    expect(result).toEqual({ success: true, data: { presets: [] } });
  });

  it('sends the style tier when one is given', async () => {
    const { port, invoke } = readPort({ kind: 'success', data: { presets: [] } });

    await run(listTool, { styleTier: 'premium' }, makeCtx({ externalBackend: port }));

    expect(invoke).toHaveBeenCalledWith({ toolName: 'list_strategy_presets', payload: { styleTier: 'premium' } });
  });

  it('never resolves a venue account and never sends one, even when the model supplies it', async () => {
    const { port, invoke } = readPort({ kind: 'success', data: {} });
    const resolver = ready();

    await run(listTool, { venueAccountId: 'model-chosen' }, makeCtx({ externalBackend: port, selectedVenueAccountResolver: resolver }));

    expect(resolver).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith({ toolName: 'list_strategy_presets', payload: {} });
  });

  it('returns precondition.not_ready without a read boundary', async () => {
    const result = await run(listTool, {}, makeCtx());

    expect(result).toMatchObject({ success: false, errorCode: 'precondition.not_ready', fault: false });
  });

  it('maps traderton\'s "preset assessment not available" refusal to a non-fault validation error', async () => {
    const { port } = readPort({
      kind: 'failure',
      code: 'validation.invalid_payload',
      message: 'preset assessment not available in this context',
      retryable: false,
    });

    const result = await run(listTool, {}, makeCtx({ externalBackend: port }));

    expect(result).toMatchObject({
      success: false,
      errorCode: 'validation.invalid_payload',
      error: 'preset assessment not available in this context',
      fault: false,
    });
  });

  it('rejects an unknown style tier', () => {
    expect(listTool.parametersSchema.safeParse({ styleTier: 'ultra' }).success).toBe(false);
  });
});

describe('assess_strategy_preset', () => {
  it('sends symbols, venue family and the platform-resolved account, and returns the data untouched', async () => {
    const data = { artifactId: 'artifact-1', expiresAt: '2026-11-21T12:00:00.000Z', results: [] };
    const { port, invoke } = readPort({ kind: 'success', data });

    const result = await run(assessTool, ASSESS_INPUT, makeCtx({ externalBackend: port, selectedVenueAccountResolver: ready() }));

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith({
      toolName: 'assess_strategy_preset',
      payload: { symbols: ['BTC', 'ETH'], venueFamily: 'hyperliquid', venueAccountId: 'venue-account-1' },
    });
    expect(result).toEqual({ success: true, data });
  });

  it('includes instrumentKind only when the model passed it', async () => {
    const { port, invoke } = readPort({ kind: 'success', data: {} });
    const ctx = makeCtx({ externalBackend: port, selectedVenueAccountResolver: ready() });

    await run(assessTool, { ...ASSESS_INPUT, instrumentKind: 'perp' }, ctx);

    expect(invoke).toHaveBeenLastCalledWith({
      toolName: 'assess_strategy_preset',
      payload: { symbols: ['BTC', 'ETH'], venueFamily: 'hyperliquid', instrumentKind: 'perp', venueAccountId: 'venue-account-1' },
    });
  });

  it('strips a model-supplied venueAccountId and uses the resolver value', async () => {
    const { port, invoke } = readPort({ kind: 'success', data: {} });

    await run(
      assessTool,
      { ...ASSESS_INPUT, venueAccountId: 'attacker-account' },
      makeCtx({ externalBackend: port, selectedVenueAccountResolver: ready() }),
    );

    expect(invoke).toHaveBeenCalledWith({
      toolName: 'assess_strategy_preset',
      payload: { symbols: ['BTC', 'ETH'], venueFamily: 'hyperliquid', venueAccountId: 'venue-account-1' },
    });
  });

  it.each([
    ['no resolver is configured', undefined],
    ['no connection is granted', vi.fn(async (): Promise<SelectedVenueAccountResolution> => ({ status: 'missing' }))],
    ['the resolver throws', vi.fn(async (): Promise<SelectedVenueAccountResolution> => { throw new Error('db down'); })],
  ])('returns connection.missing without calling traderton when %s', async (_label, resolver) => {
    const { port, invoke } = readPort({ kind: 'success', data: {} });

    const result = await run(assessTool, ASSESS_INPUT, makeCtx({ externalBackend: port, selectedVenueAccountResolver: resolver }));

    expect(invoke).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, errorCode: 'connection.missing', errorOwner: 'user', fault: false });
  });

  it('returns connection.provisioning without calling traderton when the account is not resolved yet', async () => {
    const { port, invoke } = readPort({ kind: 'success', data: {} });
    const resolver: Resolver = vi.fn(async () => ({ status: 'provisioning' }));

    const result = await run(assessTool, ASSESS_INPUT, makeCtx({ externalBackend: port, selectedVenueAccountResolver: resolver }));

    expect(invoke).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, errorCode: 'connection.provisioning', fault: false });
  });

  it('returns precondition.not_ready without a read boundary', async () => {
    const resolver = ready();

    const result = await run(assessTool, ASSESS_INPUT, makeCtx({ selectedVenueAccountResolver: resolver }));

    expect(result).toMatchObject({ success: false, errorCode: 'precondition.not_ready', fault: false });
    expect(resolver).not.toHaveBeenCalled();
  });

  it('maps a transport error to a retryable platform fault', async () => {
    const { port } = readPort({ kind: 'transport_error', message: 'down', retryable: true });

    const result = await run(assessTool, ASSESS_INPUT, makeCtx({ externalBackend: port, selectedVenueAccountResolver: ready() }));

    expect(result).toMatchObject({
      success: false,
      errorCode: 'boundary.transport_error',
      errorOwner: 'platform',
      retryable: true,
      fault: true,
    });
  });

  it('maps an in-progress read to a retryable non-fault failure', async () => {
    const { port } = readPort({ kind: 'in_progress' });

    const result = await run(assessTool, ASSESS_INPUT, makeCtx({ externalBackend: port, selectedVenueAccountResolver: ready() }));

    expect(result).toMatchObject({ success: false, errorCode: 'boundary.in_progress', retryable: true, fault: false });
  });

  it('passes per-symbol failures inside a successful payload through untouched', async () => {
    const data = {
      artifactId: 'artifact-1',
      results: [{ symbol: 'BTC', error: { code: 'assessment.cooldown_blocked', nextEligibleAt: '2026-11-21T12:00:00.000Z' } }],
    };
    const { port } = readPort({ kind: 'success', data });

    const result = await run(assessTool, ASSESS_INPUT, makeCtx({ externalBackend: port, selectedVenueAccountResolver: ready() }));

    expect(result).toEqual({ success: true, data });
  });

  it('rejects an empty symbols array, more than 50 symbols and a missing venue family', () => {
    expect(assessTool.parametersSchema.safeParse({ symbols: [], venueFamily: 'hyperliquid' }).success).toBe(false);
    expect(
      assessTool.parametersSchema.safeParse({ symbols: Array.from({ length: 51 }, (_, i) => `S${i}`), venueFamily: 'hyperliquid' }).success,
    ).toBe(false);
    expect(assessTool.parametersSchema.safeParse({ symbols: ['BTC'] }).success).toBe(false);
  });
});

describe('change_strategy_preset', () => {
  it('writes through the write port with the exact payload and a 30 s deadline, never the read port', async () => {
    const { port, invokeAndAwait } = writePort(WRITE_SUCCESS);
    const read = readPort({ kind: 'success', data: {} });

    const result = await run(
      changeTool,
      CHANGE_INPUT,
      makeCtx({ externalBackend: read.port, externalBackendWrite: port, selectedVenueAccountResolver: ready() }),
    );

    expect(invokeAndAwait).toHaveBeenCalledTimes(1);
    expect(invokeAndAwait).toHaveBeenCalledWith({
      toolName: 'change_strategy_preset',
      payload: { ...CHANGE_INPUT, venueAccountId: 'venue-account-1' },
      deadlineMs: 30_000,
    });
    expect(read.invoke).not.toHaveBeenCalled();
    expect(result).toEqual({ success: true, data: { ok: true, presetKey: 'trend-follower' } });
  });

  it('supplies no idempotency key itself', async () => {
    const { port, invokeAndAwait } = writePort(WRITE_SUCCESS);

    await run(changeTool, CHANGE_INPUT, makeCtx({ externalBackendWrite: port, selectedVenueAccountResolver: ready() }));

    const call = invokeAndAwait.mock.calls[0]?.[0];
    expect(call && 'idempotencyKey' in call).toBe(false);
  });

  it('uses a fresh idempotency key per call and binds no venue account to the subject when wired through the real write binding', async () => {
    const subject: ExternalBackendSubject = { ownerId: 'owner-1', actor: { type: 'agent', id: 'agent-1' } };
    const invokeAndAwait = vi.fn<ExternalBackendWriteBoundary['invokeAndAwait']>(async () => WRITE_SUCCESS);
    const boundary: ExternalBackendWriteBoundary = {
      invoke: vi.fn<ExternalBackendWriteBoundary['invoke']>(async () => WRITE_SUCCESS),
      invokeAndAwait,
    };
    const ctx = makeCtx({
      externalBackendWrite: createSubjectBoundWriteBoundary(boundary, subject),
      selectedVenueAccountResolver: ready(),
    });

    await run(changeTool, CHANGE_INPUT, ctx);
    await run(changeTool, CHANGE_INPUT, ctx);

    const [first, second] = [invokeAndAwait.mock.calls[0]?.[0], invokeAndAwait.mock.calls[1]?.[0]];
    expect(first?.toolName).toBe('change_strategy_preset');
    expect(first?.subject).toEqual(subject);
    expect(first?.idempotencyKey).toBeTruthy();
    expect(second?.idempotencyKey).toBeTruthy();
    expect(second?.idempotencyKey).not.toBe(first?.idempotencyKey);
  });

  it('strips a model-supplied venueAccountId and idempotencyKey', async () => {
    const { port, invokeAndAwait } = writePort(WRITE_SUCCESS);

    await run(
      changeTool,
      { ...CHANGE_INPUT, venueAccountId: 'attacker-account', idempotencyKey: 'model-key' },
      makeCtx({ externalBackendWrite: port, selectedVenueAccountResolver: ready() }),
    );

    expect(invokeAndAwait).toHaveBeenCalledWith({
      toolName: 'change_strategy_preset',
      payload: { ...CHANGE_INPUT, venueAccountId: 'venue-account-1' },
      deadlineMs: 30_000,
    });
  });

  it.each([
    ['no resolver is configured', undefined, 'connection.missing'],
    ['no connection is granted', vi.fn(async (): Promise<SelectedVenueAccountResolution> => ({ status: 'missing' })), 'connection.missing'],
    ['the resolver throws', vi.fn(async (): Promise<SelectedVenueAccountResolution> => { throw new Error('db down'); }), 'connection.missing'],
    ['the account is provisioning', vi.fn(async (): Promise<SelectedVenueAccountResolution> => ({ status: 'provisioning' })), 'connection.provisioning'],
  ])('returns a typed connection error without calling traderton when %s', async (_label, resolver, code) => {
    const { port, invokeAndAwait } = writePort(WRITE_SUCCESS);

    const result = await run(changeTool, CHANGE_INPUT, makeCtx({ externalBackendWrite: port, selectedVenueAccountResolver: resolver }));

    expect(invokeAndAwait).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, errorCode: code, fault: false });
  });

  it('returns precondition.not_ready without a write boundary', async () => {
    const resolver = ready();

    const result = await run(changeTool, CHANGE_INPUT, makeCtx({ selectedVenueAccountResolver: resolver }));

    expect(result).toMatchObject({ success: false, errorCode: 'precondition.not_ready', fault: false });
    expect(resolver).not.toHaveBeenCalled();
  });

  it.each([
    ['validation.invalid_payload', false, false],
    ['precondition.not_ready', true, false],
    ['authorization.denied', false, false],
    ['upstream.transient', true, true],
  ] as const)('maps a %s failure preserving code and retryability (fault: %s -> %s)', async (code, retryable, fault) => {
    const { port } = writePort({
      kind: 'failure',
      requestId: 'req-1',
      correlationId: 'corr-1',
      code,
      message: 'Request a fresh assessment before changing your preset',
      retryable,
    });

    const result = await run(changeTool, CHANGE_INPUT, makeCtx({ externalBackendWrite: port, selectedVenueAccountResolver: ready() }));

    expect(result).toMatchObject({
      success: false,
      error: 'Request a fresh assessment before changing your preset',
      errorCode: code,
      retryable,
      fault,
    });
  });

  it('maps an unknown outcome at the deadline to a retryable precondition.not_ready', async () => {
    const { port } = writePort({ kind: 'in_progress', requestId: 'req-1', correlationId: 'corr-1' });

    const result = await run(changeTool, CHANGE_INPUT, makeCtx({ externalBackendWrite: port, selectedVenueAccountResolver: ready() }));

    expect(result).toMatchObject({ success: false, errorCode: 'precondition.not_ready', retryable: true, fault: false });
  });

  it('rejects any mode other than entries_only and a missing mode', () => {
    expect(changeTool.parametersSchema.safeParse({ ...CHANGE_INPUT, mode: 'exit_all' }).success).toBe(false);
    const { mode: _mode, ...withoutMode } = CHANGE_INPUT;
    expect(changeTool.parametersSchema.safeParse(withoutMode).success).toBe(false);
  });

  it.each(['reason', 'assessmentArtifactId', 'targetPreset'] as const)('rejects an empty %s', (field) => {
    expect(changeTool.parametersSchema.safeParse({ ...CHANGE_INPUT, [field]: '' }).success).toBe(false);
  });
});

describe('strategy preset tool schemas', () => {
  const expectedRequired: Record<ToolName, string[]> = {
    list_strategy_presets: [],
    assess_strategy_preset: ['symbols', 'venueFamily'],
    change_strategy_preset: ['assessmentArtifactId', 'targetPreset', 'mode', 'reason'],
  };

  it.each(strategyPresetTools.map((tool) => [tool.name, tool] as const))(
    '%s describes every parameter and never exposes the venue account',
    (_name, tool) => {
      const properties = tool.parameters['properties'];
      expect(properties).toBeTypeOf('object');
      const entries = Object.entries(properties as Record<string, { description?: unknown }>);
      for (const [key, schema] of entries) {
        expect(typeof schema.description, `${tool.name}.${key} needs a description`).toBe('string');
        expect(String(schema.description).length, `${tool.name}.${key} description is empty`).toBeGreaterThan(0);
      }
      expect(entries.map(([key]) => key)).not.toContain('venueAccountId');
    },
  );

  it.each(strategyPresetTools.map((tool) => [tool.name, tool] as const))(
    '%s lists exactly the required parameters',
    (name, tool) => {
      const required = tool.parameters['required'];
      expect([...(required as string[])].sort()).toEqual([...expectedRequired[name as ToolName]].sort());
    },
  );

  it('uses the categories the catalog declares and carries no prompt guidance', () => {
    expect(listTool.category).toBe('read-config');
    expect(assessTool.category).toBe('read-market-data');
    expect(changeTool.category).toBe('write-database');
    for (const tool of strategyPresetTools) expect(tool.promptGuidance).toBeUndefined();
  });
});

// ── Property sweeps (table-driven; the repo has no fast-check) ───────────────

type ToolCase = { tool: AgentTool<TradingToolContext>; input: unknown; port: 'read' | 'write'; scoped: boolean };

const TOOL_CASES: ToolCase[] = [
  { tool: listTool, input: {}, port: 'read', scoped: false },
  { tool: assessTool, input: ASSESS_INPUT, port: 'read', scoped: true },
  { tool: changeTool, input: CHANGE_INPUT, port: 'write', scoped: true },
];

const ACCOUNT_STATES: Array<[string, Resolver | undefined, string | undefined]> = [
  ['ready', ready(), undefined],
  ['missing', async () => ({ status: 'missing' }), 'connection.missing'],
  ['provisioning', async () => ({ status: 'provisioning' }), 'connection.provisioning'],
  ['throwing', async () => { throw new Error('db down'); }, 'connection.missing'],
  ['absent', undefined, 'connection.missing'],
];

describe('port and account matrix', () => {
  describe.each(TOOL_CASES)('$tool.name', ({ tool, input, port, scoped }) => {
    it.each([true, false])('with the boundary present=%s, resolves to exactly one allowed outcome', async (present) => {
      for (const [label, resolver, connectionCode] of ACCOUNT_STATES) {
        const read = readPort({ kind: 'success', data: { ok: true } });
        const write = writePort(WRITE_SUCCESS);
        const ctx = makeCtx({
          ...(present && port === 'read' ? { externalBackend: read.port } : {}),
          ...(present && port === 'write' ? { externalBackendWrite: write.port } : {}),
          selectedVenueAccountResolver: resolver,
        });

        const result = await run(tool, input, ctx);
        const calls = read.invoke.mock.calls.length + write.invokeAndAwait.mock.calls.length;

        if (!present) {
          expect(result, label).toMatchObject({ success: false, errorCode: 'precondition.not_ready', fault: false });
          expect(calls, label).toBe(0);
        } else if (scoped && connectionCode) {
          expect(result, label).toMatchObject({ success: false, errorCode: connectionCode, fault: false });
          expect(calls, label).toBe(0);
        } else {
          expect(result.success, label).toBe(true);
          expect(calls, label).toBe(1);
        }
      }
    });
  });
});

describe('result mapping is the shared mapper', () => {
  const readResults: ExternalBackendReadResult[] = [
    { kind: 'success', data: { a: 1 } },
    { kind: 'failure', code: 'validation.invalid_payload', message: 'm', retryable: false },
    { kind: 'failure', code: 'not_found.resource', message: 'm', retryable: false },
    { kind: 'failure', code: 'precondition.not_ready', message: 'm', retryable: true },
    { kind: 'failure', code: 'authorization.denied', message: 'm', retryable: false },
    { kind: 'failure', code: 'upstream.transient', message: 'm', retryable: true },
    { kind: 'failure', code: 'internal.non_retryable', message: 'm', retryable: false },
    { kind: 'in_progress' },
    { kind: 'transport_error', message: 'down', retryable: true },
  ];

  const writeResults: ExternalBackendClientResult[] = [
    WRITE_SUCCESS,
    ...(['validation.invalid_payload', 'not_found.resource', 'precondition.not_ready', 'authorization.denied', 'upstream.transient', 'internal.non_retryable'] as const).flatMap(
      (code) =>
        [true, false].map((retryable): ExternalBackendClientResult => ({
          kind: 'failure',
          requestId: 'req-1',
          correlationId: 'corr-1',
          code,
          message: 'm',
          retryable,
        })),
    ),
    { kind: 'in_progress', requestId: 'req-1', correlationId: 'corr-1' },
    { kind: 'transport_error', requestId: 'req-1', retryable: true, message: 'down' },
  ];

  it.each([assessTool, listTool])('$name returns the read mapper output for every result kind', async (tool) => {
    for (const backendResult of readResults) {
      const { port } = readPort(backendResult);
      const result = await run(tool, tool === assessTool ? ASSESS_INPUT : {}, makeCtx({ externalBackend: port, selectedVenueAccountResolver: ready() }));
      expect(result).toEqual(mapReadResultToToolResult(backendResult));
    }
  });

  it('change_strategy_preset returns the write mapper output for every result kind', async () => {
    for (const backendResult of writeResults) {
      const { port } = writePort(backendResult);
      const result = await run(changeTool, CHANGE_INPUT, makeCtx({ externalBackendWrite: port, selectedVenueAccountResolver: ready() }));
      expect(result).toEqual(mapWriteResultToToolResult(backendResult));
    }
  });
});

describe('payload keys', () => {
  const ALLOWED_KEYS: Record<ToolName, string[]> = {
    list_strategy_presets: ['styleTier'],
    assess_strategy_preset: ['symbols', 'venueFamily', 'instrumentKind', 'venueAccountId'],
    change_strategy_preset: ['assessmentArtifactId', 'targetPreset', 'mode', 'reason', 'venueAccountId'],
  };

  const SMUGGLED = {
    venueAccountId: 'attacker-account',
    idempotencyKey: 'model-key',
    ownerId: 'someone-else',
    actor: { type: 'user', id: 'u1' },
    deadlineMs: 1,
    toolName: 'adjust_risk_limits',
    unknownKey: true,
  };
  const PROTO = JSON.parse('{"__proto__": {"polluted": true}, "constructor": "x"}') as Record<string, unknown>;

  it.each(TOOL_CASES)('$tool.name sends no key outside its payload table', async ({ tool, input }) => {
    for (const extra of [{}, SMUGGLED, PROTO, { ...SMUGGLED, ...PROTO }]) {
      const read = readPort({ kind: 'success', data: {} });
      const write = writePort(WRITE_SUCCESS);
      const ctx = makeCtx({ externalBackend: read.port, externalBackendWrite: write.port, selectedVenueAccountResolver: ready() });

      await run(tool, { ...(input as Record<string, unknown>), ...extra }, ctx);

      const sent = read.invoke.mock.calls[0]?.[0].payload ?? write.invokeAndAwait.mock.calls[0]?.[0].payload;
      expect(sent).toBeTypeOf('object');
      const keys = Object.keys(sent as Record<string, unknown>);
      const allowed = ALLOWED_KEYS[tool.name as ToolName];
      expect(keys.filter((key) => !allowed.includes(key))).toEqual([]);
      if (keys.includes('venueAccountId')) {
        expect((sent as Record<string, unknown>)['venueAccountId']).toBe('venue-account-1');
      }
    }
  });
});
