import type { CapabilityReadiness } from '../../lib/api-client.js';

// ---------------------------------------------------------------------------
// Brittle-match surface.
//
// These strings are produced verbatim by `deriveReadiness` in
// `packages/db/src/agent-runtime-descriptor.ts`. The readiness contract carries
// human reasons as free-form strings rather than codes, so the only way to map
// a reason to presentation copy is to match the exact text. Isolating the
// strings here (named, commented) keeps that fragility in one documented place:
// if the backend wording changes, this is the single file to update, and any
// unmatched reason safely falls through to the verbatim fallback below.
// ---------------------------------------------------------------------------
const NO_CONNECTIONS = 'no connections have been assigned for this capability family';
const NO_VENUE_ACCOUNT = 'connection has no resolved venue account — complete trading setup first';
const CONNECTION_REVOKED = 'connection has been revoked';
const ASSIGNMENT_REVOKED = 'connection assignment has been revoked';

export type ReadinessAction =
  | { kind: 'assignConnection' } // focus/scroll to Available connections card
  | { kind: 'finishSetup' }; // open ProviderSetupForm

export interface ReadinessView {
  tone: 'ready' | 'warn' | 'blocked';
  headlineId: string; // i18n key
  reasonId?: string; // i18n key for the human reason line
  rawReason?: string; // fallback: backend reason, verbatim (only when no reasonId)
  action?: {
    labelId: string; // i18n key
    helperId?: string; // i18n key
    variant: 'primary' | 'secondary';
    action: ReadinessAction;
  };
}

/**
 * Pure mapping from the backend readiness contract to a presentation
 * view-model. Returns i18n KEY strings only — the component resolves them. No
 * React, no react-intl, no I/O; deterministic given its input.
 */
export function toReadinessView(readiness: CapabilityReadiness): ReadinessView {
  const { state, effectiveReady, reasons } = readiness;

  // The readiness contract carries `family`; copy for the connection-centric
  // branches differs between trading (which has venue accounts and trade-flavoured
  // wording) and every other family (email, future messaging/automation), which
  // get neutral wording. Branches whose copy is already family-neutral
  // (accessRemoved, generic fallback) do not read this flag.
  const isTrading = readiness.family === 'trading';

  // 1. Ready — evaluated first so a ready capability never shows a reason.
  if (state === 'ready' && effectiveReady === true) {
    return {
      tone: 'ready',
      headlineId: isTrading
        ? 'agents.capabilityPage.status.readyHeadline'
        : 'agents.capabilityPage.status.readyHeadlineGeneric',
    };
  }

  // 2. Unconfigured — no connection assigned yet.
  if (state === 'unconfigured' && reasons.includes(NO_CONNECTIONS)) {
    return {
      tone: 'warn',
      headlineId: isTrading
        ? 'agents.capabilityPage.status.noConnectionHeadline'
        : 'agents.capabilityPage.status.noConnectionHeadlineGeneric',
      reasonId: isTrading
        ? 'agents.capabilityPage.status.noConnectionReason'
        : 'agents.capabilityPage.status.noConnectionReasonGeneric',
      action: {
        labelId: 'agents.capabilityPage.status.action.assignConnection',
        helperId: isTrading
          ? 'agents.capabilityPage.status.action.assignHelper'
          : 'agents.capabilityPage.status.action.assignHelperGeneric',
        variant: 'primary',
        action: { kind: 'assignConnection' },
      },
    };
  }

  // 3. Unconfigured — connection linked but trading account not set up. The
  // "no resolved venue account" reason is trading-specific by nature; guard on
  // family so a non-trading family that somehow carries it falls through to the
  // neutral verbatim fallback instead of showing "finish trading setup" copy.
  if (isTrading && state === 'unconfigured' && reasons.includes(NO_VENUE_ACCOUNT)) {
    return {
      tone: 'warn',
      headlineId: 'agents.capabilityPage.status.setupIncompleteHeadline',
      reasonId: 'agents.capabilityPage.status.setupIncompleteReason',
      action: {
        labelId: 'agents.capabilityPage.status.action.finishSetup',
        variant: 'primary',
        action: { kind: 'finishSetup' },
      },
    };
  }

  // 4. Revoked — the connection itself was revoked.
  if (state === 'revoked' && reasons.includes(CONNECTION_REVOKED)) {
    return {
      tone: 'blocked',
      headlineId: 'agents.capabilityPage.status.revokedHeadline',
      reasonId: isTrading
        ? 'agents.capabilityPage.status.revokedReason'
        : 'agents.capabilityPage.status.revokedReasonGeneric',
      action: {
        labelId: 'agents.capabilityPage.status.action.assignConnection',
        variant: 'primary',
        action: { kind: 'assignConnection' },
      },
    };
  }

  // 5. Revoked — the agent's assignment to the connection was removed.
  if (state === 'revoked' && reasons.includes(ASSIGNMENT_REVOKED)) {
    return {
      tone: 'blocked',
      headlineId: 'agents.capabilityPage.status.accessRemovedHeadline',
      reasonId: 'agents.capabilityPage.status.accessRemovedReason',
      action: {
        labelId: 'agents.capabilityPage.status.action.assignConnection',
        variant: 'primary',
        action: { kind: 'assignConnection' },
      },
    };
  }

  // Fallback — any other state (provisioning/degraded), or a revoked/
  // unconfigured state whose reason does not match a known constant. Show the
  // raw backend reason verbatim when present so operators still see the cause.
  const firstReason = reasons[0];
  const hasRawReason = typeof firstReason === 'string' && firstReason.length > 0;
  return {
    tone: 'warn',
    headlineId: 'agents.capabilityPage.status.genericNotReadyHeadline',
    ...(hasRawReason
      ? { rawReason: firstReason }
      : { reasonId: 'agents.capabilityPage.status.genericNotReadyReason' }),
    action: {
      labelId: 'agents.capabilityPage.status.action.assignConnection',
      variant: 'secondary',
      action: { kind: 'assignConnection' },
    },
  };
}
