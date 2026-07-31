import type { Decision, VenueAccountId, DecisionId, InstrumentId, DecisionIntent } from '@herobids/domain';
import type { MessageEnvelope, DecisionSubmitPayload } from '@herobids/domain';
import { Decimal } from '@herobids/domain';
import type { AgentRepository } from '@herobids/db';
import type { DecisionFailureRepository } from '@herobids/db';
import type { DecisionApprovalRepository } from '@herobids/db';
import { submitDecisionForExecution, DecisionContextHashMismatchError, validatePerTradeLevels } from '@herobids/engine';
import type { DecisionIntakeDeps, DecisionContext, PositionState } from '@herobids/engine';
import type { IntakeResult } from '../execution-actor.js';
import { isIntakeRejection } from '../execution-actor.js';
import type { InstanceEventPublisher } from './instance-event-publisher.js';
import { POSITION_GROWING_INTENTS, formatLevelValidationMessage } from '../shared/decision-validation.js';
import { createLogger } from '../logger.js';
import crypto from 'node:crypto';

const logger = createLogger('agent-decision-handler');

/** Alphabet for human-safe short codes — excludes confusing chars (0, O, I, L, lowercase). */
const SHORT_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRTVWXYZ';
const SHORT_CODE_LENGTH = 6;

/** Generate a 6-character uppercase short code using crypto.randomBytes. */
function generateShortCode(): string {
  const bytes = crypto.randomBytes(SHORT_CODE_LENGTH);
  let code = '';
  for (let i = 0; i < SHORT_CODE_LENGTH; i++) {
    code += SHORT_CODE_ALPHABET[bytes[i]! % SHORT_CODE_ALPHABET.length];
  }
  return code;
}

/** Max age (ms) for a tracked failure entry before it's considered stale and pruned. */
const FAILURE_ENTRY_MAX_AGE_MS = 5 * 60_000; // 5 min

/**
 * Resolves the execution context needed by the decision intake pipeline.
 * Keyed by actorId (botId or agentId). Methods may be sync or async.
 */
export interface DecisionIntakeResolver {
  getIntakeDeps(instanceId: string, instrumentId?: string): IntakeResult | Promise<IntakeResult>;
  getDecisionContext(instanceId: string, instrumentId?: string): DecisionContext | undefined | Promise<DecisionContext | undefined>;
  getPosition(instanceId: string, instrumentId?: string): PositionState | undefined | Promise<PositionState | undefined>;
  recordExecutionOutcome?(instanceId: string, success: boolean): void;
}

/**
 * AgentDecisionHandler — translates `agent.decision.submit` into the engine decision-ingestion path.
 */
export class AgentDecisionHandler {
  /** Per-instrument failure counters: key = `${agentId}::${instrumentId}::${failureCode}` */
  private readonly failureCounters = new Map<string, { count: number; lastFailedAt: number }>();

  /** Actors that have had at least one successful decision context fetch. Used to
   *  distinguish startup initialization (no_context is expected) from persistent
   *  mark unavailability (no_context should trigger the circuit breaker). */
  private readonly actorsWithSuccessfulContext = new Set<string>();

  private readonly breakerThresholds: Record<string, number>;

  constructor(
    private readonly agentRepo: AgentRepository,
    private readonly intakeResolver: DecisionIntakeResolver,
    private readonly eventPublisher: InstanceEventPublisher,
    private readonly decisionFailureRepo?: DecisionFailureRepository,
    thresholds?: { noContext?: number; swapInstrumentFormat?: number },
    private readonly approvalRepo?: DecisionApprovalRepository,
    private readonly agentApprovalsTtlMs?: number,
    private readonly telegramBotToken?: string,
  ) {
    this.breakerThresholds = {
      no_context: thresholds?.noContext ?? 10,
      'swap.instrument_format': thresholds?.swapInstrumentFormat ?? 5,
    };
  }

  private async sendApprovalTelegramNotification(
    userId: string,
    agentId: string,
    agentName: string,
    shortCode: string,
    instrumentId: string,
    intent: string,
    targetSize: string,
    limitPrice: string | null | undefined,
    stopLoss: string | null | undefined,
    takeProfit: string | null | undefined,
    confidence: number | null | undefined,
    rationaleSummary: string,
    expiresAtISO: string,
  ): Promise<void> {
    if (!this.telegramBotToken) return;

    const chatId = await this.agentRepo.getEffectiveTelegramChatId(agentId);
    if (!chatId) return;

    const lines = [
      `🔔 <b>Trade approval requested by ${escapeHtmlTelegram(agentName)}</b>`,
      '',
      `<b>Code:</b> <code>${escapeHtmlTelegram(shortCode)}</code>`,
      `<b>Instrument:</b> ${escapeHtmlTelegram(instrumentId)}`,
      `<b>Intent:</b> ${escapeHtmlTelegram(intent)}`,
      `<b>Target size:</b> ${escapeHtmlTelegram(targetSize)}`,
      `<b>Limit price:</b> ${limitPrice ? escapeHtmlTelegram(limitPrice) : 'market'}`,
      `<b>Stop loss:</b> ${stopLoss ? escapeHtmlTelegram(stopLoss) : 'none'}`,
      `<b>Take profit:</b> ${takeProfit ? escapeHtmlTelegram(takeProfit) : 'none'}`,
      `<b>Confidence:</b> ${confidence != null ? `${confidence}%` : 'not specified'}`,
      '',
      '<b>Rationale:</b>',
      escapeHtmlTelegram(rationaleSummary),
      '',
      `Approve with /yes <code>${escapeHtmlTelegram(shortCode)}</code>`,
      `Reject with /no <code>${escapeHtmlTelegram(shortCode)}</code>`,
      '',
      '<i>Tip: /yes or /no without a code only works when you have exactly one pending approval.</i>',
      `<i>Expires: ${escapeHtmlTelegram(expiresAtISO)}</i>`,
    ];

    const text = lines.join('\n');

    try {
      const response = await fetch(
        `https://api.telegram.org/bot${this.telegramBotToken}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
          }),
        },
      );

      if (!response.ok) {
        const body = await response.text();
        logger.warn({ chatId, status: response.status, body }, 'Telegram approval notification delivery failed');
      }
    } catch (err) {
      logger.warn({ chatId, err }, 'Telegram approval notification network error');
    }
  }

  private recordFailure(input: {
    actorType: string;
    actorId: string;
    decisionId?: string;
    instrumentId?: string;
    venue?: string;
    venueAccountId?: string;
    failureCode: string;
    failureMessage: string;
    failureClass: 'rejection' | 'error';
    retryable: boolean;
    details?: Record<string, unknown> | null;
  }): void {
    if (!this.decisionFailureRepo) return;
    this.decisionFailureRepo.insert({
      actorType: input.actorType,
      actorId: input.actorId,
      decisionId: input.decisionId,
      instrumentId: input.instrumentId,
      venue: input.venue,
      venueAccountId: input.venueAccountId,
      failureCode: input.failureCode,
      failureMessage: input.failureMessage,
      failureClass: input.failureClass,
      retryable: input.retryable,
      details: input.details,
    }).catch((err) => {
      logger.error({ err, failureCode: input.failureCode }, 'Failed to persist decision failure');
    });
  }

  /**
   * Check and increment the per-instrument failure counter.
   * Returns a hardened message if the threshold has been exceeded.
   * The caller should use the returned values instead of the original retryable/message.
   *
   * @param originalRetryable — The retryable value from the original rejection,
   *   preserved when the circuit breaker is not tripped. When the breaker trips,
   *   retryable is always forced to false.
   */
  private checkCircuitBreaker(
    actorId: string,
    instrumentId: string | undefined,
    failureCode: string,
    originalMessage: string,
    originalRetryable: boolean,
  ): { retryable: boolean; message: string } {
    const threshold = this.breakerThresholds[failureCode];
    if (!threshold || !instrumentId) {
      return { retryable: originalRetryable, message: originalMessage };
    }

    const key = `${actorId}::${instrumentId}::${failureCode}`;
    const now = Date.now();
    const entry = this.failureCounters.get(key);

    // If the last failure was long enough ago, treat this as a fresh start.
    // This prevents the breaker from tripping on sporadic failures hours apart,
    // and allows startup initialization gaps to naturally reset the counter.
    const isStale = entry != null && (now - entry.lastFailedAt) > FAILURE_ENTRY_MAX_AGE_MS;
    const count = isStale ? 1 : (entry?.count ?? 0) + 1;

    this.failureCounters.set(key, { count, lastFailedAt: now });

    // Prune stale entries from other keys on a sampling basis
    if (this.failureCounters.size > 200) {
      const cutoff = now - FAILURE_ENTRY_MAX_AGE_MS;
      for (const [k, v] of this.failureCounters) {
        if (v.lastFailedAt < cutoff) this.failureCounters.delete(k);
      }
    }

    if (count >= threshold) {
      const action = failureCode === 'no_context'
        ? 'Mark price is not available. Stop retrying and consider a different instrument.'
        : 'Too many consecutive failures. Check the instrument format and try a different approach.';
      return {
        retryable: false,
        message: `${originalMessage} [CIRCUIT BREAKER: ${count} consecutive '${failureCode}' failures on ${instrumentId}. ${action}]`,
      };
    }

    return { retryable: originalRetryable, message: originalMessage };
  }

  /** Reset the failure counter for a given instrument (called on successful acceptance). */
  private resetCircuitBreaker(actorId: string, instrumentId: string | undefined): void {
    if (!instrumentId) return;
    // Remove all failure-code entries for this (actor, instrument)
    const prefix = `${actorId}::${instrumentId}::`;
    for (const key of this.failureCounters.keys()) {
      if (key.startsWith(prefix)) this.failureCounters.delete(key);
    }
  }

  async handleDecisionSubmit(envelope: MessageEnvelope, payload: DecisionSubmitPayload): Promise<void> {
    const { agentId, botId, initiatorId, initiatorType, tradingInstanceId } = envelope;
    const effectiveAgentId = agentId ?? initiatorId;
    const effectiveBotId = tradingInstanceId ?? botId ?? effectiveAgentId;
    const resolveId = effectiveAgentId;

    // Track outcome for synchronous reply to the agent's submit_decision tool
    const expectsReply = payload._expectsReply === true;
    let syncReply: { status: 'accepted' | 'rejected' | 'error' | 'pending_approval'; code?: string; message?: string; planId?: string; approvalId?: string; shortCode?: string; expiresAt?: string } | null = null;
    const setSyncReply = (
      status: 'accepted' | 'rejected' | 'error' | 'pending_approval',
      opts: { code?: string; message?: string; planId?: string; approvalId?: string; shortCode?: string; expiresAt?: string },
    ) => {
      syncReply = { status, ...opts };
    };
    const publishSyncReply = async () => {
      if (expectsReply && syncReply) {
        try {
          await this.eventPublisher.publishDecisionReply(payload.decisionId, syncReply);
        } catch (err) {
          logger.warn({ decisionId: payload.decisionId, err }, 'Failed to publish decision reply — agent will not receive synchronous feedback');
        }
      }
    };

    try {

    // 1. Verify agent is not paused.
    // A missing agents row is NOT treated as paused — it likely means the agent was
    // launched directly (e.g. via docker run) without going through the API provisioning
    // flow, or the agents table was transiently truncated while the container kept
    // running. The active-session check below is the real liveness gate.
    const agent = await this.agentRepo.getAgent(effectiveAgentId);
    if (agent && (agent.status === 'paused' || agent.status === 'stopped')) {
      const msg = `Agent is ${agent.status} — cannot accept decisions`;
      setSyncReply('rejected', { code: 'agent_paused', message: msg });
      await this.eventPublisher.emitDecisionRejected(effectiveBotId, {
        decisionId: payload.decisionId,
        code: 'agent_paused',
        message: msg,
        retryable: false,
      });
      this.recordFailure({ actorType: 'agent', actorId: effectiveAgentId, decisionId: payload.decisionId, instrumentId: payload.instrumentId, failureCode: 'agent_paused', failureMessage: msg, failureClass: 'rejection', retryable: false });
      return;
    }

    // 2. Verify the submitting runtime owns the current active session.
    // Defense-in-depth: also checked at broker boundary (processInbound step 3).
    // This prevents superseded containers from trading after a restart/relink.
    const runtimeSessionId = envelope.correlationId;
    const isActiveSession = await this.agentRepo.isActiveSession(effectiveAgentId, runtimeSessionId);
    if (!isActiveSession) {
      const msg = 'Decision rejected — runtime session is no longer the active session';
      setSyncReply('rejected', { code: 'stale_session', message: msg });
      await this.eventPublisher.emitDecisionRejected(effectiveBotId, {
        decisionId: payload.decisionId,
        code: 'stale_session',
        message: msg,
        retryable: false,
      });
      this.recordFailure({ actorType: 'agent', actorId: effectiveAgentId, decisionId: payload.decisionId, instrumentId: payload.instrumentId, failureCode: 'stale_session', failureMessage: msg, failureClass: 'rejection', retryable: false });
      return;
    }

    // 3. Resolve authorization mode from the agent's unified config.
    // Default to 'direct' for agents without a unifiedConfig row (legacy or direct-launched).
    const raw = agent?.unifiedConfig as unknown as Record<string, unknown> | null | undefined;
    const authorizationMode: 'direct' | 'approval_required' =
      raw?.authorizationMode === 'approval_required' ? 'approval_required' : 'direct';

    // 3a. Approval-required gate: create a pending approval instead of executing.
    if (authorizationMode === 'approval_required' && this.approvalRepo && this.agentApprovalsTtlMs) {
      // Reject dry-run submissions in approval-required mode.
      if (payload.dryRun) {
        const msg = 'Dry-run submissions are not supported in approval-required mode. Set authorizationMode to \'direct\' to test decisions without execution.';
        setSyncReply('rejected', { code: 'dry_run_approval_mode', message: msg });
        await this.eventPublisher.emitDecisionRejected(effectiveBotId, {
          decisionId: payload.decisionId,
          code: 'dry_run_approval_mode',
          message: msg,
          retryable: false,
        });
        this.recordFailure({ actorType: 'agent', actorId: effectiveAgentId, decisionId: payload.decisionId, instrumentId: payload.instrumentId, failureCode: 'dry_run_approval_mode', failureMessage: msg, failureClass: 'rejection', retryable: false });
        return;
      }
      // Resolve lightweight execution context to build the approval snapshot.
      const intakeResult = await this.intakeResolver.getIntakeDeps(resolveId, payload.instrumentId);
      if (!intakeResult || isIntakeRejection(intakeResult)) {
        const msg = !intakeResult
          ? 'No execution context — cannot create approval without a valid trading connection'
          : intakeResult.message;
        const code = !intakeResult ? 'instance_not_running' : intakeResult.code;
        setSyncReply('rejected', { code, message: msg });
        await this.eventPublisher.emitDecisionRejected(effectiveBotId, {
          decisionId: payload.decisionId,
          code,
          message: msg,
          retryable: true,
        });
        this.recordFailure({ actorType: 'agent', actorId: effectiveAgentId, decisionId: payload.decisionId, instrumentId: payload.instrumentId, failureCode: code, failureMessage: msg, failureClass: 'rejection', retryable: true });
        return;
      }

      const userId = agent?.userId;
      if (!userId) {
        const msg = 'Approval-required mode requires an owned agent with a user — cannot create approval';
        setSyncReply('rejected', { code: 'approval_no_user', message: msg });
        await this.eventPublisher.emitDecisionRejected(effectiveBotId, {
          decisionId: payload.decisionId,
          code: 'approval_no_user',
          message: msg,
          retryable: false,
        });
        this.recordFailure({ actorType: 'agent', actorId: effectiveAgentId, decisionId: payload.decisionId, instrumentId: payload.instrumentId, failureCode: 'approval_no_user', failureMessage: msg, failureClass: 'rejection', retryable: false });
        return;
      }

      // Generate a unique short code per user.
      // The unique index is on (userId, shortCode), so we retry on DB-level collisions.
      let shortCode = generateShortCode();
      const MAX_CODE_ATTEMPTS = 5;
      let approvalId: string | null = null;
      const expiresAt = new Date(Date.now() + this.agentApprovalsTtlMs);
      const proposedPayload: Record<string, unknown> = {
        instrumentId: payload.instrumentId,
        intent: payload.intent,
        targetSize: payload.targetSize,
        limitPrice: payload.limitPrice ?? null,
        stopLoss: payload.stopLoss ?? null,
        takeProfit: payload.takeProfit ?? null,
        confidence: payload.confidence ?? null,
        rationaleSummary: payload.rationaleSummary,
        contextHash: payload.contextHash ?? null,
        metadata: payload.metadata ?? {},
      };

      for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
        // Pre-check: skip codes already known to exist (optimistic fast path).
        const existing = await this.approvalRepo.findByUserIdAndShortCode(userId, shortCode);
        if (existing) {
          shortCode = generateShortCode();
          continue;
        }

        try {
          approvalId = await this.approvalRepo.createApproval({
            shortCode,
            userId,
            agentId: effectiveAgentId,
            actorType: initiatorType,
            actorId: initiatorId,
            venueAccountId: intakeResult.venueAccountId,
            authorizationModeSnapshot: authorizationMode,
            status: 'pending',
            instrumentId: payload.instrumentId,
            intent: payload.intent,
            targetSize: payload.targetSize,
            limitPrice: payload.limitPrice ?? null,
            stopLoss: payload.stopLoss ?? null,
            takeProfit: payload.takeProfit ?? null,
            confidence: payload.confidence?.toString() ?? null,
            rationaleSummary: payload.rationaleSummary,
            contextHash: payload.contextHash ?? null,
            proposedPayload,
            expiresAt,
          });
          break; // Success — exit the retry loop.
        } catch (err: unknown) {
          // PostgreSQL unique violation error code (23505).
          // The index is on (userId, shortCode) — a concurrent request beat us to this code.
          const isUniqueViolation =
            typeof err === 'object' && err !== null &&
            'code' in err && (err as { code: string }).code === '23505';
          if (isUniqueViolation) {
            shortCode = generateShortCode();
            continue;
          }
          throw err;
        }
      }
      if (!approvalId) {
        const msg = 'Failed to generate a unique short code after multiple attempts';
        setSyncReply('error', { code: 'approval_code_collision', message: msg });
        return;
      }

      const expiresAtISO = expiresAt.toISOString();
      const approvalNote = `Decision recorded and sent to the user for approval. No trade has been executed yet. Ask the user to approve with /yes ${shortCode} or reject with /no ${shortCode}.`;

      setSyncReply('pending_approval', {
        message: approvalNote,
        approvalId,
        shortCode,
        expiresAt: expiresAtISO,
      });
      await publishSyncReply();
      syncReply = null; // Prevent double-publish in finally block

      // Emit the pending approval event for activity feed / notifications.
      try {
        await this.eventPublisher.emitDecisionPendingApproval(effectiveBotId, {
          decisionId: payload.decisionId,
          approvalId,
          shortCode,
          expiresAt: expiresAtISO,
          instrumentId: payload.instrumentId,
          intent: payload.intent,
          targetSize: payload.targetSize,
          rationaleSummary: payload.rationaleSummary,
        });
      } catch (err) {
        logger.warn({ decisionId: payload.decisionId, approvalId, err }, 'Failed to emit pending approval event');
      }

      // Deliver platform-authored notification directly via Telegram.
      // This is best-effort — failure does not block approval creation.
      if (this.telegramBotToken && userId) {
        this.sendApprovalTelegramNotification(
          userId,
          effectiveAgentId,
          agent?.name ?? 'Agent',
          shortCode,
          payload.instrumentId,
          payload.intent,
          payload.targetSize,
          payload.limitPrice,
          payload.stopLoss,
          payload.takeProfit,
          payload.confidence,
          payload.rationaleSummary,
          expiresAtISO,
        ).catch((err) => {
          logger.warn({ approvalId, err }, 'Failed to send approval Telegram notification');
        });
      }

      // Publish a user notification to Redis pub/sub so the API/WebSocket layer
      // can deliver it to the user's connected clients (web UI, Telegram bot).
      if (userId) {
        await this.eventPublisher.publishUserNotification(userId, {
          type: 'decision.pending_approval',
          payload: {
            approvalId,
            shortCode,
            agentId: effectiveAgentId,
            instrumentId: payload.instrumentId,
            intent: payload.intent,
            targetSize: payload.targetSize,
            rationaleSummary: payload.rationaleSummary,
            expiresAt: expiresAtISO,
          },
        });
      }

      // Trigger a platform notification to the user.
      // Use the existing send_message pattern via the event publisher/journal.
      try {
        await this.eventPublisher.emitJournalEvent(effectiveAgentId, {
          journalType: 'approval.pending',
          timestamp: new Date().toISOString(),
          detail: JSON.stringify({
            approvalId,
            shortCode,
            instrumentId: payload.instrumentId,
            intent: payload.intent,
            targetSize: payload.targetSize,
            rationaleSummary: payload.rationaleSummary,
            expiresAt: expiresAtISO,
            ttlMs: this.agentApprovalsTtlMs,
          }),
        });
      } catch (err) {
        logger.error({ decisionId: payload.decisionId, approvalId, err }, 'Failed to emit approval journal event');
      }

      return;
    }

    // 4. Resolve execution deps — try bot registry first, then agent grants
    const intakeResult = await this.intakeResolver.getIntakeDeps(resolveId, payload.instrumentId);
    if (!intakeResult) {
      const msg = 'No execution context — ensure the actor is active and has an active trading grant';
      setSyncReply('rejected', { code: 'instance_not_running', message: msg });
      await this.eventPublisher.emitDecisionRejected(effectiveBotId, {
        decisionId: payload.decisionId,
        code: 'instance_not_running',
        message: msg,
        retryable: true,
      });
      this.recordFailure({ actorType: 'agent', actorId: effectiveAgentId, decisionId: payload.decisionId, instrumentId: payload.instrumentId, failureCode: 'instance_not_running', failureMessage: msg, failureClass: 'rejection', retryable: true });
      return;
    }
    if (isIntakeRejection(intakeResult)) {
      const cb = this.checkCircuitBreaker(effectiveAgentId, payload.instrumentId, intakeResult.code, intakeResult.message, intakeResult.retryable);
      setSyncReply('rejected', { code: intakeResult.code, message: cb.message });
      await this.eventPublisher.emitDecisionRejected(effectiveBotId, {
        decisionId: payload.decisionId,
        code: intakeResult.code,
        message: cb.message,
        retryable: cb.retryable,
      });
      this.recordFailure({ actorType: 'agent', actorId: effectiveAgentId, decisionId: payload.decisionId, instrumentId: payload.instrumentId, failureCode: intakeResult.code, failureMessage: cb.message, failureClass: 'rejection', retryable: cb.retryable });
      return;
    }
    const intakeDeps = intakeResult;

    // Instrument mismatch check — skip for agents (multi-symbol)
    if (intakeDeps.actorType !== 'agent' && payload.instrumentId !== intakeDeps.symbol) {
      setSyncReply('rejected', { code: 'instrument_mismatch', message: 'Decision instrument does not match the actor symbol' });
      await this.eventPublisher.emitDecisionRejected(effectiveBotId, {
        decisionId: payload.decisionId,
        code: 'instrument_mismatch',
        message: 'Decision instrument does not match the actor symbol',
        retryable: false,
        details: {
          expectedInstrumentId: intakeDeps.symbol,
          receivedInstrumentId: payload.instrumentId,
        },
      });
      return;
    }

    const context = await this.intakeResolver.getDecisionContext(resolveId, payload.instrumentId);
    if (!context) {
      const baseMsg = 'No decision context available — actor may still be initializing or mark price unavailable';
      // Don't count no_context failures until the actor has proven it CAN fetch context.
      // During startup, marks take a moment to load — penalizing the agent for that
      // would cause a false-positive circuit breaker trip.
      const isInitializing = !this.actorsWithSuccessfulContext.has(effectiveAgentId);
      const cb = isInitializing
        ? { retryable: true, message: baseMsg }
        : this.checkCircuitBreaker(effectiveAgentId, payload.instrumentId, 'no_context', baseMsg, true);
      setSyncReply('rejected', { code: 'no_context', message: cb.message });
      await this.eventPublisher.emitDecisionRejected(effectiveBotId, {
        decisionId: payload.decisionId,
        code: 'no_context',
        message: cb.message,
        retryable: cb.retryable,
      });
      this.recordFailure({ actorType: 'agent', actorId: effectiveAgentId, decisionId: payload.decisionId, instrumentId: payload.instrumentId, failureCode: 'no_context', failureMessage: cb.message, failureClass: 'rejection', retryable: cb.retryable });
      return;
    }

    // Record that this actor can successfully fetch decision context.
    // Used by the no_context path to distinguish startup from persistent unavailability.
    this.actorsWithSuccessfulContext.add(effectiveAgentId);

    const position = await this.intakeResolver.getPosition(resolveId, payload.instrumentId);
    if (!position) {
      const msg = 'Position state not available';
      setSyncReply('rejected', { code: 'no_position_state', message: msg });
      await this.eventPublisher.emitDecisionRejected(effectiveBotId, {
        decisionId: payload.decisionId,
        code: 'no_position_state',
        message: msg,
        retryable: true,
      });
      this.recordFailure({ actorType: 'agent', actorId: effectiveAgentId, decisionId: payload.decisionId, instrumentId: payload.instrumentId, failureCode: 'no_position_state', failureMessage: msg, failureClass: 'rejection', retryable: true });
      return;
    }

    // 4. Build the Decision from the agent payload
    const decision: Decision = {
      id: payload.decisionId as DecisionId,
      venueAccountId: intakeDeps.venueAccountId as VenueAccountId,
      instrumentId: payload.instrumentId as InstrumentId,
      intent: payload.intent,
      targetSize: new Decimal(payload.targetSize),
      limitPrice: payload.limitPrice ? new Decimal(payload.limitPrice) : undefined,
      stopLoss: payload.stopLoss ? new Decimal(payload.stopLoss) : undefined,
      takeProfit: payload.takeProfit ? new Decimal(payload.takeProfit) : undefined,
      timestamp: envelope.createdAt,
      contextHash: payload.contextHash,
      metadata: {
        ...payload.metadata,
        rationaleSummary: payload.rationaleSummary,
        confidence: payload.confidence,
      },
      actorType: initiatorType,
      actorId: initiatorId,
    };

    // 4b. Validate per-trade stopLoss/takeProfit levels against mark price
    // before accepting the decision. Skip for exit intents (go_flat, decrease).
    if (POSITION_GROWING_INTENTS.has(decision.intent) && (decision.stopLoss || decision.takeProfit)) {
      let validationSide: 'long' | 'short' | null = null;
      if (decision.intent === 'go_long') {
        validationSide = 'long';
      } else if (decision.intent === 'go_short') {
        validationSide = 'short';
      } else if (decision.intent === 'increase') {
        if (position.side === 'long' || position.side === 'short') {
          validationSide = position.side;
        }
        // Flat position with 'increase' intent is anomalous — skip validation.
      }

      if (validationSide) {
        const markPriceStr = context.referenceMark.price;
        let markPrice: Decimal | undefined;
        if (markPriceStr) {
          try {
            markPrice = new Decimal(markPriceStr);
          } catch {
            logger.warn({ decisionId: payload.decisionId, markPriceStr }, 'Skipping per-trade level validation — malformed mark price');
          }
        }

        if (markPrice) {
          const validationError = validatePerTradeLevels({
            side: validationSide,
            markPrice,
            stopLoss: decision.stopLoss,
            takeProfit: decision.takeProfit,
          });

          if (validationError) {
            const message = formatLevelValidationMessage(validationError);
            setSyncReply('rejected', { code: `level.${validationError.reason}`, message });
            await this.eventPublisher.emitDecisionRejected(effectiveBotId, {
              decisionId: payload.decisionId,
              code: `level.${validationError.reason}`,
              message,
              retryable: false,
            });
            this.recordFailure({
              actorType: 'agent',
              actorId: effectiveAgentId,
              decisionId: payload.decisionId,
              instrumentId: payload.instrumentId,
              failureCode: `level.${validationError.reason}`,
              failureMessage: message,
              failureClass: 'rejection',
              retryable: false,
            });
            return;
          }
        } else {
          logger.warn({ decisionId: payload.decisionId }, 'Skipping per-trade level validation — mark price unavailable');
        }
      }
    }

    // 5. Submit through the shared decision intake pipeline.
    try {
      const depsWithOverride: DecisionIntakeDeps = payload.safetyOverrideId
        ? { ...intakeDeps, safetyOverrideId: payload.safetyOverrideId }
        : intakeDeps;
      const result = await submitDecisionForExecution(decision, context, position, depsWithOverride);

      // Track execution outcome for circuit breaker
      if (result.executionFailed) {
        this.intakeResolver.recordExecutionOutcome?.(resolveId, false);
      } else if (result.executionResult) {
        this.intakeResolver.recordExecutionOutcome?.(resolveId, true);
      }

      // Write equity snapshot to Redis so the agent's get_risk_limits tool
      // can read live drawdown data (Issue 2a). Written after every decision —
      // accepted or rejected — so the drawdown is at most one decision stale.
      if (intakeDeps.equityTracker) {
        const unrealized = intakeDeps.precomputedUnrealizedPnl ?? (result.position.side !== 'flat'
          ? new Decimal(0) // snapshot-derived below would be more accurate; this is a fallback
          : new Decimal(0));
        // Use a minimal snapshot — full unrealized P&L computation requires
        // per-instrument mark prices which aren't available here. The zero
        // unrealizedPnl is a known limitation for multi-position actors.
        this.eventPublisher.publishEquitySnapshot(effectiveAgentId, {
          realizedPnl: result.position.realizedPnl.toString(),
          unrealizedPnl: unrealized.toString(),
          currentDrawdown: intakeDeps.equityTracker.currentDrawdown(unrealized).toString(),
          equity: intakeDeps.equityTracker.currentEquity(unrealized).toString(),
          peakEquity: intakeDeps.equityTracker.peakEquity?.toString(),
          timestamp: new Date().toISOString(),
        }).catch((err: unknown) => {
          logger.warn({ actorId: effectiveAgentId, err }, 'Failed to persist equity snapshot');
        });
      }

      // Handle pre-execution rejection (e.g. swap token safety)
      if (result.preExecutionRejection) {
        setSyncReply('rejected', { code: result.preExecutionRejection.code, message: result.preExecutionRejection.message });
        await this.eventPublisher.emitDecisionRejected(effectiveBotId, {
          decisionId: payload.decisionId,
          code: result.preExecutionRejection.code,
          message: result.preExecutionRejection.message,
          retryable: result.preExecutionRejection.retryable,
          details: result.preExecutionRejection.details,
        });
        this.recordFailure({ actorType: 'agent', actorId: effectiveAgentId, decisionId: payload.decisionId, instrumentId: payload.instrumentId, venueAccountId: intakeDeps.venueAccountId, failureCode: result.preExecutionRejection.code, failureMessage: result.preExecutionRejection.message, failureClass: 'rejection', retryable: result.preExecutionRejection.retryable, details: (result.preExecutionRejection.details as Record<string, unknown> | undefined) ?? null });
        return;
      }

      try {
        if (result.riskRejected) {
          const riskCode = result.riskError?.code ?? 'risk.rejected';
          const baseRiskMsg = result.riskError?.message ?? 'Decision rejected by risk gate';
          let riskMsg = baseRiskMsg;
          if (riskCode === 'risk.daily_max_loss_exceeded') {
            const nowMs = Date.now();
            const oldestMs = intakeDeps.dailyLossTracker?.oldestEntryMs(nowMs);
            const blockedTill = oldestMs != null
              ? new Date(oldestMs + 86_400_000).toISOString()
              : 'within 24h';
            riskMsg = `${baseRiskMsg}. New positions are blocked till at least ${blockedTill} (subsequent losses may extend the block). Use go_flat or decrease to manage existing open positions.`;
          }
          setSyncReply('rejected', { code: riskCode, message: riskMsg });
          await this.eventPublisher.emitGuardrailTriggered(effectiveBotId, {
            scope: 'risk_gate',
            code: riskCode,
            message: riskMsg,
            decisionId: payload.decisionId,
            details: result.riskError?.context,
          });
          this.recordFailure({ actorType: 'agent', actorId: effectiveAgentId, decisionId: payload.decisionId, instrumentId: payload.instrumentId, venueAccountId: intakeDeps.venueAccountId, failureCode: riskCode, failureMessage: riskMsg, failureClass: 'rejection', retryable: false });
          return;
        }

        // 5a. Build non-blocking reminder for position-growing intents missing
        // stopLoss or takeProfit levels (per-trade protection).
        const buildAcceptedMessage = (): string | undefined => {
          if (!POSITION_GROWING_INTENTS.has(decision.intent)) return undefined;
          const hasSl = decision.stopLoss !== undefined;
          const hasTp = decision.takeProfit !== undefined;
          if (!hasSl && !hasTp) {
            return "Accepted. Note: no stopLoss or takeProfit set — this position is unprotected if you're unable to trade.";
          }
          if (!hasSl) {
            return "Accepted. Note: no stopLoss set — this position has no downside protection if you're unable to trade.";
          }
          if (!hasTp) {
            return "Accepted. Note: no takeProfit set — profits won't be captured if you're unable to trade.";
          }
          return undefined;
        };

        // 6. Emit accepted — deferred until hash, risk, AND execution checks all pass.
        // Previously this was emitted before the execution result check, which meant
        // the agent could receive "accepted" for a decision that subsequently failed
        // during execution (e.g. executor timeout in shadow mode).
        this.resetCircuitBreaker(effectiveAgentId, payload.instrumentId);
        await this.eventPublisher.emitDecisionAccepted(effectiveBotId, {
          decisionId: payload.decisionId,
          acceptedAt: new Date().toISOString(),
          normalizedDecision: {
            id: decision.id,
            instrumentId: decision.instrumentId,
            intent: decision.intent,
            targetSize: decision.targetSize.toString(),
            limitPrice: decision.limitPrice?.toString(),
            actorType: decision.actorType,
            actorId: decision.actorId,
          },
        });

        // 7. Emit plan status
        if (result.plan) {
          await this.eventPublisher.emitPlanStatus(effectiveBotId, {
            decisionId: payload.decisionId,
            planId: result.plan.id,
            status: result.plan.status as 'created' | 'executing' | 'completed' | 'failed',
            action: result.plan.action,
            venue: result.plan.venue,
            symbol: result.plan.symbol,
            orderCount: result.plan.orders.length,
          });
        }

        // 8. Emit execution result AND set sync reply based on actual outcome
        if (result.executionFailed) {
          const errCode = result.executionError?.code ?? 'execution.failed';
          const errMsg = result.executionError?.message ?? 'Decision accepted by risk gate but execution failed';
          setSyncReply('error', { code: errCode, message: errMsg });
          await this.eventPublisher.emitExecutionResult(effectiveBotId, {
            decisionId: payload.decisionId,
            planId: result.plan?.id ?? '',
            orders: [],
            fills: [],
            positionAfter: {
              side: result.position.side,
              size: result.position.size.toString(),
              entryPrice: result.position.entryPrice.toString(),
            },
            executionFailed: true,
            completedAt: new Date().toISOString(),
          });
        } else if (result.executionResult) {
          setSyncReply('accepted', { planId: result.plan?.id, message: buildAcceptedMessage() });
          await this.eventPublisher.emitExecutionResult(effectiveBotId, {
            decisionId: payload.decisionId,
            planId: result.plan?.id ?? '',
            orders: result.executionResult.orders.map((o) => ({
              id: o.id,
              side: o.side,
              type: o.type,
              quantity: o.quantity.toString(),
              status: o.status,
            })),
            fills: result.executionResult.fills.map((f) => ({
              side: f.side,
              quantity: f.quantity.toString(),
              price: f.price.toString(),
            })),
            positionAfter: {
              side: result.position.side,
              size: result.position.size.toString(),
              entryPrice: result.position.entryPrice.toString(),
            },
            executionFailed: false,
            completedAt: new Date().toISOString(),
          });
        } else {
          // Execution produced no result and didn't fail — e.g. no-op plan
          setSyncReply('accepted', { planId: result.plan?.id, message: buildAcceptedMessage() });
        }
      } catch (publishErr) {
        logger.error({ decisionId: payload.decisionId, err: publishErr }, 'Failed to publish decision outcome');
      }
    } catch (err) {
      if (err instanceof DecisionContextHashMismatchError) {
        setSyncReply('rejected', { code: 'context_hash_mismatch', message: 'Decision context hash does not match the server-resolved context' });
        await this.eventPublisher.emitDecisionRejected(effectiveBotId, {
          decisionId: payload.decisionId,
          code: 'context_hash_mismatch',
          message: 'Decision context hash does not match the server-resolved context',
          retryable: false,
          details: {
            expectedHash: err.expectedHash,
            suppliedHash: err.suppliedHash,
          },
        });
        this.recordFailure({ actorType: 'agent', actorId: effectiveAgentId, decisionId: payload.decisionId, instrumentId: payload.instrumentId, failureCode: 'context_hash_mismatch', failureMessage: 'Decision context hash does not match the server-resolved context', failureClass: 'rejection', retryable: false });
        return;
      }

      logger.error({ decisionId: payload.decisionId, err }, 'Decision execution failed');
      const errMsg = err instanceof Error ? err.message : 'Unknown execution error';
      setSyncReply('error', { code: 'execution_error', message: errMsg });
      await this.eventPublisher.emitDecisionRejected(effectiveBotId, {
        decisionId: payload.decisionId,
        code: 'execution_error',
        message: errMsg,
        retryable: false,
      });
      this.recordFailure({ actorType: 'agent', actorId: effectiveAgentId, decisionId: payload.decisionId, instrumentId: payload.instrumentId, failureCode: 'execution_error', failureMessage: errMsg, failureClass: 'error', retryable: false });
    }
    } finally {
      await publishSyncReply();
    }
  }
}

function escapeHtmlTelegram(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
