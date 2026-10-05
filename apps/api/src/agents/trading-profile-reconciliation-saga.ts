import crypto from 'node:crypto';
import { z } from 'zod';
import {
  TradingProfileReconciliationOutboxRepository,
  type TradingProfileOutboxAction,
  type TradingProfileReconciliationOutboxRow,
  type DatabaseTransaction,
} from '@herobids/db';
import {
  AgentRiskOverridesSchema,
  CreatorStrategySchema,
  ExecutionDefaultsSchema,
  RiskPostureSchema,
  ScanModeSchema,
} from '@herobids/domain';
import type { ExternalBackendClientResult, ExternalBackendSubject } from '@herobids/domain/external-backend';
import type {
  TradingProfileConnection,
  TradingProfileConfiguration,
  TradingProfileReconciliationPlan,
  TypedTradingProfile,
} from './trading-profile-reconciliation.js';
import { buildTradingProfileSnapshots, planTradingProfileReconciliation } from './trading-profile-reconciliation.js';

/**
 * Emitted after a staged profile write commits successfully (and only when it
 * changed something). The L1 lifecycle hook turns this into a `start`/`stop`
 * agent-actor call to traderton. Fire-and-forget: a hook failure never fails
 * the request (the profile write already committed).
 */
export interface ProfilesCommittedEvent {
  ownerId: string;
  actorId: string;
  upserted: number;
  cleared: number;
  remainingProfiles: number;
  executionVenueAccountId: string | null;
}

export interface TradingProfileReconciliationHooks {
  onProfilesCommitted?(event: ProfilesCommittedEvent): Promise<void>;
}

export interface TradingProfilePlannerInput {
  prior: {
    profiles: ReadonlyMap<string, TypedTradingProfile>;
    connections: TradingProfileConnection[];
  };
  proposed: {
    profiles: ReadonlyMap<string, TypedTradingProfile>;
    connections: TradingProfileConnection[];
  };
}

export interface TradingProfileSagaBoundary {
  invoke(input: {
    toolName: string;
    payload: unknown;
    subject: ExternalBackendSubject;
    requestId: string;
    idempotencyKey: string;
    correlationId: string;
  }): Promise<ExternalBackendClientResult>;
}

export interface TradingProfileStagedOperation {
  operationId: string;
  ownerId: string;
  actorId: string;
}

const AgentTradingProfileResponseSchema = z.object({
  actorId: z.string().min(1),
  venueAccountId: z.string().min(1),
  capital: z.string().regex(/^\d+(\.\d+)?$/).nullable(),
  riskPosture: RiskPostureSchema.strict().nullable(),
  riskOverrides: AgentRiskOverridesSchema.nullable(),
  executionDefaults: ExecutionDefaultsSchema.strict().nullable(),
  // 004 creator inputs read back from traderton. Optional/nullable: a profile
  // written before scan config existed carries neither.
  scanMode: ScanModeSchema.nullable().optional(),
  creatorStrategy: CreatorStrategySchema.nullable().optional(),
}).passthrough();

const ForwardSetMutationResponseSchema = z.object({
  operationId: z.string().min(1),
  revision: z.string().min(1),
});

const ForwardClearMutationResponseSchema = z.object({
  operationId: z.string().min(1),
  revision: z.null(),
});

const OperationMutationResponseSchema = z.object({
  operationId: z.string().min(1),
});

export class TradingProfileResponseValidationError extends Error {
  readonly code = 'trading_profile.invalid_response';

  constructor(message: string) {
    super(message);
    this.name = 'TradingProfileResponseValidationError';
  }
}

/**
 * The boundary rejected a creator `riskPosture` because a field exceeded the
 * operator ceiling (traderton `set_agent_trading_profile` →
 * `validation.risk_ceiling`). Surfaced distinct from the generic forward
 * failure so routes can map it to a 400 `validation_error` rather than a 500.
 */
export class TradingProfileCeilingViolationError extends Error {
  readonly code = 'validation.risk_ceiling';

  constructor(message: string) {
    super(message);
    this.name = 'TradingProfileCeilingViolationError';
  }
}

/**
 * The boundary rejected the creator scan config (traderton
 * `set_agent_trading_profile` → a `validation.strategy_required` /
 * `validation.technical_config` / `validation.unknown_preset` / `swap.*`
 * errorCode). Surfaced distinct from the generic forward failure so routes can
 * map it to a 400 `validation_error` rather than a 500. The failing errorCode
 * is preserved on `.code`.
 */
export class TradingProfileScanValidationError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'TradingProfileScanValidationError';
    this.code = code;
  }
}

/** Scan-config errorCodes the boundary surfaces that map to a client 400. */
function isScanValidationErrorCode(code: unknown): code is string {
  return typeof code === 'string' && (
    code === 'validation.strategy_required'
    || code === 'validation.technical_config'
    || code === 'validation.unknown_preset'
    || code.startsWith('swap.')
  );
}

export class TradingProfileReconciliationSaga {
  constructor(
    private readonly outbox: TradingProfileReconciliationOutboxRepository,
    private readonly boundary: TradingProfileSagaBoundary,
    private readonly hooks?: TradingProfileReconciliationHooks,
  ) {}

  async execute<T>(input: {
    ownerId: string;
    actorId: string;
    localMutationId: string;
    plan: TradingProfileReconciliationPlan;
    commitLocal: (tx: DatabaseTransaction, markLocalCommitted: () => Promise<void>) => Promise<T>;
    onOperationStaged?: (operation: TradingProfileStagedOperation) => void;
    deferFinalization?: boolean;
  }): Promise<T> {
    if (input.plan.upserts.length === 0 && input.plan.clears.length === 0) {
      return this.outbox.inTransaction((tx) => input.commitLocal(tx, async () => undefined));
    }

    const operationId = crypto.randomUUID();
    const proposedActions = actionMetadata(input.plan);
    const row = await this.outbox.createOrLoad({
      operationId,
      localMutationId: input.localMutationId,
      ownerId: input.ownerId,
      actorId: input.actorId,
      actions: proposedActions,
    });
    input.onOperationStaged?.({ operationId: row.operationId, ownerId: row.ownerId, actorId: row.actorId });
    const actions = row.actions;

    const claimToken = await this.outbox.claimLive(row.operationId, 60_000);
    if (!claimToken) throw new Error('trading-profile reconciliation operation is already claimed');
    try {
      let localResult: T;
      try {
        if (row.state === 'completed') throw new Error('completed profile mutation has no local result');
        await this.applyForward(row, input.plan);
        await this.outbox.update(row.id, 'remote_applied', actions);
        localResult = await this.outbox.inTransaction(async (tx) => {
          let markedLocalCommitted = false;
          const markLocalCommitted = async (): Promise<void> => {
            await this.outbox.markLocalCommitted(tx, row.operationId);
            markedLocalCommitted = true;
          };
          const result = await input.commitLocal(tx, markLocalCommitted);
          if (!markedLocalCommitted) {
            throw new Error('local profile mutation completed without marking the reconciliation operation committed');
          }
          return result;
        });
      } catch (error) {
        await this.rollback(row, errorMessage(error));
        throw error;
      }

      if (!input.deferFinalization) {
        try {
          await this.finalizeRow(row);
        } catch (error) {
          await this.outbox.update(row.id, 'finalizing', actions, errorMessage(error));
          throw error;
        }
      }
      return localResult;
    } finally {
      await this.outbox.releaseClaim(row.operationId, claimToken);
    }
  }

  /** Reads every distinct locally bound profile under the signed agent subject. */
  async readCurrentProfiles(
    ownerId: string,
    actorId: string,
    connections: TradingProfileConnection[],
  ): Promise<Map<string, TypedTradingProfile>> {
    const venueAccountIds = [...new Set(connections
      .filter((connection): connection is TradingProfileConnection & { venueAccountId: string } => connection.venueAccountId !== null)
      .map((connection) => connection.venueAccountId))];
    const profiles = await Promise.all(venueAccountIds.map(async (venueAccountId) => {
      const result = await this.boundary.invoke({
        toolName: 'get_agent_trading_profile',
        payload: { actorId, venueAccountId },
        subject: { ownerId, actor: { type: 'agent', id: actorId } },
        requestId: crypto.randomUUID(),
        idempotencyKey: crypto.randomUUID(),
        correlationId: crypto.randomUUID(),
      });
      if (result.kind !== 'success') {
        throw new Error(resultMessage(result));
      }
      const parsedProfile = AgentTradingProfileResponseSchema.safeParse(result.payload);
      if (!parsedProfile.success) {
        throw new TradingProfileResponseValidationError(
          `Traderton returned an invalid trading profile: ${parsedProfile.error.issues.map((issue) => issue.path.join('.') || 'response').join(', ')}`,
        );
      }
      const profile = parsedProfile.data;
      if (profile.actorId !== actorId || profile.venueAccountId !== venueAccountId) {
        throw new TradingProfileResponseValidationError('Traderton returned a trading profile for a different actor or venue account');
      }
      return [venueAccountId, {
        actorId: profile.actorId,
        venueAccountId: profile.venueAccountId,
        capital: profile.capital,
        riskPosture: profile.riskPosture,
        executionDefaults: profile.executionDefaults,
        scanMode: profile.scanMode ?? null,
        creatorStrategy: profile.creatorStrategy ?? null,
      } satisfies TypedTradingProfile] as const;
    }));
    return new Map(profiles);
  }

  /** Compensate a successfully staged operation when its enclosing fanout fails. */
  async compensate(operation: TradingProfileStagedOperation): Promise<void> {
    const result = await this.boundary.invoke({
      toolName: 'rollback_agent_trading_profile_change',
      payload: { actorId: operation.actorId, operationId: operation.operationId },
      subject: { ownerId: operation.ownerId, actor: { type: 'agent', id: operation.actorId } },
      requestId: operation.operationId,
      idempotencyKey: operation.operationId,
      correlationId: operation.operationId,
    });
    if (result.kind !== 'success') {
      const message = resultMessage(result);
      await this.outbox.updateByOperationId(operation.operationId, 'rollback_pending', message);
      throw new Error(message);
    }
    const message = operationResponseError(result, operation.operationId, 'rollback');
    if (message) {
      await this.outbox.updateByOperationId(operation.operationId, 'rollback_pending', message);
      throw new TradingProfileResponseValidationError(message);
    }
    await this.outbox.updateByOperationId(operation.operationId, 'failed');
  }

  async finalize(operation: TradingProfileStagedOperation): Promise<void> {
    const result = await this.boundary.invoke({
      toolName: 'finalize_agent_trading_profile_change',
      payload: { actorId: operation.actorId, operationId: operation.operationId },
      subject: { ownerId: operation.ownerId, actor: { type: 'agent', id: operation.actorId } },
      requestId: operation.operationId,
      idempotencyKey: operation.operationId,
      correlationId: operation.operationId,
    });
    if (result.kind !== 'success') {
      const message = resultMessage(result);
      await this.outbox.updateByOperationId(operation.operationId, 'finalizing', message);
      throw new Error(message);
    }
    const message = operationResponseError(result, operation.operationId, 'finalize');
    if (message) {
      await this.outbox.updateByOperationId(operation.operationId, 'finalizing', message);
      throw new TradingProfileResponseValidationError(message);
    }
    await this.outbox.updateByOperationId(operation.operationId, 'completed');
  }

  async executeStaged<T>(input: {
    ownerId: string;
    actorId: string;
    localMutationId: string;
    preparePlannerInput: () => Promise<TradingProfilePlannerInput> | TradingProfilePlannerInput;
    commitLocal: (tx: DatabaseTransaction, markLocalCommitted: () => Promise<void>) => Promise<T>;
    onOperationStaged?: (operation: TradingProfileStagedOperation) => void;
    deferFinalization?: boolean;
  }): Promise<T> {
    const plannerInput = await input.preparePlannerInput();
    const plan = planTradingProfileReconciliation(plannerInput);
    const result = await this.execute({
      ownerId: input.ownerId,
      actorId: input.actorId,
      localMutationId: input.localMutationId,
      plan,
      commitLocal: input.commitLocal,
      onOperationStaged: input.onOperationStaged,
      deferFinalization: input.deferFinalization,
    });

    // Post-commit agent-actor lifecycle hook (L1 / D6). Only when the write
    // actually changed something. Fire-and-forget: a hook failure must never
    // fail the request — the profile write already committed.
    if (this.hooks?.onProfilesCommitted && plan.upserts.length + plan.clears.length > 0) {
      const event: ProfilesCommittedEvent = {
        ownerId: input.ownerId,
        actorId: input.actorId,
        upserted: plan.upserts.length,
        cleared: plan.clears.length,
        remainingProfiles: buildTradingProfileSnapshots(
          plannerInput.proposed.profiles,
          plannerInput.proposed.connections,
        ).length,
        executionVenueAccountId: plan.selectedBinding.next?.venueAccountId ?? null,
      };
      try {
        await this.hooks.onProfilesCommitted(event);
      } catch {
        // Swallowed deliberately: logged inside the hook. The write succeeded.
      }
    }
    return result;
  }

  /** Bounded restart recovery: finish finalization or compensate uncommitted operations. */
  async recover(limit: number): Promise<{ recovered: number; failed: number }> {
    const rows = await this.outbox.claimRecoverable(limit, 60_000);
    let recovered = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        if (row.state === 'local_committed' || row.state === 'finalizing') {
          await this.finalizeRow(row);
        } else if (row.state === 'pending_remote') {
          await this.resume(row);
          await this.rollback(row, 'recovered before local profile mutation committed');
        } else {
          await this.rollback(row, row.lastError ?? 'recovered after interrupted profile reconciliation');
        }
        recovered += 1;
      } catch (error) {
        await this.outbox.update(row.id, row.state === 'local_committed' ? 'finalizing' : 'rollback_pending', row.actions, errorMessage(error));
        failed += 1;
      } finally {
        if (row.claimToken) await this.outbox.releaseClaim(row.operationId, row.claimToken);
      }
    }
    return { recovered, failed };
  }

  private async applyForward(row: TradingProfileReconciliationOutboxRow, plan: TradingProfileReconciliationPlan): Promise<void> {
    const subject: ExternalBackendSubject = { ownerId: row.ownerId, actor: { type: 'agent', id: row.actorId } };
    const actions = row.actions.map((action) => ({ ...action }));
    const configurations = new Map(plan.upserts.map((snapshot) => [snapshot.venueAccountId, snapshot]));
    const manifest = actions.map((action) => action.kind === 'set'
      ? { ...requiredSnapshot(configurations.get(action.venueAccountId)), actionId: action.actionId, kind: 'set' as const }
      : {
        actionId: action.actionId,
        kind: 'clear' as const,
        venueAccountId: action.venueAccountId,
        capital: null,
        riskPosture: null,
        executionDefaults: null,
      });
    for (const action of actions) {
      if (action.state === 'applied') continue;
      const payload = action.kind === 'set'
        ? { ...requiredSnapshot(configurations.get(action.venueAccountId)), operationId: row.operationId, actionId: action.actionId, actions: manifest }
        : { actorId: row.actorId, venueAccountId: action.venueAccountId, operationId: row.operationId, actionId: action.actionId, actions: manifest };
      const result = await this.boundary.invoke({
        toolName: action.kind === 'set' ? 'set_agent_trading_profile' : 'clear_agent_trading_profile',
        payload,
        subject,
        requestId: action.actionId,
        idempotencyKey: action.actionId,
        correlationId: row.operationId,
      });
      if (result.kind !== 'success') {
        action.attempts += 1;
        action.state = 'failed';
        action.error = resultMessage(result);
        await this.outbox.update(row.id, 'pending_remote', actions, action.error);
        // The boundary surfaces a creator ceiling exceedance as a fault:false
        // `validation.risk_ceiling` errorCode (mapped over the wire to
        // `validation.invalid_payload` with `details.errorCode` preserved —
        // see exports-traderton.js mapClientResultToReadResult). Surface it as
        // a typed client-facing error before the generic forward failure.
        if (result.kind === 'failure' && result.details?.['errorCode'] === 'validation.risk_ceiling') {
          throw new TradingProfileCeilingViolationError(result.message);
        }
        // Scan-config rejections (strategy_required, technical_config,
        // unknown_preset, swap.*) are creator input errors → client 400.
        if (result.kind === 'failure' && isScanValidationErrorCode(result.details?.['errorCode'])) {
          throw new TradingProfileScanValidationError(result.message, result.details['errorCode'] as string);
        }
        throw new Error(action.error);
      }
      const message = forwardResponseError(result, row.operationId, action.kind);
      if (message) {
        action.attempts += 1;
        action.state = 'failed';
        action.error = message;
        await this.outbox.update(row.id, 'pending_remote', actions, action.error);
        throw new TradingProfileResponseValidationError(message);
      }
      action.attempts += 1;
      action.state = 'applied';
      action.error = null;
      await this.outbox.update(row.id, 'pending_remote', actions);
    }
  }

  private async finalizeRow(row: TradingProfileReconciliationOutboxRow): Promise<void> {
    const result = await this.changeOperation(row, 'finalize_agent_trading_profile_change');
    if (result.kind !== 'success') throw new Error(resultMessage(result));
    const message = operationResponseError(result, row.operationId, 'finalize');
    if (message) throw new TradingProfileResponseValidationError(message);
    await this.outbox.update(row.id, 'completed', row.actions);
  }

  private async resume(row: TradingProfileReconciliationOutboxRow): Promise<void> {
    const result = await this.changeOperation(row, 'resume_agent_trading_profile_change');
    if (result.kind !== 'success') throw new Error(resultMessage(result));
    const message = operationResponseError(result, row.operationId, 'resume');
    if (message) throw new TradingProfileResponseValidationError(message);
  }

  private async rollback(row: TradingProfileReconciliationOutboxRow, reason: string): Promise<void> {
    const result = await this.changeOperation(row, 'rollback_agent_trading_profile_change');
    if (result.kind !== 'success') {
      await this.outbox.update(row.id, 'rollback_pending', row.actions, resultMessage(result));
      throw new Error(resultMessage(result));
    }
    const message = operationResponseError(result, row.operationId, 'rollback');
    if (message) {
      await this.outbox.update(row.id, 'rollback_pending', row.actions, message);
      throw new TradingProfileResponseValidationError(message);
    }
    await this.outbox.update(row.id, 'failed', row.actions, reason);
  }

  private changeOperation(row: TradingProfileReconciliationOutboxRow, toolName: 'finalize_agent_trading_profile_change' | 'rollback_agent_trading_profile_change' | 'resume_agent_trading_profile_change'): Promise<ExternalBackendClientResult> {
    return this.boundary.invoke({
      toolName,
      payload: { actorId: row.actorId, operationId: row.operationId },
      subject: { ownerId: row.ownerId, actor: { type: 'agent', id: row.actorId } },
      requestId: row.operationId,
      idempotencyKey: row.operationId,
      correlationId: row.operationId,
    });
  }
}

function actionMetadata(plan: TradingProfileReconciliationPlan): TradingProfileOutboxAction[] {
  return [
    ...plan.upserts.map((snapshot) => ({ actionId: crypto.randomUUID(), kind: 'set' as const, venueAccountId: snapshot.venueAccountId })),
    ...plan.clears.map((venueAccountId) => ({ actionId: crypto.randomUUID(), kind: 'clear' as const, venueAccountId })),
  ].map((action) => ({ ...action, state: 'pending' as const, attempts: 0, error: null }));
}

function requiredSnapshot(snapshot: TradingProfileConfiguration | undefined): TradingProfileConfiguration {
  if (!snapshot) throw new Error('missing planned profile snapshot for reconciliation action');
  return snapshot;
}

function resultMessage(result: ExternalBackendClientResult): string {
  if (result.kind === 'failure' || result.kind === 'transport_error') return result.message;
  if (result.kind === 'in_progress') return 'profile operation did not reach a terminal boundary result';
  return 'unexpected profile operation result';
}

function forwardResponseError(
  result: Extract<ExternalBackendClientResult, { kind: 'success' }>,
  operationId: string,
  operation: 'set' | 'clear',
): string | null {
  const parsed = (operation === 'set'
    ? ForwardSetMutationResponseSchema
    : ForwardClearMutationResponseSchema).safeParse(result.payload);
  if (!parsed.success) return `Traderton returned an invalid ${operation} trading profile response`;
  if (parsed.data.operationId !== operationId) return `Traderton returned a ${operation} trading profile response for a different operation`;
  return null;
}

function operationResponseError(
  result: Extract<ExternalBackendClientResult, { kind: 'success' }>,
  operationId: string,
  operation: 'finalize' | 'rollback' | 'resume',
): string | null {
  const parsed = OperationMutationResponseSchema.safeParse(result.payload);
  if (!parsed.success) return `Traderton returned an invalid ${operation} trading profile response`;
  if (parsed.data.operationId !== operationId) return `Traderton returned a ${operation} trading profile response for a different operation`;
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'profile reconciliation failed';
}