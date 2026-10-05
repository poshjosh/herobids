import type { Logger } from 'pino';
import { TradingProfileReconciliationOutboxRepository, type Database } from '@herobids/db';
import {
  buildExternalBackendClientConfig,
  createExternalBackendClient,
  createLoggerMetricsSink,
  type ExternalBackendClient,
} from '@herobids/domain/external-backend';
import {
  DEFAULT_EXTERNAL_BACKEND_REQUEST_TIMEOUT_MS,
  findExternalBackend,
  type AppConfig,
} from '@herobids/domain';
import { resolveConfiguredExternalBackend } from '../config.js';
import { TradingProfileReconciliationSaga } from './trading-profile-reconciliation-saga.js';
import { createAgentActorLifecycleHook } from './agent-actor-lifecycle-hook.js';

export interface TradingProfileSagaBundle {
  /** The trading-backend client, or undefined when the backend is unresolved. */
  client: ExternalBackendClient | undefined;
  saga: TradingProfileReconciliationSaga;
  timeoutMs: number;
}

/**
 * Construct the trading-profile reconciliation saga (with its boundary client +
 * the L1 agent-actor lifecycle hook). Extracted from `apps/api/src/index.ts` so
 * both the API composition root and the backfill CLI build it identically.
 *
 * The saga is always returned; `client` is undefined when the trading backend is
 * unresolved (no HMAC secret, etc.), in which case the saga's boundary invoke
 * returns a typed `transport_error` — the same behaviour the API has always had.
 */
export function createTradingProfileSaga(deps: {
  appConfig: AppConfig;
  db: Database;
  logger: Logger;
}): TradingProfileSagaBundle {
  const { appConfig, db, logger } = deps;
  const tradingBackend = resolveConfiguredExternalBackend(appConfig, appConfig.tradingBackendId);
  const metricsSink = createLoggerMetricsSink(logger);
  const client = tradingBackend.ok
    ? createExternalBackendClient(
      buildExternalBackendClientConfig(tradingBackend.data.definition, tradingBackend.data.hmacSecret, { metrics: metricsSink }),
    )
    : undefined;
  const timeoutMs =
    findExternalBackend(appConfig.externalBackends, appConfig.tradingBackendId)?.endpoint.requestTimeoutMs
    ?? DEFAULT_EXTERNAL_BACKEND_REQUEST_TIMEOUT_MS;

  const hook = client
    ? createAgentActorLifecycleHook({
      client: {
        invoke: (input) => client.invoke({
          toolName: input.toolName,
          payload: input.payload,
          subject: input.subject,
          requestId: input.requestId,
          idempotencyKey: input.idempotencyKey,
          correlationId: input.correlationId,
          deadlineMs: input.deadlineMs,
        }),
      },
      db,
      timeoutMs,
      logger,
    })
    : undefined;

  const saga = new TradingProfileReconciliationSaga(
    new TradingProfileReconciliationOutboxRepository(db),
    {
      invoke: (input) => client
        ? client.invoke({
          toolName: input.toolName,
          payload: input.payload,
          subject: input.subject,
          requestId: input.requestId,
          idempotencyKey: input.idempotencyKey,
          correlationId: input.correlationId,
          deadlineMs: timeoutMs,
        })
        : Promise.resolve({
          kind: 'transport_error' as const,
          requestId: input.requestId,
          message: 'trading boundary not configured',
          retryable: true,
        }),
    },
    hook,
  );

  return { client, saga, timeoutMs };
}
