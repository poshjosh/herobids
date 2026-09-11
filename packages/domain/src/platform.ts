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
 * - connectionReadiness: is the underlying infrastructure provisioned and healthy?
 * - agentEligibility: may this specific agent use the connection right now?
 *
 * effectiveReady is true only when both axes are satisfied.
 */
export interface CapabilityReadiness {
  family: string;
  state: ReadinessState;
  connectionReadiness: ReadinessState;
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
  /** Account/wallet reference at the provider */
  providerRef: string | null;
  /** Normalized capability metadata */
  profile: Record<string, unknown> | null;
  /** Provider-specific cached metadata (read-only diagnostic surface) */
  meta: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Agent connection — agent's scoped authority to use a connection
// ---------------------------------------------------------------------------

/**
 * AgentConnection — records that a user has granted an agent access to a
 * specific connection.
 *
 * Capabilities are derived at runtime from shared provider metadata
 * (getRuntimeFamiliesForProvider), not duplicatively stored here. One active
 * row per (agent, connection).
 */
export interface AgentConnection {
  id: string;
  agentId: string;
  connectionId: string;
  /** active | revoked */
  status: 'active' | 'revoked';
  grantedBy: string;    // userId of the granter
  grantedAt: Date;
  revokedAt: Date | null;
  meta: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Agent connection audit — append-only record of every connection-state change
// ---------------------------------------------------------------------------

/**
 * AgentConnectionAuditEntry — one immutable record for each agent-connection
 * state transition. Append-only; rows are never updated or deleted.
 */
export interface AgentConnectionAuditEntry {
  id: string;
  agentConnectionId: string;
  action: 'granted' | 'revoked';
  actorType: PlatformActorType;
  actorId: string;
  reason: string | null;
  detail: Record<string, unknown> | null;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Credential audit events — platform-owned (userId-shaped)
// ---------------------------------------------------------------------------

/**
 * PlatformAuditEntry — an audit event ready to append to the platform journal.
 *
 * Structurally compatible with the db `JournalEntryInput` / `PgJournal.append`
 * shape (`{ type, payload }`). Relocated here from `@herobids/engine` (L3d-1)
 * because these are PLATFORM audit events consumed by KEEP platform routes
 * (`routes/credentials.ts`) — they must not live inside the trading engine
 * package that is slated for deletion.
 */
export interface PlatformAuditEntry {
  type: string;
  payload: Record<string, unknown>;
}

export interface CredentialCreatedPayload {
  credentialId: string;
  venue: string;
  userId: string;
  label: string;
}

/** Build a `credential.created` audit event (no secrets in the payload). */
export function credentialCreatedEvent(payload: CredentialCreatedPayload): PlatformAuditEntry {
  return { type: 'credential.created', payload: payload as unknown as Record<string, unknown> };
}

export interface CredentialRotatedPayload {
  credentialId: string;
  venue: string;
  userId?: string;
}

/** Build a `credential.rotated` audit event (no secrets in the payload). */
export function credentialRotatedEvent(payload: CredentialRotatedPayload): PlatformAuditEntry {
  return { type: 'credential.rotated', payload: payload as unknown as Record<string, unknown> };
}

export interface CredentialDeletedPayload {
  credentialId: string;
  venue: string;
  userId?: string;
}

/** Build a `credential.deleted` audit event (no secrets in the payload). */
export function credentialDeletedEvent(payload: CredentialDeletedPayload): PlatformAuditEntry {
  return { type: 'credential.deleted', payload: payload as unknown as Record<string, unknown> };
}
