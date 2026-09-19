// Shared helpers for the L3c `submit_decision` boundary rewire.
//
// The decision handler (and, later, the approval-execution path) build the
// Traderton `submit_decision` payload from the platform decision fields and map
// the boundary's terminal result back onto the tool's reply statuses
// (accepted / rejected / error) + the failure `code`/`retryable`. Keeping this
// here keeps the handler focused and lets the mapping be unit-tested directly.
//
// Transport + value-injection ONLY — no trading behaviour. The boundary returns
// `success | failure`; `pending_approval` is produced entirely pre-boundary by
// herobids and never crosses the wire (D3).

import type { DecisionSubmitPayload, RiskPosture, AgentRiskOverrides } from '@herobids/domain';
import type { TradertonClientResult } from '@herobids/domain/traderton';

/**
 * The Traderton `submit_decision` payload — the same fields the copied tool's
 * Zod schema validates on the Traderton side. `dryRun`/`_expectsReply` are
 * herobids protocol flags that never reach the boundary. `venueAccountId` is
 * NOT part of the SUBJECT (D2 stays ownerId+actor); it rides as a per-operation
 * payload arg — herobids owns the connection→account mapping and resolves the
 * concrete account off the chosen connection grant, so the boundary honours it
 * deterministically instead of falling back to per-owner default resolution.
 * The whole subject+payload is HMAC-signed, so payload placement is integrity-safe.
 */
export interface SubmitDecisionBoundaryPayload {
  instrumentId: string;
  intent: DecisionSubmitPayload['intent'];
  targetSize: string;
  limitPrice?: string;
  stopLoss?: string;
  takeProfit?: string;
  rationaleSummary: string;
  confidence?: number;
  safetyOverrideId?: string;
  contextHash?: string;
  venueAccountId?: string;
  // ── Consumer-injected platform risk context (NOT LLM inputs) ──────────────
  // The agent's capital + creator risk posture + runtime overrides live in the
  // platform `agents` row. The traderton boundary process cannot read that row
  // (locked: no `agents`-table dependency), so herobids injects the values it
  // still holds POST-LLM (the LLM never sees or supplies them; the values cross
  // inside the HMAC-signed payload). The boundary's agent-direct actor ensure
  // consumes them at construct/start time: capital anchors the actor's
  // EquityTracker (risk-gate daily-loss/drawdown math), riskPosture/riskOverrides
  // feed buildAgentRiskLimits. Absent → traderton operator defaults.
  capital?: string;
  riskPosture?: RiskPosture;
  riskOverrides?: AgentRiskOverrides;
  // Option A: the agent's REAL execution mode, platform-owned (from the `agents`
  // row). Never an LLM input — carried so the boundary uses it as the per-agent
  // escalation ceiling + actor construction mode instead of a static default.
  executionMode?: 'paper' | 'shadow' | 'live';
}

/** The platform risk context the caller injects alongside the decision. */
export interface AgentRiskInjection {
  capital?: string | null;
  riskPosture?: RiskPosture | null;
  riskOverrides?: AgentRiskOverrides | null;
  executionMode?: 'paper' | 'shadow' | 'live' | null;
}

/**
 * Build the boundary `submit_decision` payload from the platform decision fields.
 * `venueAccountId`, when the caller resolved one off the connection grant, is
 * threaded in as a payload arg (see the interface note — payload, not subject).
 * `riskInjection` (the agent row's capital/risk/riskOverrides) is likewise
 * platform-injected — carried through only when present/non-null so a
 * risk-context-less consumer keeps traderton's operator-default behaviour.
 */
export function buildSubmitDecisionPayload(
  payload: DecisionSubmitPayload,
  venueAccountId?: string,
  riskInjection?: AgentRiskInjection,
): SubmitDecisionBoundaryPayload {
  const out: SubmitDecisionBoundaryPayload = {
    instrumentId: payload.instrumentId,
    intent: payload.intent,
    targetSize: payload.targetSize,
    rationaleSummary: payload.rationaleSummary,
  };
  if (payload.limitPrice !== undefined) out.limitPrice = payload.limitPrice;
  if (payload.stopLoss !== undefined) out.stopLoss = payload.stopLoss;
  if (payload.takeProfit !== undefined) out.takeProfit = payload.takeProfit;
  if (payload.confidence !== undefined) out.confidence = payload.confidence;
  if (payload.safetyOverrideId !== undefined) out.safetyOverrideId = payload.safetyOverrideId;
  if (payload.contextHash !== undefined) out.contextHash = payload.contextHash;
  if (venueAccountId !== undefined && venueAccountId !== '') out.venueAccountId = venueAccountId;
  if (riskInjection?.capital != null && riskInjection.capital !== '') out.capital = riskInjection.capital;
  if (riskInjection?.riskPosture != null) out.riskPosture = riskInjection.riskPosture;
  if (riskInjection?.riskOverrides != null) out.riskOverrides = riskInjection.riskOverrides;
  if (riskInjection?.executionMode != null) out.executionMode = riskInjection.executionMode;
  return out;
}

// ── A3: risk-spec attachment for the boundary READ calls ──────────────────────

/**
 * The risk-spec fields the PLATFORM attaches to the boundary read calls
 * (`get_risk_limits` / `get_account_summary`). Same fields `submit_decision`
 * already carries; traderton declares them in those tools' schemas (Zod strips
 * undeclared fields) and binds them via its single RiskSource seam.
 */
export type RiskSpecPayloadFields = Pick<SubmitDecisionBoundaryPayload, 'capital' | 'riskPosture' | 'riskOverrides' | 'executionMode'>;

/**
 * Build the risk-spec payload fields from the platform risk context
 * (the `agents` row's capital/risk/riskOverrides). Carried through only when
 * present/non-null so a risk-context-less consumer keeps traderton's
 * operator-default behaviour. Reuses the exact field stamping of
 * {@link buildSubmitDecisionPayload} so both tools' payloads agree.
 */
export function buildRiskSpecPayloadFields(riskInjection?: AgentRiskInjection): RiskSpecPayloadFields {
  const out: RiskSpecPayloadFields = {};
  if (riskInjection?.capital != null && riskInjection.capital !== '') out.capital = riskInjection.capital;
  if (riskInjection?.riskPosture != null) out.riskPosture = riskInjection.riskPosture;
  if (riskInjection?.riskOverrides != null) out.riskOverrides = riskInjection.riskOverrides;
  if (riskInjection?.executionMode != null) out.executionMode = riskInjection.executionMode;
  return out;
}

/** The mapped sync-reply status the tool understands. */
export type MappedDecisionStatus = 'accepted' | 'rejected' | 'error';

/**
 * The mapped decision outcome — the handler applies this onto its sync reply +
 * emits the matching event. `retryable` is preserved verbatim from the boundary
 * (never re-derived). `data` carries the success payload (e.g. planId) when
 * present.
 */
export interface MappedDecisionOutcome {
  status: MappedDecisionStatus;
  code?: string;
  message?: string;
  retryable: boolean;
  planId?: string;
  data?: Record<string, unknown>;
}

/** Extract a `planId` from a success payload if the boundary returned one. */
function extractPlanId(payload: unknown): string | undefined {
  if (payload && typeof payload === 'object') {
    const p = payload as Record<string, unknown>;
    if (typeof p['planId'] === 'string') return p['planId'];
  }
  return undefined;
}

/**
 * Map the boundary client result onto the decision reply shape.
 *
 * - `success` → accepted (carrying any `planId` the boundary returned).
 * - `failure` → rejected, preserving `code`+`retryable` verbatim.
 * - `in_progress` → error (unexpected after poll-to-deadline; surfaces as a
 *   retryable processing error rather than a raw throw).
 * - `transport_error` → error (`precondition`/`transport` — retryable, NEVER a
 *   silent fall back to the in-process engine — L3c no-fallback posture).
 */
export function mapBoundaryResultToDecisionOutcome(
  result: TradertonClientResult,
): MappedDecisionOutcome {
  switch (result.kind) {
    case 'success': {
      const planId = extractPlanId(result.payload);
      return {
        status: 'accepted',
        retryable: false,
        ...(planId ? { planId } : {}),
      };
    }
    case 'failure':
      return {
        status: 'rejected',
        code: result.code,
        message: result.message,
        retryable: result.retryable,
      };
    case 'in_progress':
      return {
        status: 'error',
        code: 'boundary.in_progress',
        message: 'Trading boundary did not reach a terminal outcome within the deadline.',
        retryable: true,
      };
    case 'transport_error':
      return {
        status: 'error',
        code: 'boundary.transport_error',
        message: 'Trading boundary is unreachable — the decision was not submitted.',
        retryable: true,
      };
  }
}
