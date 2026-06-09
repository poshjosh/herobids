import type { ProviderRequestClass } from '../../../packages/market-data/src/types.js';
import type { SharedBudgetConfig } from '../../../packages/market-data/src/rate-limiter.js';

export type ScenarioId = 'A' | 'B' | 'C' | 'D' | 'E';
export type AgentRole = 'execution' | 'discovery' | 'mixed';
export type DataCategory = 'execution' | 'price' | 'regime' | 'discovery' | 'enrichment';
export type ProviderFailureMode = '429' | '5xx';
export type ProviderRateLimitBehavior = 'reject_429' | 'queue_and_delay';
export type AttemptOutcome = 'accepted' | 'rejected_429' | 'error_5xx';
export type MetricStatus = 'PASS' | 'FAIL' | 'WARN' | 'N/A';
export type ScenarioVerdict = 'PASS' | 'FAIL' | 'DEGRADED';

export interface LatencyProfile {
  p50: number;
  p95: number;
  max?: number;
}

export interface ProviderWindowLimit {
  requests: number;
  windowMs: number;
}

export interface ProviderOutageWindow {
  startMs: number;
  durationMs: number;
  mode: ProviderFailureMode;
}

export interface MockProviderConfig {
  name: string;
  budget: SharedBudgetConfig;
  latencyMs: LatencyProfile;
  errorRate: number;
  rateLimitBehavior: ProviderRateLimitBehavior;
  upstreamLimit?: ProviderWindowLimit;
  outageWindows?: ProviderOutageWindow[];
}

export interface AgentRequestMix {
  provider: string;
  requestClass: ProviderRequestClass;
  category: DataCategory;
  count: number;
  fallbackProviders?: string[];
}

export interface AgentSimConfig {
  id: string;
  role: AgentRole;
  tickIntervalMs: number;
  tickCount: number;
  startOffsetMs?: number;
  requestsPerTick: AgentRequestMix[];
}

export interface ScenarioConfig {
  id: ScenarioId;
  name: string;
  description: string;
  durationMs: number;
  providers: MockProviderConfig[];
  agents: AgentSimConfig[];
  notes?: string[];
}

export interface ProviderAttemptRecord {
  provider: string;
  agentId: string;
  requestClass: ProviderRequestClass;
  category: DataCategory;
  outcome: AttemptOutcome;
  viaFallback: boolean;
  waitMs: number;
  queuedMs: number;
  latencyMs: number;
  atMs: number;
  reason?: string;
}

export interface ProviderStats {
  provider: string;
  attempted: number;
  accepted: number;
  rejected429: number;
  errors5xx: number;
  fallbackAccepted: number;
  averageLatencyMs: number;
  p95LatencyMs: number;
  averageWaitMs: number;
  rejectionRatePct: number;
  maxQueueDepth: number;
}

export interface AgentStats {
  agentId: string;
  role: AgentRole;
  callsMade: number;
  callsAccepted: number;
  callsRejected: number;
  fallbackActivations: number;
  staleDataEvents: number;
  starvationEvents: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  maxWaitMs: number;
}

export interface ThresholdCheck {
  metric: string;
  value: string;
  target: string;
  status: MetricStatus;
}

export interface ReportSummary {
  totalRequestsAttempted: number;
  totalRequestsAccepted: number;
  totalRequestsRejected429: number;
  totalErrors5xx: number;
  executionPriorityStarvationEvents: number;
  maxPriceStalenessMs: number;
  maxDiscoveryStalenessMs: number;
  fallbackActivations: number;
  recoveryTimeMs?: number;
  fairShareDeviationPct: number;
  maxProviderRejectionRatePct: number;
  maxQueueDepth: number;
}

export interface ScenarioRunResult {
  scenario: ScenarioConfig;
  runDateIso: string;
  simulatedDurationMs: number;
  providerStats: ProviderStats[];
  agentStats: AgentStats[];
  summary: ReportSummary;
  thresholdChecks: ThresholdCheck[];
  observations: string[];
  verdict: ScenarioVerdict;
  verdictReason: string;
}