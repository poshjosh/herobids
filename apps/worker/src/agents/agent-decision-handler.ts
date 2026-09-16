import type { MessageEnvelope, DecisionSubmitPayload } from '@herobids/domain';
import type { AgentRepository } from '@herobids/db';
import type { DecisionApprovalRepository } from '@herobids/db';
import type { InstanceEventPublisher } from './instance-event-publisher.js';
import type { TradertonSideEffectBoundary } from '../traderton/write-adapter.js';
import { buildSubmitDecisionPayload, mapBoundaryResultToDecisionOutcome } from './decision-boundary-mapping.js';
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
 * AgentDecisionHandler — translates `agent.decision.submit` into the engine decision-ingestion path.
 */
export class AgentDecisionHandler {
  /** Per-instrument failure counters: key = `${agentId}::${instrumentId}::${failureCode}` */
  private readonly failureCounters = new Map<string, { count: number; lastFailedAt: number }>();

  private readonly breakerThresholds: Record<string, number>;

  constructor(
    private readonly agentRepo: AgentRepository,
    private readonly eventPublisher: InstanceEventPublisher,
    thresholds?: { noContext?: number; swapInstrumentFormat?: number },
    private readonly approvalRepo?: DecisionApprovalRepository,
    private readonly agentApprovalsTtlMs?: number,
    private readonly telegramBotToken?: string,
    // L3c: the Traderton side-effecting boundary. When present, submit_decision
    // executes over REST (invoke → poll) instead of the in-process engine. When
    // absent (unconfigured), the decision is rejected with a typed
    // precondition.not_ready — NEVER a silent fall back to the engine.
    private readonly sideEffectBoundary?: TradertonSideEffectBoundary,
    // Total budget (ms) for the boundary invoke + poll. Matches the tool's 30s
    // blpop so the sync reply still lands in time.
    private readonly boundaryDeadlineMs: number = 30_000,
    // L3c: resolves the venue-account id for the approval SNAPSHOT from the
    // connection grant (a KEEP platform value), NOT the engine. Returns null when
    // the agent has no ready trading connection. Optional so tests + legacy
    // construction paths without approval support still compile.
    private readonly approvalVenueAccountResolver?: (agentId: string) => Promise<string | null>,
  ) {
    this.breakerThresholds = {
      no_context: thresholds?.noContext ?? 10,
      'swap.instrument_format': thresholds?.swapInstrumentFormat ?? 5,
    };
  }

  private async sendApprovalTelegramNotification(
    _userId: string,
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

  /**
   * L3c: resolve the venue-account id for the approval SNAPSHOT from the
   * connection grant (KEEP platform value). Returns null when no resolver is
   * wired or the agent has no ready trading connection — the caller treats that
   * as `instance_not_running`. This replaces the engine-backed intake lookup the
   * approval branch used before the boundary rewire.
   */
  private async resolveGrantVenueAccountId(agentId: string): Promise<string | null> {
    if (!this.approvalVenueAccountResolver) return null;
    try {
      return await this.approvalVenueAccountResolver(agentId);
    } catch (err) {
      logger.warn({ agentId, err }, 'Failed to resolve approval snapshot venue account from connection grant');
      return null;
    }
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
        return;
      }
      // Resolve the venue-account id for the approval SNAPSHOT from the connection
      // grant (a KEEP platform value), NOT the engine (L3c: the engine is gone from
      // this path; investigation item — approval snapshot needs no engine-sourced
      // value). The snapshot is informational; the post-approve execute re-resolves
      // via the boundary subject. A ready trading connection is the liveness gate.
      const snapshotVenueAccountId = await this.resolveGrantVenueAccountId(effectiveAgentId);
      if (!snapshotVenueAccountId) {
        const msg = 'No execution context — cannot create approval without a valid trading connection';
        const code = 'instance_not_running';
        setSyncReply('rejected', { code, message: msg });
        await this.eventPublisher.emitDecisionRejected(effectiveBotId, {
          decisionId: payload.decisionId,
          code,
          message: msg,
          retryable: true,
        });
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
            venueAccountId: snapshotVenueAccountId,
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

    // 4. Execute over the Traderton REST boundary (L3c). NO silent fallback:
    // if the boundary is unconfigured, the decision is rejected with a typed
    // precondition — the in-process engine is NEVER invoked for a side effect.
    // Per-trade level validation + equity snapshot depended on engine-sourced
    // values (mark price / equityTracker); they MOVE behind the boundary
    // (recorded in 004-l3d-plan.md §C). herobids injects ownerId+actor only;
    // Traderton resolves the venue account (D2) and owns risk/planner/executor.
    if (!this.sideEffectBoundary) {
      const msg = 'Trading boundary is not configured — decisions cannot be executed.';
      setSyncReply('error', { code: 'precondition.not_ready', message: msg });
      await this.eventPublisher.emitDecisionRejected(effectiveBotId, {
        decisionId: payload.decisionId,
        code: 'precondition.not_ready',
        message: msg,
        retryable: true,
      });
      return;
    }

    // Subject stays ownerId + actor ONLY (D2). The venue account rides as a
    // payload arg (resolved below off the connection grant), not in the subject.
    const ownerId = agent?.userId ?? '';
    if (!ownerId) {
      const msg = 'Cannot submit decision — the agent has no owning user to authorize the trade.';
      setSyncReply('rejected', { code: 'authorization.denied', message: msg });
      await this.eventPublisher.emitDecisionRejected(effectiveBotId, {
        decisionId: payload.decisionId,
        code: 'authorization.denied',
        message: msg,
        retryable: false,
      });
      return;
    }

    try {
      // Resolve the concrete venue account off the connection grant (a KEEP
      // platform value) and thread it in as a payload arg so the boundary
      // resolves deterministically instead of failing ambiguous when the owner
      // has more than one account (D2 subject stays ownerId+actor). Null when no
      // resolver is wired — the boundary then keeps its per-owner default path.
      const venueAccountId = await this.resolveGrantVenueAccountId(effectiveAgentId) ?? undefined;
      const boundaryPayload = buildSubmitDecisionPayload(payload, venueAccountId);
      const result = await this.sideEffectBoundary.invokeAndAwait({
        toolName: 'submit_decision',
        payload: boundaryPayload,
        subject: { ownerId, actor: { type: initiatorType, id: effectiveAgentId } },
        deadlineMs: this.boundaryDeadlineMs,
      });
      const outcome = mapBoundaryResultToDecisionOutcome(result);

      if (outcome.status === 'accepted') {
        // Reset the circuit breaker on a clean acceptance.
        this.resetCircuitBreaker(effectiveAgentId, payload.instrumentId);
        setSyncReply('accepted', {
          ...(outcome.planId ? { planId: outcome.planId } : {}),
          message: 'Decision accepted and sent for execution.',
        });
        await this.eventPublisher.emitDecisionAccepted(effectiveBotId, {
          decisionId: payload.decisionId,
          acceptedAt: new Date().toISOString(),
          normalizedDecision: {
            id: payload.decisionId,
            instrumentId: payload.instrumentId,
            intent: payload.intent,
            targetSize: payload.targetSize,
            limitPrice: payload.limitPrice,
            actorType: initiatorType,
            actorId: initiatorId,
          },
        });
        return;
      }

      if (outcome.status === 'rejected') {
        const code = outcome.code ?? 'risk.rejected';
        const baseMsg = outcome.message ?? 'Decision rejected.';
        // Preserve the circuit-breaker behaviour for the boundary failure codes
        // it applies to (e.g. precondition.not_ready mapped to no_context-like
        // repetition); the breaker only fires for its configured codes.
        const cb = this.checkCircuitBreaker(effectiveAgentId, payload.instrumentId, code, baseMsg, outcome.retryable);
        setSyncReply('rejected', { code, message: cb.message });
        // A risk-gate rejection surfaces as a guardrail event; everything else as
        // a plain rejection — matching the pre-L3c event taxonomy.
        if (code.startsWith('risk.')) {
          await this.eventPublisher.emitGuardrailTriggered(effectiveBotId, {
            scope: 'risk_gate',
            code,
            message: cb.message,
            decisionId: payload.decisionId,
          });
        } else {
          await this.eventPublisher.emitDecisionRejected(effectiveBotId, {
            decisionId: payload.decisionId,
            code,
            message: cb.message,
            retryable: cb.retryable,
          });
        }
        return;
      }

      // status === 'error' — in_progress after deadline, or transport error.
      const errCode = outcome.code ?? 'execution_error';
      const errMsg = outcome.message ?? 'Decision could not be processed.';
      setSyncReply('error', { code: errCode, message: errMsg });
      await this.eventPublisher.emitDecisionRejected(effectiveBotId, {
        decisionId: payload.decisionId,
        code: errCode,
        message: errMsg,
        retryable: outcome.retryable,
      });
      return;
    } catch (err) {
      // The boundary adapter never throws for transport/boundary errors (those
      // map to the typed error outcome above). A throw here is an unexpected
      // internal fault — surface it as a typed error, never a raw leak.
      logger.error({ decisionId: payload.decisionId, err }, 'Decision boundary invocation failed unexpectedly');
      const errMsg = err instanceof Error ? err.message : 'Unknown execution error';
      setSyncReply('error', { code: 'execution_error', message: errMsg });
      await this.eventPublisher.emitDecisionRejected(effectiveBotId, {
        decisionId: payload.decisionId,
        code: 'execution_error',
        message: errMsg,
        retryable: false,
      });
      return;
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
