// Boundary-backed ConsumerNotificationFeed adapter (E3-H).
//
// Fulfils the narrow `ConsumerNotificationFeed` port by invoking traderton's
// cross-owner `scan_consumer_notifications` tool over the REST boundary.
// Modelled on `boundary-trade-event-feed.ts`: it takes a bound read boundary
// (system subject + deadline already baked in) and maps the scan to a tool
// invocation.
//
// The boundary returns JSON — `createdAt` arrives as an ISO string. We rehydrate
// it to a Date so the relay's cursor arithmetic (`createdAt.getTime()`) is
// correct. The row envelope is Zod-validated.
//
// On any non-success outcome (failure / in_progress / transport_error) this
// THROWS, so the relay tick holds its cursor and retries on the next tick rather
// than silently advancing past undelivered rows.

import { z } from 'zod';
import type { ExternalBackendReadBoundary } from '../external-backend/read-adapter.js';
import type { ExternalBackendReadResult } from '@herobids/domain';

export interface ConsumerNotificationRow {
  id: string;
  type: string;
  ownerId: string;
  agentId: string | null;
  botId: string | null;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export interface ConsumerNotificationCursor {
  createdAt: Date;
  seenIds: string[];
}

/** The narrow port the actor-event relay consumes. */
export interface ConsumerNotificationFeed {
  scan(opts: { cursor?: ConsumerNotificationCursor; limit: number }): Promise<ConsumerNotificationRow[]>;
}

/** Notification types the relay subscribes to. */
export const RELAY_NOTIFICATION_TYPES = [
  'agent_wake',
  'scan_completed',
  'journal_event',
  'bot_status',
  'agent_status',
] as const;

const RowEnvelopeSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  ownerId: z.string().min(1),
  agentId: z.string().nullable().optional(),
  botId: z.string().nullable().optional(),
  payload: z.record(z.unknown()),
  createdAt: z.string(),
});

function requireSuccess(result: ExternalBackendReadResult, toolName: string): unknown {
  switch (result.kind) {
    case 'success':
      return result.data;
    case 'failure':
      throw new Error(`consumer-notification feed ${toolName} failed: ${result.code} ${result.message}`);
    case 'in_progress':
      throw new Error(`consumer-notification feed ${toolName} returned in_progress unexpectedly`);
    case 'transport_error':
      throw new Error(`consumer-notification feed ${toolName} transport error: ${result.message}`);
  }
}

function toRow(record: unknown): ConsumerNotificationRow {
  const r = RowEnvelopeSchema.parse(record);
  const createdAt = new Date(r.createdAt);
  if (Number.isNaN(createdAt.getTime())) {
    throw new Error(`consumer-notification feed: invalid createdAt "${r.createdAt}"`);
  }
  return {
    id: r.id,
    type: r.type,
    ownerId: r.ownerId,
    agentId: r.agentId ?? null,
    botId: r.botId ?? null,
    payload: r.payload,
    createdAt,
  };
}

export function createBoundaryConsumerNotificationFeed(
  boundary: ExternalBackendReadBoundary,
): ConsumerNotificationFeed {
  return {
    async scan(opts): Promise<ConsumerNotificationRow[]> {
      const result = await boundary.invoke({
        toolName: 'scan_consumer_notifications',
        payload: {
          cursor: opts.cursor
            ? { createdAt: opts.cursor.createdAt.toISOString(), seenIds: opts.cursor.seenIds }
            : undefined,
          types: [...RELAY_NOTIFICATION_TYPES],
          limit: opts.limit,
        },
      });
      const data = requireSuccess(result, 'scan_consumer_notifications');
      if (typeof data !== 'object' || data === null) {
        throw new Error('consumer-notification feed: expected an object result');
      }
      const notifications = (data as { notifications?: unknown[] }).notifications ?? [];
      return notifications.map(toRow);
    },
  };
}
