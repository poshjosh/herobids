# Phase 5b: Telegram + Alerting Integrations

## Objective

Ship operator-facing alerting before multi-user auth by consuming the journal and reconciliation events that already exist in the runtime. Keep configuration operator-level, delivery idempotent across worker restarts, and transport-specific code isolated from trading logic.

## Implementation Order

### 1. Expand the alert-worthy event contract

Primary files:
- `apps/worker/src/trading-actor.ts`
- `apps/worker/src/index.ts`
- `packages/db/src/journal-pg.ts` (only if helper support is needed for the new event shapes)

Changes:
- Add journal events for failure cases that are currently only logged: risk rejections, execution failures, tick-loop errors, private-stream disconnect/reconnect exhaustion, and actor crash reasons.
- Keep event names under stable prefixes (`risk.`, `execution.`, `stream.`, `instance.`) so routing rules can depend on type names instead of parsing log messages.
- Preserve the current append-only journal model; do not build alerting directly from logs.

Dependency:
- This comes first. The dispatcher should consume a stable event contract, not ad hoc log text.

### 2. Add operator alerting config

Primary files:
- `packages/domain/src/config/schema.ts`
- `packages/domain/src/config/index.ts`
- `config/default.yaml`
- `apps/worker/src/config.ts`

Changes:
- Add an `alerts` section to operator config with: `enabled`, `dispatchIntervalMs`, `defaultCooldownMs`, `maxBatchSize`, and channel-specific config for Telegram.
- Add Telegram routing config for chat destinations, enabled event prefixes, and severity thresholds.
- Keep secrets out of YAML. Store non-secret routing in config and resolve the Telegram bot token via env override or a secret-ref field.

Dependency:
- Required before worker startup wiring and test fixtures.

### 3. Add delivery persistence and idempotency

Primary files:
- `packages/db/src/schema/alert-deliveries.ts`
- `packages/db/src/schema/index.ts`
- `packages/db/src/index.ts`
- `packages/db/src/alert-delivery-repository.ts`
- `packages/db/drizzle/` (new migration)

Changes:
- Create an `alert_deliveries` table keyed by journal event ID plus channel/destination, with status, attempt count, last error, claimed-at, and delivered-at fields.
- Add repository methods to claim the next batch, mark delivered, mark failed, and skip duplicates already delivered within the cooldown window.
- Keep the source of truth in Postgres so a restarted worker does not resend the same alert blindly.

Dependency:
- Must land before the dispatcher. Multi-worker deployments need durable dedupe, not in-memory flags.

### 4. Build the dispatcher and Telegram transport

Primary files:
- `apps/worker/src/alerting/alert-policy.ts`
- `apps/worker/src/alerting/telegram-client.ts`
- `apps/worker/src/alerting/alert-dispatcher.ts`
- `apps/worker/src/index.ts`

Changes:
- `alert-policy.ts`: map journal/reconciliation events to severity, message templates, and channel destinations.
- `telegram-client.ts`: call Telegram Bot API `sendMessage`, parse rate-limit failures, and return `Result` values instead of throwing across the boundary.
- `alert-dispatcher.ts`: poll recent journal/reconciliation events, evaluate policy, create delivery records, dispatch them, and retry failures with bounded backoff.
- Wire exactly one dispatcher per deployment using a Redis lease or BullMQ-owned singleton coordinator at worker startup.

Dependency:
- Depends on steps 1-3.

### 5. Tighten read/query helpers for global event scans

Primary files:
- `packages/db/src/journal-pg.ts`
- `packages/db/src/reconciliation-repository.ts`

Changes:
- Add cursor-based query methods for global event scans by type, type prefix, and time window across all trading instances.
- Use a stable cursor such as `(createdAt, id)` so the dispatcher does not miss or replay events around timestamp ties.
- Keep the existing per-instance query helpers for the operator API; do not overload them with dispatcher concerns.

Dependency:
- Only needed if the current query helpers cannot support efficient global polling.

### 6. Optional operator inspection surface

Primary files:
- `apps/api/src/routes/views.ts` or a new `apps/api/src/routes/alerts.ts`

Changes:
- If operator debugging needs it, expose alert delivery history and last failure reason.
- Keep this optional for the initial delivery. Step 2 can ship without new API routes if the delivery table and worker logs are sufficient.

Dependency:
- Independent of the transport itself.

## Risks And Open Questions

1. **Bot token handling**: decide whether Step 2 uses a direct env override first or introduces a generic secret-ref resolver. The config surface should not force a later rewrite.
2. **Duplicate sends across workers**: do not rely on in-memory dedupe. The design needs durable claim and delivery state.
3. **Alert storms**: reconciliation drift, repeated venue failures, and reconnect loops need cooldown/grouping rules or Telegram will become noisy enough to ignore.
4. **Event coverage gaps**: the current worker path logs some high-signal failures without journaling them. Until those become journal events, the alert surface will look incomplete.

## Test Strategy

- Unit tests in `apps/worker/src/alerting/` for policy routing, message formatting, cooldown behavior, and Telegram response/error parsing.
- Integration tests in `apps/worker/src/alerting/` that exercise dispatcher polling with mocked `PgJournal`, `ReconciliationEventRepository`, `AlertDeliveryRepository`, and HTTP transport.
- One worker lifecycle test proving only a single dispatcher acquires the lease and a restart does not resend already-delivered events.
- Manual smoke test: append a synthetic high-severity journal event, confirm exactly one Telegram message is sent, and confirm one `alert_deliveries` row records the attempt.