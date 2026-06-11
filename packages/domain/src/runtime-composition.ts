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
  maxRecentToolMessages: number;
  maxToolResultChars: number;
  maxVisibleToolSchemas: number;
  maxContextBlockChars: number;
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

// Initialized with schema defaults so callers outside the agent process (API, worker)
// always receive concrete values. Override at agent startup via initDefaultRuntimeBudgets().
export let DEFAULT_RUNTIME_BUDGETS: RuntimeBudgetPolicy = {
  maxHistoryMessages: 20,
  maxRecentToolMessages: 6,
  maxToolResultChars: 4_000,
  maxVisibleToolSchemas: 16,
  maxContextBlockChars: 4_000,
};

/**
 * Set the module-level default runtime budgets from operator config.
 * Call once at process startup before constructing any runtime descriptors.
 */
export function initDefaultRuntimeBudgets(override: Partial<RuntimeBudgetPolicy>): void {
  if (override.maxHistoryMessages != null) DEFAULT_RUNTIME_BUDGETS.maxHistoryMessages = override.maxHistoryMessages;
  if (override.maxRecentToolMessages != null) DEFAULT_RUNTIME_BUDGETS.maxRecentToolMessages = override.maxRecentToolMessages;
  if (override.maxToolResultChars != null) DEFAULT_RUNTIME_BUDGETS.maxToolResultChars = override.maxToolResultChars;
  if (override.maxVisibleToolSchemas != null) DEFAULT_RUNTIME_BUDGETS.maxVisibleToolSchemas = override.maxVisibleToolSchemas;
  if (override.maxContextBlockChars != null) DEFAULT_RUNTIME_BUDGETS.maxContextBlockChars = override.maxContextBlockChars;
}