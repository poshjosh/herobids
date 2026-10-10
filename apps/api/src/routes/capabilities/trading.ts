import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import type { Redis } from 'ioredis';
import { eq, and, inArray } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { deriveReadiness } from '@herobids/db';
import type { RuntimeAssignmentRow } from '@herobids/db';
import {
  agents,
  connections,
  agentConnectionAudit,
  agentConnections,
  agentRuntimeSessions,
} from '@herobids/db';
import type { PlansConfig, RuntimeBudgetPolicy } from '@herobids/domain';
import { getProviderIdsForRuntimeFamily, getRuntimeFamiliesForProvider } from '@herobids/domain';
import type { ExternalBackendClient, ExternalBackendSubject } from '@herobids/domain/external-backend';
import { z } from 'zod';
import { errorPayload } from '../../error-payload.js';
import {
  createTradertonReadBoundary,
  loadAgentEvidence,
  loadBoundaryObject,
  toFillRow,
  toJournalRow,
  toPositionRow,
  type FillRow as ReadFillRow,
  type JournalRow as ReadJournalRow,
  type PositionRow as ReadPositionRow,
  type ReadBoundaryError,
} from '../exports-traderton.js';
import type {
  CapabilityAttribute,
  CapabilityCell,
  CapabilityFeed,
  CapabilityFeedColumn,
  CapabilityFeedItem,
  CapabilityPresentation,
} from './presentation.js';
import {
  closedTradeDetails,
  findClosingFill,
  formatDecimal,
  formatDuration,
  formatSignedPnl,
  holdMsOf,
  indexFillsByPositionKey,
  summarizeTrades,
} from './trading-ledger.js';
const SUPPORTED_ACTIONS = ['start', 'stop', 'pause', 'resume'] as const;
type TradingAction = typeof SUPPORTED_ACTIONS[number];

const PauseActionSchema = z.object({
  reason: z.string().min(1).max(500),
});

const MAX_ACTIVITY_LIMIT = 200;
const MAX_ACTIVITY_OFFSET = 500;
const MAX_ACTIVITY_WINDOW = 700;

const TradingActivityQuerySchema = z.object({
  limit: z.coerce.number().int().min(0).max(MAX_ACTIVITY_LIMIT).default(50),
  offset: z.coerce.number().int().min(0).max(MAX_ACTIVITY_OFFSET).default(0),
});

const TradingPositionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(0).max(MAX_ACTIVITY_LIMIT).default(50),
  offset: z.coerce.number().int().min(0).max(MAX_ACTIVITY_OFFSET).default(0),
});

type TradingAssignmentRow = RuntimeAssignmentRow & {
  id: string;
  revokedAt: Date | null;
};

type TradingConnectionResourceRow = {
  id: string;
  userId: string;
  credentialId: string | null;
  provider: string;
  label: string;
  status: string;
  providerRef: string | null;
  profile: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
};

const SUPPORTED_TRADING_PROVIDERS = ['hyperliquid', 'jupiter', '1inch', 'bybit'] as const;

function chooseLatestAssignment(rows: TradingAssignmentRow[]): TradingAssignmentRow | undefined {
  if (rows.length === 0) {
    return undefined;
  }
  return rows.slice().sort((left, right) => {
    const grantedAtDelta = right.grantedAt.getTime() - left.grantedAt.getTime();
    if (grantedAtDelta !== 0) {
      return grantedAtDelta;
    }
    return right.id.localeCompare(left.id);
  })[0];
}

async function selectAgentTradingAssignmentRows(db: Database, agentId: string): Promise<TradingAssignmentRow[]> {
  const rows = await db
    .select({
      id: agentConnections.id,
      assignmentId: agentConnections.id,
      grantStatus: agentConnections.status,
      grantedAt: agentConnections.grantedAt,
      revokedAt: agentConnections.revokedAt,
      connectionId: connections.id,
      connectionStatus: connections.status,
      providerRef: connections.providerRef,
      profile: connections.profile,
      provider: connections.provider,
      label: connections.label,
      resolvedVenueAccountId: connections.resolvedVenueAccountId,
    })
    .from(agentConnections)
    .innerJoin(connections, eq(agentConnections.connectionId, connections.id))
    .where(and(
      eq(agentConnections.agentId, agentId),
      inArray(connections.provider, getProviderIdsForRuntimeFamily('trading')),
    ));

  return rows.map((row) => ({
    ...row,
    capabilities: getRuntimeFamiliesForProvider(row.provider),
  }));
}

function latestAssignmentPerConnection(rows: TradingAssignmentRow[]): TradingAssignmentRow[] {
  const sorted = rows.slice().sort((left, right) => {
    const grantedAtDelta = right.grantedAt.getTime() - left.grantedAt.getTime();
    if (grantedAtDelta !== 0) {
      return grantedAtDelta;
    }
    return right.id.localeCompare(left.id);
  });

  const seen = new Set<string>();
  const latest: TradingAssignmentRow[] = [];
  for (const row of sorted) {
    if (seen.has(row.connectionId)) {
      continue;
    }
    seen.add(row.connectionId);
    latest.push(row);
  }
  return latest;
}

async function selectTradingConnectionResourceRows(db: Database, userId: string): Promise<TradingConnectionResourceRow[]> {
  return db
    .select()
    .from(connections)
    .where(eq(connections.userId, userId));
}

const MAX_PRESENTATION_LIMIT = 100;
const DEFAULT_PRESENTATION_LIMIT = 20;

const PresentationQuerySchema = z.object({
  connectionId: z.string().min(1).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PRESENTATION_LIMIT).default(DEFAULT_PRESENTATION_LIMIT),
});

/** A `get_agent_decisions` row (subset the presentation needs; `createdAt` rehydrated to Date). */
interface DecisionRow {
  id: string;
  intent: string;
  createdAt: Date;
  instrumentId?: string | null;
  venueAccountId?: string | null;
  /** Latest execution-plan status: `pending|executing|completed|failed`, or null when no plan exists. */
  status: string | null;
}

/** Rehydrate a decision record's `createdAt` (arrives as an ISO string over JSON). */
function toDecisionRow(record: unknown): DecisionRow {
  const r = record as Record<string, unknown>;
  const createdAtRaw = r['createdAt'];
  const createdAt = createdAtRaw instanceof Date
    ? createdAtRaw
    : new Date(typeof createdAtRaw === 'string' ? createdAtRaw : Date.now());
  if (Number.isNaN(createdAt.getTime())) {
    throw new Error(`Invalid date for field "createdAt": ${String(createdAtRaw)}`);
  }
  const intent = typeof r['intent'] === 'string' ? r['intent'] : '';
  const instrumentId = typeof r['instrumentId'] === 'string' ? r['instrumentId'] : null;
  const venueAccountId = typeof r['venueAccountId'] === 'string' ? r['venueAccountId'] : null;
  const status = typeof r['status'] === 'string' ? r['status'] : null;
  return {
    id: typeof r['id'] === 'string' ? r['id'] : '',
    intent,
    createdAt,
    instrumentId: instrumentId ?? undefined,
    venueAccountId: venueAccountId ?? undefined,
    status,
  };
}

/** Narrow the `get_account_summary` success payload to the fields the presentation needs. */
interface AccountSummary {
  capital: string | null;
  capitalAvailable: boolean;
  executionMode: string | null;
  openPositionCount: number;
  positionSizeMode: string | null;
  warnings?: string[];
}

function accountSummaryOf(record: Record<string, unknown>): AccountSummary {
  const capital = typeof record['capital'] === 'string' ? (record['capital'] as string) : null;
  return {
    capital,
    capitalAvailable: record['capitalAvailable'] === true,
    executionMode: typeof record['executionMode'] === 'string' ? (record['executionMode'] as string) : null,
    openPositionCount: typeof record['openPositionCount'] === 'number' ? (record['openPositionCount'] as number) : 0,
    positionSizeMode: typeof record['positionSizeMode'] === 'string' ? (record['positionSizeMode'] as string) : null,
    warnings: Array.isArray(record['warnings']) && (record['warnings'] as unknown[]).every((w) => typeof w === 'string')
      ? (record['warnings'] as string[])
      : undefined,
  };
}

/** Fallback read deadline when the operator boundary timeout is not supplied. */
const DEFAULT_READ_TIMEOUT_MS = 10_000;

export async function tradingCapabilityRoutes(
  app: FastifyInstance,
  db: Database,
  _plansConfig: PlansConfig | undefined,
  _budgets: RuntimeBudgetPolicy,
  _redisClient?: Redis,
  tradertonReadClient?: ExternalBackendClient,
  tradertonReadTimeoutMs?: number,
): Promise<void> {
  const readDeadlineMs = tradertonReadTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;

  /**
   * Build a read boundary bound to the requesting user's subject for an agent's
   * trading evidence. Returns null when the boundary is unconfigured so the
   * endpoint can surface a typed precondition (mandatory-boundary posture — no
   * local trading read). Mirrors `agentReadBoundary` in exports.ts.
   */
  const agentReadBoundary = (userId: string, agentId: string) => {
    if (!tradertonReadClient) return null;
    const subject: ExternalBackendSubject = { ownerId: userId, actor: { type: 'agent', id: agentId } };
    return createTradertonReadBoundary(tradertonReadClient, subject, readDeadlineMs);
  };

  const boundaryUnconfiguredError: ReadBoundaryError = {
    status: 503,
    code: 'precondition.not_ready',
    message: 'The capability service is unavailable — the request could not be produced.',
  };

  app.get('/capabilities/trading', async (_request, reply) => {
    return reply.send({
      family: 'trading',
      description: 'Algorithmic trading across multiple venues',
      status: 'available',
      supportedActions: [...SUPPORTED_ACTIONS],
      providers: [...SUPPORTED_TRADING_PROVIDERS],
      readinessStates: ['unconfigured', 'provisioning', 'ready', 'degraded', 'revoked'],
    });
  });

  app.get('/capabilities/trading/providers', async (_request, reply) => {
    return reply.send({
      providers: [
        { provider: 'hyperliquid', type: 'perpetuals', status: 'available' },
        { provider: 'jupiter', type: 'swap', status: 'available' },
        { provider: '1inch', type: 'swap', status: 'available' },
        { provider: 'bybit', type: 'perpetuals', status: 'available' },
      ],
    });
  });

  app.get('/capabilities/trading/connections', async (request, reply) => {
    const rows = await selectTradingConnectionResourceRows(db, request.userId);

    return reply.send({
      family: 'trading',
      connections: rows.map((row) => ({
        connectionId: row.id,
        provider: row.provider,
        label: row.label,
        providerRef: row.providerRef,
        profile: row.profile ?? null,
        status: row.status,
        family: 'trading',
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
    });
  });

  app.get<{ Params: { agentId: string } }>(
    '/agents/:agentId/capabilities/trading',
    async (request, reply) => {
      const { agentId } = request.params;

      const [agent] = await db
        .select({ id: agents.id, status: agents.status })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.userId, request.userId)));
      if (!agent) {
        return reply.status(404).send({ error: 'agent.not_found' });
      }

      const rows = await selectAgentTradingAssignmentRows(db, agentId);
      const effectiveReady = rows.some((row) =>
        row.grantStatus === 'active' &&
        row.connectionStatus === 'active' &&
        row.resolvedVenueAccountId !== null,
      );

      return reply.send({
        agentId,
        family: 'trading',
        agentStatus: agent.status,
        effectiveReady,
        supportedActions: [...SUPPORTED_ACTIONS],
      });
    },
  );

  app.get<{ Params: { agentId: string } }>(
    '/agents/:agentId/capabilities/trading/state',
    async (request, reply) => {
      const { agentId } = request.params;

      const [agent] = await db
        .select({ id: agents.id, status: agents.status })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.userId, request.userId)));
      if (!agent) {
        return reply.status(404).send({ error: 'agent.not_found' });
      }

      const boundary = agentReadBoundary(request.userId, agentId);
      if (!boundary) {
        return reply.status(boundaryUnconfiguredError.status).send(
          errorPayload(boundaryUnconfiguredError.code, boundaryUnconfiguredError.message),
        );
      }
      const loaded = await loadAgentEvidence<ReadPositionRow>(
        boundary,
        'get_agent_positions',
        {},
        'positions',
        toPositionRow,
      );
      if (!loaded.ok) {
        return reply.status(loaded.error.status).send(
          errorPayload(loaded.error.code, loaded.error.message),
        );
      }
      const positionRows = loaded.rows;

      if (positionRows.length === 0) {
        return reply.send({
          agentId,
          family: 'trading',
          agentStatus: agent.status,
          totalPnl: '0',
          openPositionCount: 0,
          updatedAt: new Date().toISOString(),
        });
      }

      const totalPnl = positionRows.reduce((acc, p) => acc + parseFloat(p.realizedPnl), 0);
      const openPositionCount = positionRows.filter((p) => p.closedAt === null).length;

      return reply.send({
        agentId,
        family: 'trading',
        agentStatus: agent.status,
        totalPnl: totalPnl.toFixed(6),
        openPositionCount,
        updatedAt: new Date().toISOString(),
      });
    },
  );

  app.get<{ Params: { agentId: string } }>(
    '/agents/:agentId/capabilities/trading/readiness',
    async (request, reply) => {
      const { agentId } = request.params;

      const [agent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.userId, request.userId)));
      if (!agent) {
        return reply.status(404).send({ error: 'agent.not_found' });
      }

      const rows = await selectAgentTradingAssignmentRows(db, agentId);
      // Active assignments take precedence.
      const activeRows = rows.filter((r) => r.grantStatus === 'active');
      if (activeRows.length > 0) {
        const latest = chooseLatestAssignment(activeRows)!;
        return reply.send(deriveReadiness(latest, 'trading'));
      }
      // Surface 'revoked' only when the connection itself was revoked. If only
      // the agent grant was removed (PATCH connectionIds: []), return 'unconfigured'.
      const connectionRevokedRows = rows.filter((r) => r.connectionStatus === 'revoked');
      const latest = chooseLatestAssignment(connectionRevokedRows);
      return reply.send(deriveReadiness(latest, 'trading'));
    },
  );

  app.get<{
    Params: { agentId: string; family: string };
    Querystring: { connectionId?: string; cursor?: string; limit?: string };
  }>(
    '/agents/:agentId/capabilities/:family/presentation',
    async (request, reply) => {
      const { agentId, family } = request.params;
      const queryResult = PresentationQuerySchema.safeParse(request.query);
      if (!queryResult.success) {
        return reply.status(400).send({ error: 'validation_error', details: queryResult.error.issues });
      }
      // `limit` caps the rows shown in each feed (trades, decisions, fills); the
      // P&L summary totals are over the FULL filtered set, not the capped rows.
      // `cursor` / `nextCursor` pagination is deferred — the `cursor` query param
      // is accepted but not consumed yet.
      const { connectionId, limit } = queryResult.data;

      // 1. Ownership.
      const [agent] = await db
        .select({ id: agents.id, unifiedConfig: agents.unifiedConfig })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.userId, request.userId)));
      if (!agent) {
        return reply.status(404).send({ error: 'agent.not_found' });
      }

      // Herobids-owned display value (non-enforcing) from the agent's unifiedConfig.
      const uc = agent.unifiedConfig as Record<string, unknown> | null;
      const authMode = uc?.['authorizationMode'];
      const authorizationMode = typeof authMode === 'string' && authMode.length > 0 ? authMode : 'direct';

      // 2. Family gate — only trading is implemented.
      if (family !== 'trading') {
        return reply.status(404).send({ error: 'capability.not_found' });
      }

      // 4. Resolve the connection (same rules as /connections + /readiness).
      const rows = await selectAgentTradingAssignmentRows(db, agentId);

      let assignment: TradingAssignmentRow | undefined;
      if (connectionId) {
        // Explicit connection must be an ACTIVE binding for this agent+family.
        const active = rows.find((r) => r.connectionId === connectionId && r.grantStatus === 'active' && r.connectionStatus === 'active');
        const ready = active && active.resolvedVenueAccountId !== null ? active : undefined;
        assignment = ready;
      } else {
        // Default-ready then first-ready (newest grant wins, matching chooseLatestAssignment).
        // No ready connection → no usable binding, so the endpoint emits connection: null.
        const readyRows = rows.filter((r) =>
          r.grantStatus === 'active' && r.connectionStatus === 'active' && r.resolvedVenueAccountId !== null && r.resolvedVenueAccountId !== '');
        assignment = readyRows.length > 0 ? chooseLatestAssignment(readyRows) : undefined;
      }

      const ready = assignment && assignment.grantStatus === 'active' && assignment.connectionStatus === 'active' && assignment.resolvedVenueAccountId !== null && assignment.resolvedVenueAccountId !== '';

      if (!ready || !assignment) {
        return reply.send({
          family: 'trading',
          connection: null,
          attributes: [],
          feeds: [],
        } satisfies CapabilityPresentation);
      }

      const resolvedVenueAccountId = assignment.resolvedVenueAccountId as string;

      // 5. Source data over the traderton boundary.
      const boundary = agentReadBoundary(request.userId, agentId);
      if (!boundary) {
        return reply.status(boundaryUnconfiguredError.status).send(
          errorPayload(boundaryUnconfiguredError.code, boundaryUnconfiguredError.message),
        );
      }

      // Fetch the four reads concurrently to offset the mark latency the
      // `includeMarks: true` positions read adds, but check `.ok` in a DETERMINISTIC
      // order (summary → positions → decisions → fills) so the surfaced error — and
      // the 503/404 status mapping — is identical to the previous sequential reads.
      const [summaryLoaded, positionsLoaded, decisionsLoaded, fillsLoaded] = await Promise.all([
        loadBoundaryObject(boundary, 'get_account_summary', { venueAccountId: resolvedVenueAccountId }),
        loadAgentEvidence<ReadPositionRow>(boundary, 'get_agent_positions', { includeMarks: true }, 'positions', toPositionRow),
        loadAgentEvidence<DecisionRow>(boundary, 'get_agent_decisions', { limit }, 'decisions', toDecisionRow),
        loadAgentEvidence<ReadFillRow>(boundary, 'get_agent_fills', {}, 'fills', toFillRow),
      ]);
      if (!summaryLoaded.ok) {
        return reply.status(summaryLoaded.error.status).send(
          errorPayload(summaryLoaded.error.code, summaryLoaded.error.message),
        );
      }
      if (!positionsLoaded.ok) {
        return reply.status(positionsLoaded.error.status).send(
          errorPayload(positionsLoaded.error.code, positionsLoaded.error.message),
        );
      }
      if (!decisionsLoaded.ok) {
        return reply.status(decisionsLoaded.error.status).send(
          errorPayload(decisionsLoaded.error.code, decisionsLoaded.error.message),
        );
      }
      if (!fillsLoaded.ok) {
        return reply.status(fillsLoaded.error.status).send(
          errorPayload(fillsLoaded.error.code, fillsLoaded.error.message),
        );
      }
      const summary = accountSummaryOf(summaryLoaded.data);

      // 6. Scope positions/fills to the selected connection's venue account
      // BEFORE summarizing (same cross-connection rule as the feeds). Totals use
      // the filtered FULL set; the tables slice to `limit` after sorting.
      const scopedPositions = positionsLoaded.rows.filter((p) => p.venueAccountId === resolvedVenueAccountId);
      const scopedFills = fillsLoaded.rows.filter((f) => f.venueAccountId === resolvedVenueAccountId);

      const now = new Date();
      const fillIndex = indexFillsByPositionKey(scopedFills);
      const totals = summarizeTrades(scopedPositions);

      // 7. P&L summary tiles (primary) + account attributes (secondary). Every
      // attribute carries a `labelKey`; the English `label`/`value` are the
      // fallback the web renders until the i18n catalog (Item 6) lands.
      const realizedPnl = formatSignedPnl(totals.realized.toFixed());
      const unrealizedPnl = totals.unrealized === null
        ? { value: '—', emphasis: 'neutral' as const }
        : formatSignedPnl(totals.unrealized.toFixed());

      // Never present a partial sum as the total: when any open mark is missing,
      // the total is realized-only and relabelled "closed trades only".
      const totalPnl = totals.unrealized === null
        ? formatSignedPnl(totals.realized.toFixed())
        : formatSignedPnl(totals.realized.plus(totals.unrealized).toFixed());
      const totalPnlLabel = totals.unrealized === null
        ? { label: 'Total profit / loss (closed trades only)', labelKey: 'capability.trading.attr.totalPnlClosedOnly' }
        : { label: 'Total profit / loss', labelKey: 'capability.trading.attr.totalPnl' };

      const attributes: CapabilityAttribute[] = [
        {
          key: 'total-pnl',
          label: totalPnlLabel.label,
          labelKey: totalPnlLabel.labelKey,
          value: totalPnl.value,
          emphasis: totalPnl.emphasis,
          prominence: 'primary',
        },
        {
          key: 'realized-pnl',
          label: 'From closed trades',
          labelKey: 'capability.trading.attr.realizedPnl',
          value: realizedPnl.value,
          emphasis: realizedPnl.emphasis,
          prominence: 'primary',
        },
        {
          key: 'unrealized-pnl',
          label: 'From open trades',
          labelKey: 'capability.trading.attr.unrealizedPnl',
          value: unrealizedPnl.value,
          emphasis: unrealizedPnl.emphasis,
          prominence: 'primary',
        },
        {
          key: 'winning-trades',
          label: 'Winning trades',
          labelKey: 'capability.trading.attr.winningTrades',
          value: `${totals.wins} of ${totals.closed}`,
          valueKey: 'capability.trading.value.winsOfClosed',
          valueParams: { wins: String(totals.wins), closed: String(totals.closed) },
          emphasis: 'neutral',
          prominence: 'primary',
        },
      ];

      // Warnings and an unavailable-capital flag stay visible (primary) — hiding a
      // blocking state would bury it. The web only follows `prominence`.
      if (summary.warnings && summary.warnings.length > 0) {
        attributes.push({
          key: 'warnings',
          label: 'Warnings',
          labelKey: 'capability.trading.attr.warnings',
          value: summary.warnings.join(', '),
          emphasis: 'warning',
          prominence: 'primary',
        });
      }
      if (summary.capitalAvailable === false) {
        attributes.push({
          key: 'capital',
          label: 'Capital',
          labelKey: 'capability.trading.attr.capital',
          value: summary.capital ?? 'Not set',
          valueKey: summary.capital === null ? 'capability.trading.value.notSet' : undefined,
          emphasis: 'warning',
          prominence: 'primary',
        });
      }

      // Secondary account attributes (rendered inside a Details disclosure).
      attributes.push(
        {
          key: 'connection',
          label: 'Connection',
          labelKey: 'capability.trading.attr.connection',
          value: assignment.label,
          emphasis: 'neutral',
          prominence: 'secondary',
        },
        {
          key: 'execution-mode',
          label: 'Execution mode',
          labelKey: 'capability.trading.attr.executionMode',
          value: summary.executionMode ?? 'Not set',
          valueKey: summary.executionMode === null
            ? 'capability.trading.value.notSet'
            : `capability.trading.executionMode.${summary.executionMode}`,
          emphasis: 'neutral',
          prominence: 'secondary',
        },
        {
          key: 'authorization-mode',
          label: 'Authorization',
          labelKey: 'capability.trading.attr.authorization',
          value: authorizationMode,
          valueKey: `capability.trading.authorization.${authorizationMode}`,
          emphasis: 'neutral',
          prominence: 'secondary',
        },
        {
          key: 'position-size-mode',
          label: 'Position size mode',
          labelKey: 'capability.trading.attr.positionSizeMode',
          value: summary.positionSizeMode ?? 'Not set',
          valueKey: summary.positionSizeMode === null ? 'capability.trading.value.notSet' : undefined,
          emphasis: 'neutral',
          prominence: 'secondary',
        },
        {
          key: 'open-positions',
          label: 'Open trades',
          labelKey: 'capability.trading.attr.openPositions',
          value: String(summary.openPositionCount),
          emphasis: 'neutral',
          prominence: 'secondary',
        },
      );
      // Capital is only a secondary attribute when it IS available — the
      // unavailable case is already surfaced above as a primary warning.
      if (summary.capitalAvailable !== false) {
        attributes.push({
          key: 'capital',
          label: 'Capital',
          labelKey: 'capability.trading.attr.capital',
          value: summary.capital ?? 'Not set',
          valueKey: summary.capital === null ? 'capability.trading.value.notSet' : undefined,
          emphasis: 'neutral',
          prominence: 'secondary',
        });
      }

      // 8. Feeds. The web renders cells verbatim and acts only on emphasis; the
      // `valueKey`s localize word values (direction/status/side) in Item 6.

      const tradesColumns: CapabilityFeedColumn[] = [
        { key: 'when', label: 'When', labelKey: 'capability.trading.col.when', align: 'start', format: 'timestamp' },
        { key: 'asset', label: 'Asset', labelKey: 'capability.trading.col.asset', align: 'start', format: 'text' },
        { key: 'direction', label: 'Direction', labelKey: 'capability.trading.col.direction', align: 'start', format: 'text' },
        { key: 'size', label: 'Size', labelKey: 'capability.trading.col.size', align: 'end', format: 'text' },
        { key: 'entryPrice', label: 'Entry price', labelKey: 'capability.trading.col.entryPrice', align: 'end', format: 'text' },
        { key: 'exitPrice', label: 'Exit price', labelKey: 'capability.trading.col.exitPrice', align: 'end', format: 'text' },
        { key: 'pnl', label: 'Profit / loss', labelKey: 'capability.trading.col.pnl', align: 'end', format: 'text' },
        { key: 'heldFor', label: 'Held for', labelKey: 'capability.trading.col.heldFor', align: 'end', format: 'text' },
        { key: 'status', label: 'Status', labelKey: 'capability.trading.col.status', align: 'start', format: 'text' },
      ];

      const directionCell = (direction: 'long' | 'short' | null): CapabilityCell => {
        if (direction === null) return { value: '—', emphasis: 'neutral' };
        return {
          value: direction === 'long' ? 'Long' : 'Short',
          valueKey: `capability.trading.value.${direction}`,
          emphasis: 'neutral',
        };
      };

      const tradeRows = scopedPositions
        .slice()
        .sort((a, b) => b.openedAt.getTime() - a.openedAt.getTime())
        .slice(0, limit)
        .map((p): CapabilityFeedItem => {
          const isClosed = p.closedAt !== null;
          const held = formatDuration(holdMsOf(p, now));
          const statusCell: CapabilityCell = {
            value: isClosed ? 'Closed' : 'Open',
            valueKey: isClosed ? 'capability.trading.value.closed' : 'capability.trading.value.open',
            emphasis: 'neutral',
          };

          let direction: 'long' | 'short' | null;
          let sizeCell: CapabilityCell;
          let exitCell: CapabilityCell;
          let pnlCell: CapabilityCell;
          if (isClosed) {
            const closed = closedTradeDetails(p, fillIndex);
            direction = closed.direction;
            // On full close the position row carries side:'flat'/size:'0', so size
            // is not representable for a closed trade — render the em-dash (Decision 7).
            sizeCell = { value: '—', emphasis: 'neutral' };
            exitCell = { value: closed.exitPrice ?? '—', emphasis: 'neutral' };
            pnlCell = formatSignedPnl(p.realizedPnl);
          } else {
            direction = p.side === 'long' || p.side === 'short' ? p.side : null;
            sizeCell = { value: formatDecimal(p.size), emphasis: 'neutral' };
            exitCell = { value: '—', emphasis: 'neutral' };
            pnlCell = formatSignedPnl(p.unrealizedPnl ?? null);
          }

          const dirCell = directionCell(direction);

          return {
            id: p.id,
            title: p.symbol,
            detail: `${dirCell.value} · ${pnlCell.value}`,
            occurredAt: p.openedAt.toISOString(),
            emphasis: pnlCell.emphasis,
            cells: {
              when: { value: p.openedAt.toISOString(), emphasis: 'neutral' },
              asset: { value: p.symbol, emphasis: 'neutral' },
              direction: dirCell,
              size: sizeCell,
              entryPrice: { value: formatDecimal(p.entryPrice), emphasis: 'neutral' },
              exitPrice: exitCell,
              pnl: pnlCell,
              heldFor: held,
              status: statusCell,
            },
          };
        });

      const tradesFeed: CapabilityFeed = {
        key: 'trades',
        label: 'Trades',
        labelKey: 'capability.trading.feed.trades',
        prominence: 'primary',
        columns: tradesColumns,
        items: tradeRows,
      };

      // Decisions carry a non-null `venueAccountId` at the source; the null branch
      // guards against a missing/non-string `venueAccountId` in the untracked
      // boundary payload. Scope to the selected connection's venue account.
      const decisionStatusCell = (status: string | null): CapabilityCell => {
        if (status === null) {
          return { value: 'Not executed', valueKey: 'capability.trading.decisionStatus.none', emphasis: 'neutral' };
        }
        return {
          value: status,
          valueKey: `capability.trading.decisionStatus.${status}`,
          emphasis: status === 'failed' ? 'warning' : 'neutral',
        };
      };

      const decisionsFeed: CapabilityFeed = {
        key: 'decisions',
        label: 'Decisions',
        labelKey: 'capability.trading.feed.decisions',
        prominence: 'secondary',
        items: decisionsLoaded.rows
          .filter((d) => !d.venueAccountId || d.venueAccountId === resolvedVenueAccountId)
          .slice(0, limit)
          .map((d): CapabilityFeedItem => ({
            id: d.id,
            title: d.intent.replace(/_/g, ' '),
            titleKey: `capability.trading.intent.${d.intent}`,
            detail: d.instrumentId ?? undefined,
            occurredAt: d.createdAt.toISOString(),
            badge: decisionStatusCell(d.status),
          })),
      };

      const fillsColumns: CapabilityFeedColumn[] = [
        { key: 'when', label: 'When', labelKey: 'capability.trading.col.when', align: 'start', format: 'timestamp' },
        { key: 'asset', label: 'Asset', labelKey: 'capability.trading.col.asset', align: 'start', format: 'text' },
        { key: 'side', label: 'Side', labelKey: 'capability.trading.col.side', align: 'start', format: 'text' },
        { key: 'quantity', label: 'Quantity', labelKey: 'capability.trading.col.quantity', align: 'end', format: 'text' },
        { key: 'price', label: 'Price', labelKey: 'capability.trading.col.price', align: 'end', format: 'text' },
        { key: 'pnl', label: 'Profit / loss', labelKey: 'capability.trading.col.pnl', align: 'end', format: 'text' },
      ];

      const sideCell = (side: string): CapabilityCell => {
        const normalized = side.toLowerCase();
        if (normalized === 'buy' || normalized === 'sell') {
          return {
            value: normalized === 'buy' ? 'Buy' : 'Sell',
            valueKey: `capability.trading.value.${normalized}`,
            emphasis: 'neutral',
          };
        }
        return { value: side, emphasis: 'neutral' };
      };

      const fillRows = scopedFills
        .slice()
        .sort((a, b) => b.filledAt.getTime() - a.filledAt.getTime())
        .slice(0, limit)
        .map((f): CapabilityFeedItem => {
          const pnlCell = formatSignedPnl(f.realizedPnlDelta);
          return {
            id: f.id,
            title: `${f.side} ${f.symbol}`,
            detail: `${f.quantity} @ ${f.price}`,
            occurredAt: f.filledAt.toISOString(),
            emphasis: pnlCell.emphasis,
            cells: {
              when: { value: f.filledAt.toISOString(), emphasis: 'neutral' },
              asset: { value: f.symbol, emphasis: 'neutral' },
              side: sideCell(f.side),
              quantity: { value: formatDecimal(f.quantity), emphasis: 'neutral' },
              price: { value: formatDecimal(f.price), emphasis: 'neutral' },
              pnl: pnlCell,
            },
          };
        });

      const fillsFeed: CapabilityFeed = {
        key: 'fills',
        label: 'Fills',
        labelKey: 'capability.trading.feed.fills',
        prominence: 'secondary',
        columns: fillsColumns,
        items: fillRows,
      };

      return reply.send({
        family: 'trading',
        connection: { id: assignment.connectionId, label: assignment.label, state: 'ready' as const },
        attributes,
        feeds: [tradesFeed, decisionsFeed, fillsFeed],
      } satisfies CapabilityPresentation);
    },
  );

  app.get<{ Params: { agentId: string } }>(
    '/agents/:agentId/capabilities/trading/connections',
    async (request, reply) => {
      const { agentId } = request.params;

      const [agent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.userId, request.userId)));
      if (!agent) {
        return reply.status(404).send({ error: 'agent.not_found' });
      }

      const rows = await selectAgentTradingAssignmentRows(db, agentId);
      return reply.send({
        agentId,
        family: 'trading',
        connections: latestAssignmentPerConnection(rows).map((row) => ({
          connectionId: row.connectionId,
          provider: row.provider,
          label: row.label,
          providerRef: row.providerRef,
          profile: row.profile,
          connectionStatus: row.connectionStatus,
          grantStatus: row.grantStatus,
          readiness: deriveReadiness(row, 'trading'),
          grantedAt: row.grantedAt.toISOString(),
          revokedAt: row.revokedAt?.toISOString() ?? null,
          family: 'trading',
        })),
      });
    },
  );

  app.get<{ Params: { agentId: string; connectionId: string } }>(
    '/agents/:agentId/capabilities/trading/connections/:connectionId',
    async (request, reply) => {
      const { agentId, connectionId } = request.params;

      const [agent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.userId, request.userId)));
      if (!agent) {
        return reply.status(404).send({ error: 'agent.not_found' });
      }

      const [conn] = await db
        .select()
        .from(connections)
        .where(and(eq(connections.id, connectionId), eq(connections.userId, request.userId)));
      if (!conn) {
        return reply.status(404).send({ error: 'connection.not_found' });
      }

      const rows = (await selectAgentTradingAssignmentRows(db, agentId)).filter((row) => row.connectionId === connectionId);
      if (rows.length === 0) {
        return reply.status(404).send({ error: 'connection.not_found' });
      }

      const latestAssignment = chooseLatestAssignment(rows)!;
      return reply.send({
        connectionId: conn.id,
        provider: conn.provider,
        label: conn.label,
        providerRef: conn.providerRef,
        profile: conn.profile ?? null,
        connectionStatus: conn.status,
        status: latestAssignment.grantStatus,
        readiness: deriveReadiness(latestAssignment, 'trading'),
        grantedAt: latestAssignment.grantedAt.toISOString(),
        revokedAt: latestAssignment.revokedAt?.toISOString() ?? null,
        family: 'trading',
      });
    },
  );

  app.get<{ Params: { agentId: string; connectionId: string } }>(
    '/agents/:agentId/capabilities/trading/connections/:connectionId/audit',
    async (request, reply) => {
      const { agentId, connectionId } = request.params;

      const [agent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.userId, request.userId)));
      if (!agent) {
        return reply.status(404).send({ error: 'agent.not_found' });
      }

      const rows = (await selectAgentTradingAssignmentRows(db, agentId)).filter((row) => row.connectionId === connectionId);
      if (rows.length === 0) {
        return reply.status(404).send({ error: 'connection.not_found' });
      }

      const acIds = rows.map((row) => row.id);

      let auditEntries: typeof agentConnectionAudit.$inferSelect[] = [];
      if (acIds.length > 0) {
        auditEntries = await db
          .select()
          .from(agentConnectionAudit)
          .where(inArray(agentConnectionAudit.agentConnectionId, acIds))
          .orderBy(agentConnectionAudit.createdAt);
      }

      return reply.send({ connectionId, audit: auditEntries });
    },
  );

  app.get<{
    Params: { agentId: string };
    Querystring: { limit?: string; offset?: string };
  }>(
    '/agents/:agentId/capabilities/trading/activity',
    async (request, reply) => {
      const { agentId } = request.params;
      const queryResult = TradingActivityQuerySchema.safeParse(request.query);
      if (!queryResult.success) {
        return reply.status(400).send({ error: 'validation_error', details: queryResult.error.issues });
      }
      const { limit, offset } = queryResult.data;
      const fetchCount = Math.min(limit + offset, MAX_ACTIVITY_WINDOW);

      const [agent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.userId, request.userId)));
      if (!agent) {
        return reply.status(404).send({ error: 'agent.not_found' });
      }

      const boundary = agentReadBoundary(request.userId, agentId);
      if (!boundary) {
        return reply.status(boundaryUnconfiguredError.status).send(
          errorPayload(boundaryUnconfiguredError.code, boundaryUnconfiguredError.message),
        );
      }
      const fillsLoaded = await loadAgentEvidence<ReadFillRow>(
        boundary,
        'get_agent_fills',
        {},
        'fills',
        toFillRow,
      );
      if (!fillsLoaded.ok) {
        return reply.status(fillsLoaded.error.status).send(
          errorPayload(fillsLoaded.error.code, fillsLoaded.error.message),
        );
      }
      const eventsLoaded = await loadAgentEvidence<ReadJournalRow>(
        boundary,
        'get_agent_journal_events',
        {},
        'events',
        toJournalRow,
      );
      if (!eventsLoaded.ok) {
        return reply.status(eventsLoaded.error.status).send(
          errorPayload(eventsLoaded.error.code, eventsLoaded.error.message),
        );
      }

      // The boundary returns ALL agent-scoped rows unordered. Reproduce the
      // previous per-source ordering (fills by filledAt desc, events by
      // createdAt desc) and the per-source fetch cap before the merge.
      const recentFills = fillsLoaded.rows
        .slice()
        .sort((a, b) => b.filledAt.getTime() - a.filledAt.getTime())
        .slice(0, fetchCount);
      const recentEvents = eventsLoaded.rows
        .slice()
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, fetchCount);

      const fillItems = recentFills.map((f) => ({
        type: 'fill' as const,
        id: f.id,
        symbol: f.symbol,
        side: f.side,
        quantity: f.quantity,
        price: f.price,
        fee: f.fee ?? null,
        feeCurrency: f.feeCurrency ?? null,
        venueRefId: f.venueRefId ?? null,
        timestamp: f.filledAt.toISOString(),
      }));

      const eventItems = recentEvents.map((e) => ({
        type: 'event' as const,
        id: e.id,
        eventType: e.type,
        payload: e.payload,
        timestamp: e.createdAt.toISOString(),
      }));

      const items = [...fillItems, ...eventItems]
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
        .slice(offset, offset + limit);

      return reply.send({ agentId, family: 'trading', items, limit, offset });
    },
  );

  app.get<{ Params: { agentId: string } }>(
    '/agents/:agentId/capabilities/trading/outcomes',
    async (request, reply) => {
      const { agentId } = request.params;

      const [agent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.userId, request.userId)));
      if (!agent) {
        return reply.status(404).send({ error: 'agent.not_found' });
      }

      const boundary = agentReadBoundary(request.userId, agentId);
      if (!boundary) {
        return reply.status(boundaryUnconfiguredError.status).send(
          errorPayload(boundaryUnconfiguredError.code, boundaryUnconfiguredError.message),
        );
      }
      const fillsLoaded = await loadAgentEvidence<ReadFillRow>(
        boundary,
        'get_agent_fills',
        {},
        'fills',
        toFillRow,
      );
      if (!fillsLoaded.ok) {
        return reply.status(fillsLoaded.error.status).send(
          errorPayload(fillsLoaded.error.code, fillsLoaded.error.message),
        );
      }
      const positionsLoaded = await loadAgentEvidence<ReadPositionRow>(
        boundary,
        'get_agent_positions',
        {},
        'positions',
        toPositionRow,
      );
      if (!positionsLoaded.ok) {
        return reply.status(positionsLoaded.error.status).send(
          errorPayload(positionsLoaded.error.code, positionsLoaded.error.message),
        );
      }
      const fillRows = fillsLoaded.rows;
      const positionRows = positionsLoaded.rows;

      if (fillRows.length === 0 && positionRows.length === 0) {
        return reply.send({
          agentId,
          family: 'trading',
          tradeCount: 0,
          totalPnl: '0',
          winRate: null,
          feesByCurrency: {},
          openPositionCount: 0,
        });
      }

      // Group fills by fee currency, summing the fee decimals in-app (previously
      // a DB `sum(fee)` grouped by `feeCurrency`). Null currency → 'unknown'.
      const feeTotals: Record<string, number> = {};
      for (const row of fillRows) {
        const currency = row.feeCurrency ?? 'unknown';
        feeTotals[currency] = (feeTotals[currency] ?? 0) + parseFloat(row.fee ?? '0');
      }
      const feesByCurrency: Record<string, string> = {};
      for (const [currency, total] of Object.entries(feeTotals)) {
        feesByCurrency[currency] = String(total);
      }

      const totalPnl = positionRows.reduce((acc, p) => acc + parseFloat(p.realizedPnl), 0);
      const openPositionCount = positionRows.filter((p) => p.closedAt === null).length;

      const closed = positionRows.filter((p) => p.closedAt !== null);
      const winRate =
        closed.length >= 2
          ? closed.filter((p) => parseFloat(p.realizedPnl) > 0).length / closed.length
          : null;

      return reply.send({
        agentId,
        family: 'trading',
        tradeCount: fillRows.length,
        totalPnl: totalPnl.toFixed(6),
        winRate,
        feesByCurrency,
        openPositionCount,
      });
    },
  );

  app.get<{
    Params: { agentId: string };
    Querystring: { limit?: string; offset?: string };
  }>(
    '/agents/:agentId/capabilities/trading/positions',
    async (request, reply) => {
      const { agentId } = request.params;
      const queryResult = TradingPositionsQuerySchema.safeParse(request.query);
      if (!queryResult.success) {
        return reply.status(400).send({ error: 'validation_error', details: queryResult.error.issues });
      }
      const { limit, offset } = queryResult.data;

      const [agent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.userId, request.userId)));
      if (!agent) {
        return reply.status(404).send({ error: 'agent.not_found' });
      }

      const boundary = agentReadBoundary(request.userId, agentId);
      if (!boundary) {
        return reply.status(boundaryUnconfiguredError.status).send(
          errorPayload(boundaryUnconfiguredError.code, boundaryUnconfiguredError.message),
        );
      }
      const positionsLoaded = await loadAgentEvidence<ReadPositionRow>(
        boundary,
        'get_agent_positions',
        {},
        'positions',
        toPositionRow,
      );
      if (!positionsLoaded.ok) {
        return reply.status(positionsLoaded.error.status).send(
          errorPayload(positionsLoaded.error.code, positionsLoaded.error.message),
        );
      }

      // No positions → no exitPrice reconstruction needed; skip the fills fetch.
      if (positionsLoaded.rows.length === 0) {
        return reply.send({ agentId, family: 'trading', items: [], limit, offset });
      }

      const fillsLoaded = await loadAgentEvidence<ReadFillRow>(
        boundary,
        'get_agent_fills',
        {},
        'fills',
        toFillRow,
      );
      if (!fillsLoaded.ok) {
        return reply.status(fillsLoaded.error.status).send(
          errorPayload(fillsLoaded.error.code, fillsLoaded.error.message),
        );
      }

      const allFills = fillsLoaded.rows;

      // Reproduce the previous `ORDER BY openedAt DESC` + limit/offset at the DB.
      const pagedPositions = positionsLoaded.rows
        .slice()
        .sort((a, b) => b.openedAt.getTime() - a.openedAt.getTime())
        .slice(offset, offset + limit);

      // Reconstruct the correlated-subquery exitPrice in-app via the shared
      // ledger helpers: index fills by position key once (avoids the O(P×F)
      // scan), then pick the latest fill with `filledAt <= closedAt`. Only
      // closed positions carry an exitPrice.
      const fillIndex = indexFillsByPositionKey(allFills);
      const now = new Date();

      const items = pagedPositions.map((row) => {
        const isClosed = row.closedAt !== null;
        // Byte-identical shape: open rows report holdMs: null (not elapsed).
        const holdMs = isClosed ? holdMsOf(row, now) : null;
        return {
          id: row.id,
          symbol: row.symbol,
          venue: row.venue,
          side: row.side,
          size: row.size,
          entryPrice: row.entryPrice,
          exitPrice: isClosed ? (findClosingFill(row, fillIndex)?.price ?? null) : null,
          realizedPnl: parseFloat(row.realizedPnl).toFixed(6),
          status: isClosed ? 'closed' : 'open',
          openedAt: row.openedAt.toISOString(),
          closedAt: row.closedAt?.toISOString() ?? null,
          holdMs,
        };
      });

      return reply.send({ agentId, family: 'trading', items, limit, offset });
    },
  );

  app.post<{ Params: { agentId: string; action: string } }>(
    '/agents/:agentId/capabilities/trading/actions/:action',
    async (request, reply) => {
      const { agentId, action } = request.params;

      if (!SUPPORTED_ACTIONS.includes(action as TradingAction)) {
        return reply.status(400).send({
          error: 'action.unsupported',
          message: `Unsupported action "${action}". Supported: ${SUPPORTED_ACTIONS.join(', ')}`,
        });
      }

      const [agent] = await db
        .select()
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.userId, request.userId)));
      if (!agent) {
        return reply.status(404).send({ error: 'agent.not_found' });
      }

      if (action === 'start') {
        // B1: the local execution-capability pre-check here was dead code
        // (`agentExecMode` was hard-coded `undefined`). Removed; the agent-path
        // capability question is tracked in B1.2.

        const sessionId = crypto.randomUUID();
        const now = new Date();

        const result = await db.transaction(async (tx) => {
          if (agent.status !== 'stopped') {
            return { kind: 'not_stopped' as const };
          }

          const [claimed] = await tx
            .update(agents)
            .set({ status: 'starting', pauseState: null, updatedAt: now })
            .where(and(eq(agents.id, agentId), eq(agents.userId, request.userId), eq(agents.status, 'stopped')))
            .returning({ id: agents.id });

          if (!claimed) {
            return { kind: 'not_stopped' as const };
          }

          await tx
            .update(agentRuntimeSessions)
            .set({ status: 'stopped', stoppedAt: now })
            .where(
              and(
                eq(agentRuntimeSessions.agentId, agentId),
                inArray(agentRuntimeSessions.status, ['starting', 'launching', 'running', 'unhealthy']),
              ),
            );

          await tx.insert(agentRuntimeSessions).values({
            id: sessionId,
            agentId,
            status: 'starting',
          });

          return { kind: 'started' as const };
        });

        if (result.kind === 'not_stopped') {
          return reply.status(409).send({ error: 'agent.not_stopped', message: 'Agent is not stopped' });
        }

        return reply.status(202).send({ action: 'start', agentId, status: 'starting', sessionId });
      }

      if (action === 'stop') {
        const now = new Date();
        await db.transaction(async (tx) => {
          await tx.update(agents).set({ status: 'stopped', pauseState: null, updatedAt: now }).where(eq(agents.id, agentId));
          await tx
            .update(agentRuntimeSessions)
            .set({ status: 'stopped', stoppedAt: now })
            .where(
              and(
                eq(agentRuntimeSessions.agentId, agentId),
                inArray(agentRuntimeSessions.status, ['starting', 'launching', 'running', 'unhealthy']),
              ),
            );
        });

        return reply.send({ action: 'stop', agentId, status: 'stopped' });
      }

      if (action === 'pause') {
        const parsed = PauseActionSchema.safeParse(request.body);
        if (!parsed.success) {
          return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
        }

        if (agent.status === 'paused') {
          return reply.send({ action: 'pause', agentId, status: 'paused' });
        }

        await db
          .update(agents)
          .set({
            status: 'paused',
            pauseState: { reason: parsed.data.reason, requestedBy: 'user', pausedAt: new Date().toISOString() },
            updatedAt: new Date(),
          })
          .where(eq(agents.id, agentId));

        return reply.send({ action: 'pause', agentId, status: 'paused' });
      }

      if (action === 'resume') {
        if (agent.status !== 'paused') {
          return reply.status(409).send({ error: 'agent.not_paused', message: 'Agent is not paused' });
        }

        await db.update(agents).set({ status: 'active', pauseState: null, updatedAt: new Date() }).where(eq(agents.id, agentId));
        return reply.send({ action: 'resume', agentId, status: 'active' });
      }

      return reply.status(500).send({ error: 'internal.unhandled_action' });
    },
  );
}
