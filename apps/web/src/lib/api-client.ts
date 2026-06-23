import { config } from './config.js';
import { getToken, clearToken } from './session.js';
import type { ProviderCatalogResponse } from '@herobids/domain';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly params?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    ...(init?.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${config.apiBaseUrl}${path}`, { ...init, headers });

  if (res.status === 401) {
    // Don't force-redirect on auth endpoints — let the caller handle the error
    const isAuthEndpoint = path.startsWith('/auth/login') || path.startsWith('/auth/register') || path.startsWith('/auth/exchange');
    if (!isAuthEndpoint) {
      clearToken();
      // Soft redirect to login — avoid hard reload when the router handles this
      window.location.href = '/login';
      throw new ApiError(401, 'unauthorized', 'Session expired');
    }
    // For auth endpoints, fall through to the generic error handler below
  }

  if (!res.ok) {
    let code = 'api_error';
    let message = `HTTP ${res.status}`;
    let params: Record<string, unknown> | undefined;
    try {
      const body = await res.json() as {
        error?: string;
        message?: string;
        params?: Record<string, unknown>;
        details?: Array<{ message?: string }>;
      };
      code = body.error ?? code;
      params = body.params;
      if (body.message) {
        message = body.message;
      } else if (Array.isArray(body.details) && body.details.length > 0) {
        // API validation errors return structured details — surface all field messages
        const msgs = body.details
          .map((d) => d.message)
          .filter((m): m is string => typeof m === 'string' && m.length > 0);
        if (msgs.length > 0) message = msgs.join('; ');
      } else if (body.error) {
        // Plain error-only responses (e.g. 'not_found', 'already_running', 'Invalid or expired exchange code')
        message = body.error;
      }
    } catch {
      // non-JSON error response
    }
    throw new ApiError(res.status, code, message, params);
  }

  // 204 No Content
  if (res.status === 204) {
    return undefined as T;
  }

  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function buildQuery(params: Record<string, string | number | boolean | undefined | null>): string {
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  return qs ? `?${qs}` : '';
}

export interface MeResponse {
  id: string;
  displayName: string;
  email: string;
  avatarUrl: string | null;
  planId: string;
  isAdmin: boolean;
  planEntitlements: PlanEntitlements | null;
  preferredLocale: string | null;
  telegramChatId: string | null;
  createdAt: string;
}

export interface PlanSkillsEntitlements {
  canCreatePrivateSkills: boolean;
  canViewMarketplaceSkills: boolean;
  canPublishToMarketplace: boolean;
  autoPublishNonDraftSkills: boolean;
  canPriceSkills: boolean;
  canLikeMarketplaceSkills: boolean;
}

export interface PlanAgentsEntitlements {
  canViewOwnPrompts: boolean;
}

export interface PlanLimitsEntitlements {
  maxAgents: number;
  maxBots: number;
  maxConnections: number;
  maxCredentials: number;
  maxBindings: number;
  maxVenueAccounts: number;
  maxConcurrentBacktests: number;
  liveEnabled: boolean;
}

export interface PlanEntitlements {
  skills: PlanSkillsEntitlements;
  agents: PlanAgentsEntitlements;
  limits: PlanLimitsEntitlements;
}

export const auth = {
  exchange: (code: string) =>
    request<{ token: string }>('/auth/exchange', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),
  register: (email: string, password: string, displayName: string) =>
    request<{ token: string }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, displayName }),
    }),
  login: (email: string, password: string) =>
    request<{ token: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  me: () => request<MeResponse>('/auth/me'),
  updateMe: (data: { preferredLocale?: string | null; telegramChatId?: string | null }) =>
    request<MeResponse>('/auth/me', { method: 'PATCH', body: JSON.stringify(data) }),
  logout: () => request<{ ok: boolean }>('/auth/logout', { method: 'POST' }),
};

// ---------------------------------------------------------------------------
// AI model settings
// ---------------------------------------------------------------------------

export interface AiAvailableModelProvider {
  provider: string;
  models: AiAvailableModelEntry[];
  isMultiProvider?: boolean;
}

export interface AiAvailableModelEntry {
  id: string;
  pricing?: {
    label: string;
    source: 'openrouter' | 'local';
    inputUsdPer1M?: string;
    outputUsdPer1M?: string;
    requestUsd?: string;
  };
}

export interface AiAvailableModelsResponse {
  providers: AiAvailableModelProvider[];
}

export interface AiModelSettings {
  provider: string | null;
  lightModel: string | null;
  heavyModel: string | null;
}

export type AiModelSettingsUpdate =
  | { provider: string; lightModel: string; heavyModel: string }
  | { provider: null; lightModel: null; heavyModel: null };

export interface AiModelSettingsResponse {
  aiModelConfig: AiModelSettings | null;
}

export const ai = {
  availableModels: () => request<AiAvailableModelsResponse>('/ai/available-models'),
  settings: () => request<AiModelSettingsResponse>('/settings/ai-model'),
  updateSettings: (data: AiModelSettingsUpdate) => request<AiModelSettingsResponse>('/settings/ai-model', {
    method: 'PATCH',
    body: JSON.stringify(data),
  }),
};

// ---------------------------------------------------------------------------
// Dashboard composite read models
// ---------------------------------------------------------------------------

export interface DashboardOverview {
  user: { id: string; displayName: string; email: string; avatarUrl: string | null; planId: string };
  plan: {
    entitlements: PlanEntitlements;
  } | null;
  bots: BotSummary[];
  summary: { totalBots: number; runningBots: number; totalOpenPositions: number };
}

export interface ActivityEvent {
  id: string;
  botId: string | null;
  /** Human-readable venue/account label, e.g. "hyperliquid / main-account" */
  instanceLabel: string | null;
  type: string;
  category: 'decision' | 'execution' | 'risk' | 'system';
  severity: 'info' | 'warn' | 'critical';
  /** Translation key for client-side localization, e.g. "activity.order.filled" */
  messageKey: string;
  timestamp: string;
  /** Raw event payload — used as interpolation params for messageKey */
  detail: Record<string, unknown>;
}

export interface ActivityFeedResponse {
  events: ActivityEvent[];
  hasMore: boolean;
}

// ---------------------------------------------------------------------------
// Agent Activity (canonical observability contract)
// ---------------------------------------------------------------------------

export type AgentActivityCategory =
  | 'runtime'
  | 'decision'
  | 'tool'
  | 'tick'
  | 'message'
  | 'artifact'
  | 'risk'
  | 'system';

export type AgentActivitySeverity = 'info' | 'warn' | 'critical';

export type AgentActivityEventType =
  | 'runtime.started'
  | 'runtime.unhealthy'
  | 'runtime.recovered'
  | 'runtime.failed'
  | 'decision.accepted'
  | 'decision.rejected'
  | 'message.authored'
  | 'system.alert'
  | 'artifact.published';

export interface AgentActivityEntry {
  id: string;
  agentId: string;
  timestamp: string;
  category: AgentActivityCategory;
  severity: AgentActivitySeverity;
  eventType: AgentActivityEventType;
  title: string;
  summary: string;
  detail: Record<string, unknown>;
  sessionId: string | null;
  direction: string | null;
  processingStatus: string | null;
  correlationId: string | null;
  traceId: string | null;
  /** Present only in dashboard agent-activity responses */
  agentName?: string | null;
}

export interface AgentActivityFeedResponse {
  entries: AgentActivityEntry[];
  hasMore: boolean;
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

export interface Skill {
  id: string;
  authorId: string | null;
  sourceKind: 'system' | 'user';
  publicationStatus: 'draft' | 'private' | 'published' | 'delisted' | 'archived';
  hasStagedRevision: boolean;
  priceCents: number;
  likeCount: number;
  forkCount: number;
  popularityScore: number;
  trendingScore: number;
  isLikedByViewer: boolean;
  isSelectable: boolean;
  selectabilityReason: string;
  currentRevisionId: string | null;
  currentRevisionVersion: number | null;
  name: string;
  description: string;
  instructions: string;
  requiredTools: string[];
  contextRequirements: string[];
  requiredGuardrails: string[];
  capabilityFamilies: string[];
  suggestedTickIntervalMs: number | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface SkillMetrics {
  skillId: string;
  usage90d: number;
  likes90d: number;
  forks90d: number;
  usage30d: number;
  likes30d: number;
  forks30d: number;
  likeCount: number;
  forkCount: number;
  popularityScore: number;
  trendingScore: number;
  updatedAt: string;
}

export interface CreateSkillRequest {
  name: string;
  description: string;
  instructions: string;
  requiredTools?: string[];
  contextRequirements?: string[];
  requiredGuardrails?: string[];
  capabilityFamilies?: string[];
  suggestedTickIntervalMs?: number;
  tags?: string[];
  priceCents?: number;
  publicationStatus?: 'draft' | 'private' | 'published';
  changeSummary?: string;
}

export interface UpdateSkillRequest {
  name?: string;
  description?: string;
  instructions?: string;
  requiredTools?: string[];
  contextRequirements?: string[];
  requiredGuardrails?: string[];
  capabilityFamilies?: string[];
  suggestedTickIntervalMs?: number | null;
  tags?: string[];
  priceCents?: number;
  changeSummary?: string;
}

export interface UpdateSkillResponse extends Skill {
  stagedRevisionId?: string | null;
}

export const skills = {
  create: (payload: CreateSkillRequest) =>
    request<Skill>('/skills', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  list: (params?: {
    scope?: 'mine' | 'marketplace' | 'selectable' | 'admin';
    publicationStatus?: 'draft' | 'private' | 'published' | 'delisted' | 'archived';
    sort?: 'popular' | 'trending' | 'newest' | 'price_asc' | 'price_desc';
    priceMin?: number;
    priceMax?: number;
    likedByMe?: boolean;
    tag?: string;
  }) => {
    const qs = new URLSearchParams();
    if (params?.scope) qs.set('scope', params.scope);
    if (params?.publicationStatus) qs.set('publicationStatus', params.publicationStatus);
    if (params?.sort) qs.set('sort', params.sort);
    if (params?.priceMin !== undefined) qs.set('priceMin', String(params.priceMin));
    if (params?.priceMax !== undefined) qs.set('priceMax', String(params.priceMax));
    if (params?.likedByMe !== undefined) qs.set('likedByMe', String(params.likedByMe));
    if (params?.tag) qs.set('tag', params.tag);
    const query = qs.toString() ? `?${qs.toString()}` : '';
    return request<{ skills: Skill[] }>(`/skills${query}`);
  },
  listAdminIfAllowed: async () => {
    try {
      return await request<{ skills: Skill[] }>('/skills?scope=admin');
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) {
        return null;
      }
      throw error;
    }
  },
  publish: (id: string, payload?: { revisionId?: string }) =>
    request<Skill>(`/skills/${id}/publish`, {
      method: 'POST',
      body: JSON.stringify(payload ?? {}),
    }),
  update: (id: string, payload: UpdateSkillRequest) =>
    request<UpdateSkillResponse>(`/skills/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  fork: (id: string) =>
    request<Skill>(`/skills/${id}/fork`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  delist: (id: string) =>
    request<Skill>(`/skills/${id}/delist`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  like: (id: string) =>
    request<{ liked: boolean; likeCount: number }>(`/skills/${id}/like`, { method: 'POST', body: JSON.stringify({}) }),
  unlike: (id: string) =>
    request<{ liked: boolean; likeCount: number }>(`/skills/${id}/like`, { method: 'DELETE' }),
  metrics: (id: string) => request<SkillMetrics>(`/skills/${id}/metrics`),
};

export const dashboard = {
  overview: () => request<DashboardOverview>('/dashboard/overview'),
  activity: (params?: { limit?: number; before?: string; beforeId?: string }) => {
    const qs = new URLSearchParams();
    if (params?.limit) qs.set('limit', String(params.limit));
    if (params?.before) qs.set('before', params.before);
    if (params?.beforeId) qs.set('beforeId', params.beforeId);
    const query = qs.toString() ? `?${qs.toString()}` : '';
    return request<ActivityFeedResponse>(`/dashboard/activity${query}`);
  },
  agentActivity: (params?: { limit?: number; before?: string; beforeId?: string }) => {
    const qs = new URLSearchParams();
    if (params?.limit) qs.set('limit', String(params.limit));
    if (params?.before) qs.set('before', params.before);
    if (params?.beforeId) qs.set('beforeId', params.beforeId);
    const query = qs.toString() ? `?${qs.toString()}` : '';
    return request<AgentActivityFeedResponse>(`/dashboard/agent-activity${query}`);
  },
};

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

export interface Credential {
  id: string;
  venue: string;
  label: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
}

export const credentials = {
  list: () => request<{ credentials: Credential[] }>('/credentials'),
  create: (data: { provider: string; label: string; secrets: Record<string, string> }) =>
    request<Credential>('/credentials', {
      method: 'POST',
      body: JSON.stringify({ venue: data.provider, label: data.label, secrets: data.secrets }),
    }),
  delete: (id: string) => request<void>(`/credentials/${id}`, { method: 'DELETE' }),
};

// ---------------------------------------------------------------------------
// Venue accounts
// ---------------------------------------------------------------------------

export interface VenueProfile {
  venue: string;
  venueType: 'orderbook' | 'swap';
  availableSymbols: string[];
  supportedExecutionModes: ('paper' | 'shadow' | 'live')[];
  authenticated: boolean;
  probedAt: string;
}

export interface VenueAccount {
  id: string;
  venue: string;
  label: string;
  venueAccountRef: string | null;
  credentialId: string | null;
  userId: string;
  venueProfile: VenueProfile | null;
  createdAt: string;
  updatedAt: string;
}

export const venueAccounts = {
  list: () => request<{ venueAccounts: VenueAccount[] }>('/venue-accounts'),
  create: (data: { venue: string; label: string; venueAccountRef?: string; credentialId?: string }) =>
    request<VenueAccount>('/venue-accounts', { method: 'POST', body: JSON.stringify(data) }),
  delete: (id: string) => request<void>(`/venue-accounts/${id}`, { method: 'DELETE' }),
};

// ---------------------------------------------------------------------------
// Bots (formerly Trading Instances)
// ---------------------------------------------------------------------------

export interface Bot {
  id: string;
  status: 'stopped' | 'running' | 'crashed';
  venueAccountId: string;
  creatorType: string;
  creatorId: string;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  stoppedAt: string | null;
}

export interface BotSummary {
  id: string;
  status: 'stopped' | 'running' | 'crashed';
  venue: string;
  venueLabel: string;
  symbol: string;
  openPositionsCount: number;
  lastActivityAt: string | null;
  startedAt: string | null;
  createdAt: string;
}

export const bots = {
  list: () => request<{ bots: Bot[] }>('/bots'),
  get: (id: string) => request<Bot>(`/bots/${id}`),
  create: (data: {
    tradingBindingId: string;
    venue: string;
    symbol: string;
    config: Record<string, unknown>;
  }) => request<Bot>('/bots', { method: 'POST', body: JSON.stringify(data) }),
  updateConfig: (id: string, config: Record<string, unknown>) =>
    request<{ status: string; botId: string }>(`/bots/${id}/config`, { method: 'PATCH', body: JSON.stringify({ config }) }),
  positions: (id: string) => request<{ botId: string; positions: Position[] }>(`/bots/${id}/positions`),
  openPositions: (id: string) => request<{ botId: string; positions: Position[] }>(`/bots/${id}/positions/open`),
};

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

export interface Position {
  id: string;
  botId: string | null;
  actorType: string | null;
  actorId: string | null;
  venueAccountId: string;
  venue: string;
  symbol: string;
  side: 'long' | 'short' | 'flat';
  size: string;
  entryPrice: string;
  realizedPnl: string;
  markSource: string | null;
  openedAt: string;
  closedAt: string | null;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------

export interface JournalEvent {
  id: string;
  actorId: string | null;
  backtestRunId: string | null;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export const journal = {
  query: (params: { actorId?: string; backtestRunId?: string; type?: string; limit?: number; offset?: number }) => {
    const qs = new URLSearchParams();
    if (params.actorId) qs.set('actorId', params.actorId);
    if (params.backtestRunId) qs.set('backtestRunId', params.backtestRunId);
    if (params.type) qs.set('type', params.type);
    if (params.limit) qs.set('limit', String(params.limit));
    if (params.offset) qs.set('offset', String(params.offset));
    return request<{ events: JournalEvent[] }>(`/journal?${qs.toString()}`);
  },
};

// ---------------------------------------------------------------------------
// Billing
// ---------------------------------------------------------------------------

export interface BillingPlanPrice {
  id: string;
  interval: 'month' | 'year';
  displayLabel: string;
  amountCents: number | null;
}

export interface AvailablePlan {
  planId: string;
  prices: BillingPlanPrice[];
}

export interface BillingSubscriptionSummary {
  status: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: string | null;
  trialEnd: string | null;
}

export interface BillingSummary {
  planId: string;
  planLabel: string;
  billingInterval: string | null;
  planLimits: Record<string, unknown> | null;
  hasPaymentCustomer: boolean;
  provider: 'creem' | 'stripe' | 'mock';
  subscription: BillingSubscriptionSummary | null;
  availablePlans: AvailablePlan[];
}

export const billing = {
  summary: () => request<BillingSummary>('/billing/summary'),
  createCheckoutSession: (planId: string, priceId?: string) =>
    request<{ url: string; provider: string }>('/billing/checkout-session', {
      method: 'POST',
      body: JSON.stringify({ planId, priceId }),
    }),
  createPortalSession: () =>
    request<{ url: string }>('/billing/customer-portal', { method: 'POST' }),
  cancelSubscription: () =>
    request<{ success: boolean; cancelAtPeriodEnd: boolean }>('/billing/cancel-subscription', { method: 'POST' }),
  upgradeSubscription: (planId: string, priceId?: string) =>
    request<{ success: boolean; newPlanId: string; provider: string }>('/billing/upgrade-subscription', {
      method: 'POST',
      body: JSON.stringify({ planId, priceId }),
    }),
  usageSummary: () => request<UsageSummaryResponse>('/billing/usage-summary'),
  usageEvents: (filters: UsageEventFilters = {}) => {
    const params = new URLSearchParams();
    if (filters.limit != null) params.set('limit', String(filters.limit));
    if (filters.offset != null) params.set('offset', String(filters.offset));
    if (filters.meterKey) params.set('meterKey', filters.meterKey);
    if (filters.agentId) params.set('agentId', filters.agentId);
    if (filters.sessionId) params.set('sessionId', filters.sessionId);
    if (filters.periodId) params.set('periodId', filters.periodId);
    if (filters.from) params.set('from', filters.from);
    if (filters.to) params.set('to', filters.to);
    const qs = params.toString();
    return request<UsageEventsResponse>(`/billing/usage-events${qs ? `?${qs}` : ''}`);
  },
  usageBreakdown: (filters: UsageBreakdownFilters = {}) => {
    const params = new URLSearchParams();
    if (filters.periodId) params.set('periodId', filters.periodId);
    if (filters.from) params.set('from', filters.from);
    if (filters.to) params.set('to', filters.to);
    const qs = params.toString();
    return request<UsageBreakdownResponse>(`/billing/usage-breakdown${qs ? `?${qs}` : ''}`);
  },
  periods: () => request<UsagePeriodsResponse>('/billing/periods'),
  updateSpendCaps: (caps: { softCapCents?: number | null; hardCapCents?: number | null }) =>
    request<{ success: boolean; status: UsageBillingAccount['status'] }>('/billing/spend-caps', {
      method: 'POST',
      body: JSON.stringify(caps),
    }),
  createTopUpCheckoutSession: (packId: string) =>
    request<{ url: string; provider: string }>('/billing/top-up-checkout-session', {
      method: 'POST',
      body: JSON.stringify({ packId }),
    }),
};

export interface UsageBillingAccount {
  id: string;
  status: 'active' | 'soft_limited' | 'hard_limited' | 'suspended';
  currency: string;
  activePlanId: string;
}

export interface UsagePeriodSummary {
  id: string;
  periodStart: string;
  periodEnd: string;
  includedCreditMicrousd: number;
  usageChargeMicrousd: number;
  creditAppliedMicrousd: number;
  balanceMicrousd: number;
  softCapMicrousd: number | null;
  hardCapMicrousd: number | null;
}

export interface UsageWarning {
  thresholdPct: number;
  reached: boolean;
}

export interface UsageSummaryResponse {
  account: UsageBillingAccount | null;
  currentPeriod: UsagePeriodSummary | null;
  warnings: UsageWarning[];
  topUpsEnabled?: boolean;
  topUpPacks?: Array<{ provider: string; packId: string; cents: number }>;
  byMeter: Record<string, { quantity: number; chargeMicrousd: number }>;
}

export interface UsageEventRecord {
  id: string;
  occurredAt: string;
  meterKey: string;
  quantity: number;
  unit: string;
  chargeMicrousd: number;
  currency: string;
  provider: string | null;
  model: string | null;
  metadata: Record<string, unknown>;
  agent: { id: string; name: string } | null;
  session: { id: string; status: string | null } | null;
}

export interface UsageEventFilters {
  limit?: number;
  offset?: number;
  meterKey?: string;
  agentId?: string;
  sessionId?: string;
  periodId?: string;
  from?: string;
  to?: string;
}

export interface UsageEventsResponse {
  records: UsageEventRecord[];
  total: number;
  limit: number;
  offset: number;
}

export interface UsageBreakdownFilters {
  periodId?: string;
  from?: string;
  to?: string;
}

export interface UsageBreakdownResponse {
  byAgent: Array<{ agentId: string; agentName: string; quantity: number; chargeMicrousd: number }>;
  byMeter: Array<{ meterKey: string; quantity: number; chargeMicrousd: number }>;
  bySkill: Array<{ skillId: string; quantity: number }>;
}

export interface UsagePeriod {
  id: string;
  status: string;
  periodStart: string;
  periodEnd: string;
  usageChargeMicrousd: number;
  includedCreditMicrousd: number;
  balanceMicrousd: number;
}

export interface UsagePeriodsResponse {
  periods: UsagePeriod[];
}

// --- Agents ---

export interface Agent {
  id: string;
  userId: string;
  name: string;
  prompt: string;
  skillIds: string[];
  status: string;
  pauseState: Record<string, unknown> | null;
  toolPolicy: Record<string, unknown> | null;
  modelPolicy: Record<string, unknown> | null;
  provider: string | null;
  lightModel: string | null;
  heavyModel: string | null;
  costPreset: string | null;
  dailySpendBudgetUsd: number | null;
  dailyLlmTokenBudget: number | null;
  telegramChatId: string | null;
  executionMode: string | null;
  dailyTokenBudget: number | null;
  dailyLossLimit: string | null;
  maxBots: number | null;
  maxSlippageBps: number | null;
  maxOpenPositions: number | null;
  maxPositionSizePct: string | null;
  stopLossPct: string | null;
  stopLossCooldownMs: number | null;
  tickIntervalMs: number | null;
  capital: string | null;
  technical: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  activeSession?: { id: string; status: string; lastHeartbeatAt: string; startedAt: string } | null;
}

export interface AgentArtifact {
  id: string;
  agentId: string;
  sessionId: string;
  artifactType: string;
  contentType: string;
  summary: string;
  createdAt: string;
}

export interface AgentOutboundMessage {
  id: string;
  agentId: string;
  sessionId: string | null;
  authoredBy: 'agent' | 'platform';
  subject: string | null;
  body: string;
  contextRef: string | null;
  deliveryStatus: 'pending' | 'sent' | 'failed';
  emailDeliveryStatus:
    | 'feed_only'
    | 'email_sent'
    | 'email_skipped_policy'
    | 'email_skipped_not_configured'
    | 'email_skipped_no_verified_recipient'
    | 'email_failed_provider'
    | null;
  telegramMessageId: string | null;
  telegramChatId: string | null;
  deliveryError: string | null;
  emailMessageId: string | null;
  emailDeliveryError: string | null;
  createdAt: string;
}

export interface AgentCompiledPrompt {
  agentId: string;
  judgeSystem: string | null;
  scoutSystem: string | null;
  userContext: string | null;
  judgeUserContext: string | null;
}

export interface AgentPosition {
  id: string;
  symbol: string;
  venue: string;
  side: string;
  size: string;
  entryPrice: string;
  exitPrice: string | null;
  realizedPnl: string;
  status: 'open' | 'closed';
  openedAt: string;
  closedAt: string | null;
  holdMs: number | null;
}

export const agents = {
  list: () => request<Agent[]>('/agents'),
  get: (id: string) => request<Agent>(`/agents/${id}`),
  riskDefaults: () => request<{ dailyLossLimitDefaultRatio: number; maxOpenPositions: number; maxPositionSizePct: number; stopLossPct: number; stopLossCooldownMs: number }>('/agents/risk-defaults'),
  create: (data: {
    name: string;
    prompt: string;
    skillIds?: string[];
    toolPolicy?: Record<string, unknown>;
    modelPolicy?: Record<string, unknown>;
    provider?: string | null;
    lightModel?: string | null;
    heavyModel?: string | null;
    costPreset?: 'minimal' | 'standard' | 'premium' | 'custom' | null;
    dailySpendBudgetUsd?: number | null;
    executionMode?: string | null;
    telegramChatId?: string | null;
    dailyLlmTokenBudget?: number | null;
    dailyTokenBudget?: number | null;
    dailyLossLimit?: string | null;
    maxBots?: number | null;
    maxSlippageBps?: number | null;
    maxOpenPositions?: number | null;
    maxPositionSizePct?: number | null;
    stopLossPct?: number | null;
    stopLossCooldownMs?: number | null;
    tickIntervalMs?: number | null;
    capital?: string | null;
  }) =>
    request<Agent>('/agents', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: string, data: {
    name?: string;
    prompt?: string;
    skillIds?: string[];
    toolPolicy?: Record<string, unknown>;
    modelPolicy?: Record<string, unknown>;
    provider?: string | null;
    lightModel?: string | null;
    heavyModel?: string | null;
    costPreset?: 'minimal' | 'standard' | 'premium' | 'custom' | null;
    dailySpendBudgetUsd?: number | null;
    telegramChatId?: string | null;
    executionMode?: string | null;
    dailyLlmTokenBudget?: number | null;
    dailyTokenBudget?: number | null;
    dailyLossLimit?: string | null;
    maxBots?: number | null;
    maxSlippageBps?: number | null;
    maxOpenPositions?: number | null;
    maxPositionSizePct?: number | null;
    stopLossPct?: number | null;
    stopLossCooldownMs?: number | null;
    tickIntervalMs?: number | null;
    capital?: string | null;
  }) =>
    request<Agent>(`/agents/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  delete: (id: string) => request<void>(`/agents/${id}`, { method: 'DELETE' }),
  start: (id: string) =>
    request<{ status: string; sessionId: string }>(`/agents/${id}/start`, { method: 'POST' }),
  stop: (id: string) =>
    request<{ status: string }>(`/agents/${id}/stop`, { method: 'POST' }),
  pause: (id: string, reason: string) =>
    request<{ status: string }>(`/agents/${id}/pause`, { method: 'POST', body: JSON.stringify({ reason }) }),
  resume: (id: string) =>
    request<{ status: string }>(`/agents/${id}/resume`, { method: 'POST' }),
  activity: (id: string, limit?: number) =>
    request<unknown[]>(`/agents/${id}/activity${limit ? `?limit=${limit}` : ''}`),
  activityFeed: (id: string, params?: { limit?: number; before?: string }) => {
    const qs = new URLSearchParams();
    if (params?.limit) qs.set('limit', String(params.limit));
    if (params?.before) qs.set('before', params.before);
    const query = qs.toString() ? `?${qs.toString()}` : '';
    return request<AgentActivityFeedResponse>(`/agents/${id}/activity-feed${query}`);
  },
  artifacts: (id: string, limit?: number) =>
    request<AgentArtifact[]>(`/agents/${id}/artifacts${limit ? `?limit=${limit}` : ''}`),
  prompt: (id: string) => request<AgentCompiledPrompt>(`/agents/${id}/prompt`),
  sessions: (id: string) => request<unknown[]>(`/agents/${id}/sessions`),
  decisions: (id: string, limit?: number) =>
    request<unknown[]>(`/agents/${id}/decisions${limit ? `?limit=${limit}` : ''}`),
  messages: (id: string, limit?: number, authoredBy?: 'agent' | 'platform') =>
    request<AgentOutboundMessage[]>(`/agents/${id}/messages${buildQuery({ limit, authoredBy })}`),
  capabilityReadiness: (id: string, family?: string) =>
    family
      ? request<CapabilityReadiness>(`/agents/${id}/capabilities/${family}/readiness`)
      : request<{ agentId: string; capabilities: CapabilityReadiness[] }>(`/agents/${id}/capabilities/readiness`),
  tradingBindings: (id: string) =>
    request<{ agentId: string; family: 'trading'; bindings: TradingBindingSummary[] }>(`/agents/${id}/capabilities/trading/bindings`),
  tradingAction: (id: string, action: 'bind' | 'unbind', payload: { bindingId: string }) =>
    request<{ action: 'bind' | 'unbind'; agentId: string; bindingId: string; status: string }>(`/agents/${id}/capabilities/trading/actions/${action}`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  tradingPositions: (id: string, params?: { limit?: number; offset?: number }) => {
    const qs = new URLSearchParams();
    if (params?.limit !== undefined) qs.set('limit', String(params.limit));
    if (params?.offset !== undefined) qs.set('offset', String(params.offset));
    const query = qs.toString() ? `?${qs.toString()}` : '';
    return request<{ agentId: string; family: 'trading'; items: AgentPosition[]; limit: number; offset: number }>(`/agents/${id}/capabilities/trading/positions${query}`);
  },
};

// ---------------------------------------------------------------------------
// Platform: Connections
// ---------------------------------------------------------------------------

export interface Connection {
  id: string;
  userId: string;
  credentialId: string | null;
  provider: string;
  label: string;
  status: 'active' | 'revoked';
  meta: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export const connections = {
  list: () => request<{ connections: Connection[] }>('/connections'),
  get: (id: string) => request<Connection>(`/connections/${id}`),
  create: (data: { provider: string; label: string; credentialId?: string }) =>
    request<Connection>('/connections', { method: 'POST', body: JSON.stringify(data) }),
  revoke: (id: string) => request<void>(`/connections/${id}`, { method: 'DELETE' }),
};

export const providerCatalog = {
  get: () => request<ProviderCatalogResponse>('/providers/catalog'),
};

// ---------------------------------------------------------------------------
// Platform: Capability Grants
// ---------------------------------------------------------------------------

export interface TradingBindingReadiness {
  state: 'unconfigured' | 'provisioning' | 'ready' | 'degraded' | 'revoked';
  reasons: string[];
}

export interface TradingBindingSummary {
  bindingId: string;
  connectionId: string;
  provider: string;
  label: string;
  bindingRef: string | null;
  bindingProfile: Record<string, unknown> | null;
  sourceVenueAccountId: string | null;
  connectionStatus: 'active' | 'revoked';
  status?: string;
  grantStatus?: string;
  readiness?: TradingBindingReadiness;
  family: 'trading';
  createdAt?: string;
  updatedAt?: string;
  grantedAt?: string;
  revokedAt?: string | null;
}

export const capabilities = {
  tradingBindings: () => request<{ family: 'trading'; bindings: TradingBindingSummary[] }>('/capabilities/trading/bindings'),
};

// ---------------------------------------------------------------------------
// Setup: unified provider-link flow
// ---------------------------------------------------------------------------

export interface ProviderSetupResult {
  credential: { id: string; venue: string; label: string; createdAt: string };
  connection: { id: string; provider: string; label: string; status: string; credentialId: string; createdAt: string };
  venueAccount?: { id: string; venue: string; label: string; credentialId: string; createdAt: string };
  tradingBinding?: { id: string; connectionId: string; provider: string; label: string; sourceVenueAccountId: string; status: string; createdAt: string };
}

export const setup = {
  providerLink: (data: { provider: string; label: string; secrets: Record<string, string>; capability?: 'trading' }) =>
    request<ProviderSetupResult>('/setup/provider-link', { method: 'POST', body: JSON.stringify(data) }),
};

// ---------------------------------------------------------------------------
// Platform: Readiness
// ---------------------------------------------------------------------------

export interface CapabilityReadiness {
  family: string;
  state: 'unconfigured' | 'provisioning' | 'ready' | 'degraded' | 'revoked';
  bindingReadiness: 'unconfigured' | 'provisioning' | 'ready' | 'degraded' | 'revoked';
  agentEligibility: 'eligible' | 'ineligible';
  effectiveReady: boolean;
  bindingId?: string;
  reasons: string[];
  detail?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Platform: WebSocket event envelope
// ---------------------------------------------------------------------------

export interface PlatformEventEnvelope {
  id: string;
  timestamp: string;
  actorType: 'user' | 'agent' | 'platform';
  actorId: string;
  capabilityFamily?: string;
  bindingId?: string;
  eventType: string;
  payload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export interface AdminStatsResponse {
  version: string;
  postgres: 'ok' | 'timeout' | 'error';
  redis: 'ok' | 'timeout' | 'error';
  memory: { totalBytes: number; freeBytes: number; usedBytes: number };
  disk: { totalBytes: number; freeBytes: number; usedBytes: number } | null;
  counts: {
    users: number;
    bots: number;
    agents: number;
    runningSessions: number;
    runningContainers: number | null;
    failedWebhooks: number;
    newUsersLast24h: number;
    newAgentsLast24h: number;
  };
}

export interface AdminUserRow {
  id: string;
  email: string;
  displayName: string | null;
  planId: string;
  isAdmin: boolean;
  createdAt: string;
  botCount: number;
  agentCount: number;
}

export interface AdminWebhookRow {
  id: string;
  eventType: string;
  status: string;
  error: string | null;
  processedAt: string;
}

export interface AdminContainer {
  Id: string;
  Names: string[];
  Image: string;
  Status: string;
  State: string;
  Created: number;
}

export interface AdminSession {
  id: string;
  agentId: string;
  cpuPct: number | null;
  memoryBytes: number | null;
  status: string;
}

export interface AdminMarketDataOverview {
  discovery: {
    snapshotId: string;
    leaderWorkerId: string;
    capturedAt: string;
    networks: string[];
    tokenCount: number;
    pollIntervalMs: number;
    nextPollDueAt: string;
    sourceStats: Record<string, { ok: boolean; freshness: string; tokenCount: number; networkCounts: Record<string, number> }>;
  } | null;
  regimeSnapshots: Record<string, {
    benchmarkSymbol: string;
    evaluatedAt: string;
    freshness: { state: string; ageMs: number };
    pass: boolean;
    reasons: string[];
  } | null>;
  lastError: { source: string; benchmarkSymbol?: string; occurredAt: string } | null;
}

export interface AdminProviderCounters {
  success?: number;
  failure?: number;
  lastSuccessAt?: string | null;
  freshnessModeFresh?: number;
  freshnessModeCached?: number;
  rateLimitWaitCount?: number;
  rateLimitThrottleCount?: number;
}

export interface AdminProviderRequestClass {
  requestClass: string;
  requestsPerMinute: number;
  burstCapacity: number;
  maxWaitMs: number;
  cacheTtlMs: number;
  /** Per-request-class counters keyed as "provider:requestClass" in the worker. */
  counters: AdminProviderCounters;
}

export interface AdminProviderRow {
  name: string;
  configured: boolean;
  enabled: boolean;
  unwired: boolean;
  requestClasses: AdminProviderRequestClass[];
}

export const admin = {
  stats: () => request<AdminStatsResponse>('/admin/stats'),
  users: (params?: { limit?: number; offset?: number }) => {
    const qs = new URLSearchParams();
    if (params?.limit !== undefined) qs.set('limit', String(params.limit));
    if (params?.offset !== undefined) qs.set('offset', String(params.offset));
    const query = qs.toString() ? `?${qs.toString()}` : '';
    return request<{ users: AdminUserRow[]; total: number; limit: number; offset: number }>(`/admin/users${query}`);
  },
  containers: () => request<{ containers: AdminContainer[] | null; sessions: AdminSession[]; error?: string }>('/admin/containers'),
  promoteUser: (id: string) => request<{ user: { id: string; email: string; isAdmin: boolean } }>(`/admin/users/${id}/promote`, { method: 'POST' }),
  revokeAdmin: (id: string) => request<{ user: { id: string; email: string; isAdmin: boolean } }>(`/admin/users/${id}/admin`, { method: 'DELETE' }),
  webhooks: (params?: { limit?: number; offset?: number }) => {
    const qs = new URLSearchParams();
    if (params?.limit !== undefined) qs.set('limit', String(params.limit));
    if (params?.offset !== undefined) qs.set('offset', String(params.offset));
    const query = qs.toString() ? `?${qs.toString()}` : '';
    return request<{ webhooks: AdminWebhookRow[]; total: number; limit: number; offset: number }>(`/admin/billing/webhooks${query}`);
  },
  marketDataOverview: () => request<AdminMarketDataOverview>('/admin/market-data/overview'),
  marketDataProviders: () => request<{ providers: AdminProviderRow[] }>('/admin/market-data/providers'),
};
