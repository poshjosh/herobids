import type { CapabilityReadiness } from './platform.js';
import type { SkillDefinition } from './skills.js';

export interface RuntimeFamilyBindingDescriptor {
  family: string;
  connectionId: string;
  provider: string;
  label: string;
  readiness: CapabilityReadiness;
  isDefault: boolean;
  providerRef?: string | null;
  profile?: Record<string, unknown> | null;
}

export interface RuntimeBudgetPolicy {
  maxHistoryMessages: number;
  maxHistoryTokens: number;
  maxRecentToolMessages: number;
  maxToolResultChars: number;
  maxVisibleToolSchemas: number;
  maxContextBlockChars: number;
  toolResultFullRetentionTurns?: number;
  toolResultMaxStaleChars?: number;
}

export interface RuntimeGuardrailDescriptor {
  dailyTokenBudget?: string | null;
  /** @deprecated Removed — use dailyMaxLossPct (percent of equity) instead. Always null. */
  dailyLossLimit?: string | null;
  /** Daily realized-loss cap as percent of equity (0–100). Canonical replacement for dailyLossLimit. */
  dailyMaxLossPct?: string | null;
  maxDrawdownPct?: number | null;
  maxBots?: number | null;
  maxOpenPositions?: number | null;
  maxPositionSizePct?: number | null;
  /** Not surfaced to agents — enforced by engine backstop only. */
  stopLossPct?: number | null;
  capital?: string | null;
}

export interface RuntimeDescriptor {
  schemaVersion: 'v1';
  agentId: string;
  name?: string;
  /** Product preset identifier used to derive the agent's identity/role in the prompt. e.g. 'personal-assistant' | 'trading' | 'direct-trading' | 'trading-assistant' | 'custom'. Optional; missing => neutral default. */
  skillPresetId?: string;
  goal: string;
  executionMode: string;
  /** Authorization mode for agent-direct trade decisions: 'direct' (execute immediately) or 'approval_required' (require user approval). */
  authorizationMode: string;
  resolvedSkills: SkillDefinition[];
  grantedConnectionsByFamily: Record<string, RuntimeFamilyBindingDescriptor[]>;
  defaultConnectionByFamily: Record<string, string | null>;
  readinessByFamily: Record<string, CapabilityReadiness>;
  toolPolicy: Record<string, unknown>;
  guardrails: RuntimeGuardrailDescriptor;
  budgets: RuntimeBudgetPolicy;
}

export interface RuntimeDescriptorUpdatePayload {
  runtimeDescriptor: RuntimeDescriptor;
  reason: 'grant_changed' | 'binding_changed' | 'readiness_changed' | 'session_start';
}

/** Normalize a guardrail value that may be a number or numeric string to a finite number, or null. */
export function toGuardrailNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}