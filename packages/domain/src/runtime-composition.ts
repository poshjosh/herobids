import type { CapabilityReadiness } from './platform.js';
import type { SkillDefinition } from './skills.js';

export interface RuntimeFamilyBindingDescriptor {
  family: string;
  bindingId: string;
  connectionId: string;
  provider: string;
  label: string;
  readiness: CapabilityReadiness;
  isDefault: boolean;
  bindingRef?: string | null;
  bindingProfile?: Record<string, unknown> | null;
  sourceVenueAccountId?: string | null;
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
  dailyTokenBudget?: number | null;
  dailyLossLimit?: string | null;
  maxBots?: number | null;
  maxSlippageBps?: number | null;
}

export interface RuntimeDescriptor {
  schemaVersion: 'v1';
  agentId: string;
  name?: string;
  goal: string;
  executionMode: string;
  resolvedSkills: SkillDefinition[];
  grantedBindingsByFamily: Record<string, RuntimeFamilyBindingDescriptor[]>;
  defaultBindingByFamily: Record<string, string | null>;
  readinessByFamily: Record<string, CapabilityReadiness>;
  toolPolicy: Record<string, unknown>;
  guardrails: RuntimeGuardrailDescriptor;
  budgets: RuntimeBudgetPolicy;
}

export interface RuntimeDescriptorUpdatePayload {
  runtimeDescriptor: RuntimeDescriptor;
  reason: 'grant_changed' | 'binding_changed' | 'readiness_changed' | 'session_start';
}