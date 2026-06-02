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
    'Content-Type': 'application/json',
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

export interface MeResponse {
  id: string;
  displayName: string;
  email: string;
  avatarUrl: string | null;
  planId: string;
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
  logout: () => request<{ ok: boolean }>('/auth/logout', { method: 'POST' }),
};

// ---------------------------------------------------------------------------
// Dashboard composite read models
// ---------------------------------------------------------------------------

export interface InstanceSummary {
  id: string;
  status: 'stopped' | 'running' | 'crashed';
  strategyId: string;
  venue: string;
  venueLabel: string;
  symbol: string;
  openPositionsCount: number;
  lastActivityAt: string | null;
  startedAt: string | null;
  createdAt: string;
}

export interface DashboardOverview {
  user: { id: string; displayName: string; email: string; avatarUrl: string | null; planId: string };
  plan: {
    maxTradingInstances: number;
    maxPortfolios: number;
    maxVenueAccounts: number;
    maxCredentials: number;
    maxConcurrentBacktests: number;
    liveEnabled: boolean;
  } | null;
  instances: InstanceSummary[];
  summary: { totalInstances: number; runningInstances: number; totalOpenPositions: number };
}

export interface ActivityEvent {
  id: string;
  tradingInstanceId: string | null;
  instanceLabel: string | null;
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
// Portfolios
// ---------------------------------------------------------------------------

export interface Portfolio {
  id: string;
  name: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
}

export const portfolios = {
  list: () => request<{ portfolios: Portfolio[] }>('/portfolios'),
  create: (name: string) => request<Portfolio>('/portfolios', { method: 'POST', body: JSON.stringify({ name }) }),
  delete: (id: string) => request<void>(`/portfolios/${id}`, { method: 'DELETE' }),
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

export interface VenueAccount {
  id: string;
  venue: string;
  label: string;
  venueAccountRef: string | null;
  credentialId: string | null;
  userId: string;
  createdAt: string;
  updatedAt: string;
}

export const venueAccounts = {
  list: () => request<{ venueAccounts: VenueAccount[] }>('/venue-accounts'),
  create: (data: { venue: string; label: string; venueAccountRef?: string; credentialId?: string }) =>
    request<VenueAccount>('/venue-accounts', { method: 'POST', body: JSON.stringify(data) }),
};

// ---------------------------------------------------------------------------
// Trading instances
// ---------------------------------------------------------------------------

export interface TradingInstance {
  id: string;
  status: 'stopped' | 'running' | 'crashed';
  strategyId: string;
  portfolioId: string;
  venueAccountId: string;
  config: Record<string, unknown>;
  configVersion: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  stoppedAt: string | null;
}

export const instances = {
  list: () => request<{ instances: TradingInstance[] }>('/instances'),
  get: (id: string) => request<TradingInstance>(`/instances/${id}`),
  create: (data: {
    portfolioId: string;
    venueAccountId: string;
    strategyId: string;
    venue: string;
    symbol: string;
    config: Record<string, unknown>;
  }) => request<TradingInstance>('/instances', { method: 'POST', body: JSON.stringify(data) }),
  start: (id: string) => request<{ status: string; tradingInstanceId: string }>(`/instances/${id}/start`, { method: 'POST' }),
  stop: (id: string) => request<{ status: string; tradingInstanceId: string }>(`/instances/${id}/stop`, { method: 'POST' }),
  updateConfig: (id: string, config: Record<string, unknown>) =>
    request<{ status: string; tradingInstanceId: string; configVersion: number }>(`/instances/${id}/config`, { method: 'PATCH', body: JSON.stringify({ config }) }),
  positions: (id: string) => request<{ tradingInstanceId: string; positions: Position[] }>(`/instances/${id}/positions`),
  openPositions: (id: string) => request<{ tradingInstanceId: string; positions: Position[] }>(`/instances/${id}/positions/open`),
  liveStatus: (id: string) => request<LiveStatus>(`/instances/${id}/live-status`),
};

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

export interface Position {
  id: string;
  tradingInstanceId: string;
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
  tradingInstanceId: string;
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
  tradingInstanceId: string | null;
  backtestRunId: string | null;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export const journal = {
  query: (params: { tradingInstanceId?: string; backtestRunId?: string; type?: string; limit?: number; offset?: number }) => {
    const qs = new URLSearchParams();
    if (params.tradingInstanceId) qs.set('tradingInstanceId', params.tradingInstanceId);
    if (params.backtestRunId) qs.set('backtestRunId', params.backtestRunId);
    if (params.type) qs.set('type', params.type);
    if (params.limit) qs.set('limit', String(params.limit));
    if (params.offset) qs.set('offset', String(params.offset));
    return request<{ events: JournalEvent[] }>(`/journal?${qs.toString()}`);
  },
};
