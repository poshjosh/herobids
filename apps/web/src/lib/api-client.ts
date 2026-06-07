import { config } from './config.js';
import { getToken, clearToken } from './session.js';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
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
    clearToken();
    // Soft redirect to login — avoid hard reload when the router handles this
    window.location.href = '/login';
    throw new ApiError(401, 'unauthorized', 'Session expired');
  }

  if (!res.ok) {
    let code = 'api_error';
    let message = `HTTP ${res.status}`;
    try {
      const body = await res.json() as { error?: string; message?: string; details?: Array<{ message?: string }> };
      code = body.error ?? code;
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
    throw new ApiError(res.status, code, message);
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
  telegramChatId: string | null;
  createdAt: string;
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
  updateMe: (data: { telegramChatId?: string | null }) =>
    request<MeResponse>('/auth/me', { method: 'PATCH', body: JSON.stringify(data) }),
  logout: () => request<{ ok: boolean }>('/auth/logout', { method: 'POST' }),
};

// ---------------------------------------------------------------------------
// Dashboard composite read models
// ---------------------------------------------------------------------------

export interface DashboardOverview {
  user: { id: string; displayName: string; email: string; avatarUrl: string | null; planId: string };
  plan: {
    maxBots: number;
    maxVenueAccounts: number;
    maxCredentials: number;
    maxConcurrentBacktests: number;
    liveEnabled: boolean;
  } | null;
  bots: BotSummary[];
  summary: { totalBots: number; runningBots: number; totalOpenPositions: number };
}

export interface ActivityEvent {
  id: string;
  botId: string | null;
  actorId: string | null;
  type: string;
  category: 'decision' | 'execution' | 'risk' | 'system';
  severity: 'info' | 'warn' | 'critical';
  message: string;
  timestamp: string;
  detail: Record<string, unknown>;
}

export interface ActivityFeedResponse {
  events: ActivityEvent[];
  hasMore: boolean;
}

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
  create: (data: { venue: string; label: string; secrets: Record<string, string> }) =>
    request<Credential>('/credentials', { method: 'POST', body: JSON.stringify(data) }),
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
    venueAccountId: string;
    venue: string;
    symbol: string;
    config: Record<string, unknown>;
  }) => request<Bot>('/bots', { method: 'POST', body: JSON.stringify(data) }),
  start: (id: string) => request<{ status: string; botId: string }>(`/bots/${id}/start`, { method: 'POST' }),
  stop: (id: string) => request<{ status: string; botId: string }>(`/bots/${id}/stop`, { method: 'POST' }),
  updateConfig: (id: string, config: Record<string, unknown>) =>
    request<{ status: string; botId: string }>(`/bots/${id}/config`, { method: 'PATCH', body: JSON.stringify({ config }) }),
  positions: (id: string) => request<{ botId: string; positions: Position[] }>(`/bots/${id}/positions`),
  openPositions: (id: string) => request<{ botId: string; positions: Position[] }>(`/bots/${id}/positions/open`),
  liveStatus: (id: string) => request<LiveStatus>(`/bots/${id}/live-status`),
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
// Live status
// ---------------------------------------------------------------------------

export interface LiveStatus {
  botId: string;
  executionMode: string;
  status: string;
  startedAt: string | null;
  lastReconciliation: { result: string; timestamp: string; diffCount: number } | null;
  openOrders: unknown[];
  recentFills: unknown[];
  slippageAlerts: unknown[];
  recentLiveEvents: unknown[];
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
};

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
  telegramChatId: string | null;
  executionMode: string | null;
  dailyTokenBudget: number | null;
  dailyLossLimit: string | null;
  maxBots: number | null;
  maxSlippageBps: number | null;
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

export interface AgentDecision {
  id: string;
  intent: string;
  instrumentId: string;
  targetSize: string;
  limitPrice: string | null;
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
  telegramMessageId: string | null;
  telegramChatId: string | null;
  deliveryError: string | null;
  createdAt: string;
}

export const agents = {
  list: () => request<Agent[]>('/agents'),
  get: (id: string) => request<Agent>(`/agents/${id}`),
  create: (data: { name: string; prompt: string; skillIds?: string[]; toolPolicy?: Record<string, unknown>; modelPolicy?: Record<string, unknown> }) =>
    request<Agent>('/agents', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: string, data: {
    name?: string;
    prompt?: string;
    skillIds?: string[];
    toolPolicy?: Record<string, unknown>;
    modelPolicy?: Record<string, unknown>;
    telegramChatId?: string | null;
    executionMode?: string | null;
    dailyTokenBudget?: number | null;
    dailyLossLimit?: string | null;
    maxBots?: number | null;
    maxSlippageBps?: number | null;
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
  artifacts: (id: string, limit?: number) =>
    request<AgentArtifact[]>(`/agents/${id}/artifacts${limit ? `?limit=${limit}` : ''}`),
  decisions: (id: string, limit?: number) =>
    request<AgentDecision[]>(`/agents/${id}/decisions${limit ? `?limit=${limit}` : ''}`),
  sessions: (id: string) => request<unknown[]>(`/agents/${id}/sessions`),
  messages: (id: string, limit?: number, authoredBy?: 'agent' | 'platform') =>
    request<AgentOutboundMessage[]>(`/agents/${id}/messages${buildQuery({ limit, authoredBy })}`),
  grants: (id: string) => request<{ grants: CapabilityGrant[] }>(`/agents/${id}/grants`),
  createGrant: (id: string, data: { connectionId: string; capabilityFamily: string }) =>
    request<CapabilityGrant>(`/agents/${id}/grants`, { method: 'POST', body: JSON.stringify(data) }),
  revokeGrant: (id: string, grantId: string, reason?: string) =>
    request<void>(`/agents/${id}/grants/${grantId}`, { method: 'DELETE', body: JSON.stringify({ reason }) }),
  grantAudit: (id: string, grantId: string) =>
    request<{ audit: GrantAuditEntry[] }>(`/agents/${id}/grants/${grantId}/audit`),
  capabilityReadiness: (id: string, family?: string) =>
    family
      ? request<CapabilityReadiness>(`/agents/${id}/capabilities/${family}/readiness`)
      : request<{ agentId: string; capabilities: CapabilityReadiness[] }>(`/agents/${id}/capabilities/readiness`),
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

// ---------------------------------------------------------------------------
// Platform: Capability Grants
// ---------------------------------------------------------------------------

export interface CapabilityGrant {
  id: string;
  agentId: string;
  connectionId: string;
  capabilityFamily: string;
  status: 'active' | 'revoked';
  grantedBy: string;
  grantedAt: string;
  revokedAt: string | null;
  meta: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface GrantAuditEntry {
  id: string;
  grantId: string;
  action: string;
  actorType: 'user' | 'agent' | 'platform';
  actorId: string;
  reason: string | null;
  detail: Record<string, unknown> | null;
  createdAt: string;
}

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
