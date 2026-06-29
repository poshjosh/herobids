import { z } from 'zod';

// ---------------------------------------------------------------------------
// Readiness contract — shared across all capability families
// ---------------------------------------------------------------------------

export const READINESS_STATES = ['unconfigured', 'provisioning', 'ready', 'degraded', 'revoked'] as const;
export type ReadinessState = typeof READINESS_STATES[number];

/**
 * CapabilityReadiness — the shared readiness contract for any capability family.
 *
 * Combines two orthogonal axes:
 * - bindingReadiness: is the underlying infrastructure provisioned and healthy?
 * - agentEligibility: may this specific agent use the binding right now?
 *
 * effectiveReady is true only when both axes are satisfied.
 */
export interface CapabilityReadiness {
  family: string;
  state: ReadinessState;
  bindingReadiness: ReadinessState;
  agentEligibility: 'eligible' | 'ineligible';
  effectiveReady: boolean;
  connectionId?: string;
  reasons: string[];
  /** Optional family-specific diagnostic detail */
  detail?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Platform event envelope — shared across the entire platform
// ---------------------------------------------------------------------------

/**
 * PlatformEventEnvelope — canonical event shape for all platform activity.
 *
 * One event model across all capability families enables a single activity
 * stream, a single WebSocket envelope, and a single audit model.
 */
export const PlatformActorTypeSchema = z.enum(['user', 'agent', 'platform']);
export type PlatformActorType = z.infer<typeof PlatformActorTypeSchema>;

export interface PlatformEventEnvelope {
  id: string;
  timestamp: string;            // ISO 8601
  actorType: PlatformActorType;
  actorId: string;
  capabilityFamily?: string;    // undefined for platform-level events
  connectionId?: string;
  eventType: string;            // e.g. "agent.capability.readiness_changed"
  payload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Connection — platform resource representing a usable external linkage
// ---------------------------------------------------------------------------

export type ConnectionStatus = 'active' | 'revoked';

/**
 * Connection — a user-owned platform resource that links a credential
 * (or OAuth token) to a specific external provider.
 *
 * Connections are the single grantable entity. Capability grants
 * (trading, automation, messaging, etc.) are scoped directly to connections.
 */
export interface Connection {
  id: string;
  userId: string;
  /** FK → user_credentials.id; null for OAuth-based connections without raw secrets */
  credentialId: string | null;
  /** Provider identifier, e.g. "hyperliquid", "bybit", "twitter", "telegram" */
  provider: string;
  /** Human-readable label */
  label: string;
  status: ConnectionStatus;
  /** Absorbed from trading_bindings: account/wallet reference at the provider */
  providerRef: string | null;
  /** Absorbed from trading_bindings: normalized capability metadata */
  profile: Record<string, unknown> | null;
  /** Provider-specific cached metadata (read-only diagnostic surface) */
  meta: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Capability grant — agent's scoped authority to use a connection
// ---------------------------------------------------------------------------

export type GrantStatus = 'active' | 'revoked';

/**
 * CapabilityGrant — records that a user has granted an agent access to a
 * specific connection for a specific capability family.
 *
 * Grants are capability-family-scoped. One connection may produce multiple
 * grants across different agents and capability families.
 */
export interface CapabilityGrant {
  id: string;
  agentId: string;
  connectionId: string;
  /** Capability family this grant covers, e.g. "trading", "automation" */
  capabilityFamily: string;
  status: GrantStatus;
  grantedBy: string;    // userId of the granter
  grantedAt: Date;
  revokedAt: Date | null;
  meta: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Grant audit — append-only record of every grant and binding-state change
// ---------------------------------------------------------------------------

export type GrantAuditAction =
  | 'granted'
  | 'revoked'
  | 'connection_provisioned'
  | 'connection_state_changed'
  | 'readiness_changed';

/**
 * GrantAuditEntry — one immutable record for each grant or binding-state
 * transition. Append-only; rows are never updated or deleted.
 */
export interface GrantAuditEntry {
  id: string;
  grantId: string;
  action: GrantAuditAction;
  actorType: PlatformActorType;
  actorId: string;
  reason: string | null;
  detail: Record<string, unknown> | null;
  createdAt: Date;
}
