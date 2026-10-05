import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { messages } from '../../app/i18n/locales/en.js';
import type { Agent, CapabilityReadiness, Skill } from '../../lib/api-client.js';

// The detail page pulls in a session, an event stream, and heavy child panels.
// Mock the boundaries so the test can focus on the generic capabilities list.
vi.mock('../../lib/api-client.js', () => ({
  ApiError: class ApiError extends Error {},
  agents: {
    get: vi.fn(),
    capabilityReadiness: vi.fn(),
    activityFeed: vi.fn(),
    prompt: vi.fn(),
    messages: vi.fn(),
    artifacts: vi.fn(),
    sessions: vi.fn(),
    getArtifactDownloadUrl: vi.fn(() => ''),
    // The inline capability-setup block seeds its selection from these.
    tradingConnections: vi.fn(),
    getConnections: vi.fn(),
    update: vi.fn(),
  },
  skills: {
    list: vi.fn(),
  },
  // AgentConnectionField (the inline connection picker) reads these.
  capabilities: {
    tradingConnections: vi.fn(),
  },
  connections: {
    list: vi.fn(),
  },
  providerCatalog: {
    get: vi.fn(),
  },
}));

vi.mock('../../app/providers/SessionProvider.js', () => ({
  useSession: () => ({
    user: { isAdmin: false, planEntitlements: { agents: { canViewOwnPrompts: true } } },
    loading: false,
    authenticated: true,
    login: vi.fn(),
    logout: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock('../../lib/useEventStream.js', () => ({
  useEventStream: () => undefined,
}));

vi.mock('./AgentEvaluations.js', () => ({
  AgentEvaluations: () => <div>evaluations</div>,
}));

vi.mock('./AgentActivityTimeline.js', () => ({
  AgentActivityTimeline: () => <div>timeline</div>,
}));

import { AgentDetailPage } from './AgentDetailPage.js';

function makeAgent(skillIds: string[]): Agent {
  return {
    id: 'agent-1',
    userId: 'user-1',
    name: 'Test agent',
    prompt: 'Do the thing.',
    skillIds,
    status: 'stopped',
    pauseState: null,
    toolPolicy: null,
    modelPolicy: null,
    provider: null,
    lightModel: null,
    heavyModel: null,
    costPreset: null,
    dailySpendBudgetUsd: null,
    dailyLlmTokenBudget: null,
    risk: null,
    strategy: null,
    executionDefaults: null,
    telegramChatId: null,
    executionMode: null,
    dailyLossLimit: null,
    maxDrawdownPct: null,
    maxBots: null,
    maxSlippageBps: null,
    maxOpenPositions: null,
    maxPositionSizePct: null,
    stopLossPct: null,
    stopLossCooldownMs: null,
    tickIntervalMs: null,
    capital: null,
    style: null,
    runtimePolicyOverrides: null,
    resolvedRuntimePolicy: null,
    openPositionEscalationToJudgePolicy: null,
    technical: null,
    strategyPreset: null,
    strategyPresetName: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  } as Agent;
}

function makeSkill(id: string, families: string[]): Skill {
  return {
    id,
    slug: id,
    authorId: null,
    sourceKind: 'system',
    publicationStatus: 'published',
    hasStagedRevision: false,
    priceCents: 0,
    likeCount: 0,
    forkCount: 0,
    popularityScore: 0,
    trendingScore: 0,
    isLikedByViewer: false,
    isSelectable: true,
    selectabilityReason: '',
    isBackendApproved: false,
    currentRevisionId: null,
    currentRevisionVersion: null,
    name: id,
    description: '',
    instructions: '',
    promptHint: null,
    promptTemplate: null,
    requiredTools: [],
    contextRequirements: [],
    requiredGuardrails: [],
    capabilityFamilies: families,
    suggestedTickIntervalMs: null,
    tags: [],
    dependsOn: [],
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
}

function makeReadiness(family: string): CapabilityReadiness {
  return {
    family,
    state: 'ready',
    connectionReadiness: 'ready',
    agentEligibility: 'eligible',
    effectiveReady: true,
    connectionId: 'conn-1',
    reasons: [],
  };
}

const ALL_SKILLS: Skill[] = [
  makeSkill('traderton/skills/crypto-trading', ['trading']),
  makeSkill('email', ['email']),
  makeSkill('task-management', []),
];

function renderDetail(opts: {
  agentSkillIds: string[];
  readinessFamilies: string[];
}): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  queryClient.setQueryData(['agents', 'agent-1'], makeAgent(opts.agentSkillIds));
  queryClient.setQueryData(['skills'], { skills: ALL_SKILLS });
  queryClient.setQueryData(['agents', 'agent-1', 'capability-readiness'], {
    agentId: 'agent-1',
    capabilities: opts.readinessFamilies.map(makeReadiness),
  });
  // Non-capability panels — seed empties so their queries resolve from cache.
  queryClient.setQueryData(['agents', 'agent-1', 'activity-feed'], { entries: [], hasMore: false });
  queryClient.setQueryData(['agents', 'agent-1', 'prompt'], null);
  queryClient.setQueryData(['agents', 'agent-1', 'messages'], []);
  queryClient.setQueryData(['agents', 'agent-1', 'artifacts'], []);
  queryClient.setQueryData(['agents', 'agent-1', 'sessions'], []);
  // Inline capability-setup block + AgentConnectionField queries. Seeding them
  // lets the connection picker render its options from cache during the sync
  // static render (an unseeded query would render the "loading" branch, and its
  // queryFn is never invoked by renderToStaticMarkup).
  queryClient.setQueryData(['agents', 'agent-1', 'capabilities', 'trading', 'connections'], {
    agentId: 'agent-1',
    family: 'trading',
    connections: [],
  });
  queryClient.setQueryData(['agents', 'agent-1', 'connections'], { agentId: 'agent-1', connections: [] });
  queryClient.setQueryData(['capabilities', 'trading', 'connections'], { family: 'trading', connections: [] });
  // Provider catalog is intentionally left unseeded so the picker uses the
  // hardcoded VENUE_TYPE_MAP fallback (hyperliquid → trading optgroup).
  queryClient.setQueryData(['connections'], {
    connections: [
      {
        id: 'conn-trading-1',
        userId: 'user-1',
        credentialId: null,
        provider: 'hyperliquid',
        label: 'My Hyperliquid',
        status: 'active',
        meta: null,
        profile: null,
        resolvedVenueAccountId: 'va-1',
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
        assignedAgentCount: 0,
        referencingBotCount: 0,
        venueAccountRef: '0xabc',
      },
      {
        id: 'conn-gmail-1',
        userId: 'user-1',
        credentialId: null,
        provider: 'gmail',
        label: 'My Gmail',
        status: 'active',
        meta: null,
        profile: null,
        resolvedVenueAccountId: null,
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
        assignedAgentCount: 0,
        referencingBotCount: 0,
        venueAccountRef: null,
      },
    ],
  });

  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" messages={messages}>
        <MemoryRouter initialEntries={['/agents/agent-1']}>
          <Routes>
            <Route path="/agents/:id" element={<AgentDetailPage />} />
          </Routes>
        </MemoryRouter>
      </IntlProvider>
    </QueryClientProvider>,
  );
}

/**
 * Each rendered family card carries an `aria-label` of the form
 * "{capability} capability readiness". Extract the family labels in render order.
 */
function renderedFamilyLabels(html: string): string[] {
  const families: string[] = [];
  const re = /aria-label="([^"]+?) capability readiness"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    families.push(match[1]!.trim());
  }
  return families;
}

describe('AgentDetailPage capabilities list', () => {
  it('renders a single Trading card for a trading-only agent', () => {
    const html = renderDetail({ agentSkillIds: ['traderton/skills/crypto-trading'], readinessFamilies: ['trading'] });
    const labels = renderedFamilyLabels(html);
    expect(labels).toEqual(['Trading']);
    expect(html).not.toContain(messages['agents.summary.noCapabilitySetup']);
  });

  it('renders both Trading and Email cards for a trading+email agent', () => {
    const html = renderDetail({
      agentSkillIds: ['traderton/skills/crypto-trading', 'email'],
      readinessFamilies: ['email', 'trading'],
    });
    const labels = renderedFamilyLabels(html);
    // resolveCapabilityFamilies sorts families alphabetically → email before trading.
    expect(labels).toEqual(['Email', 'Trading']);
  });

  it('renders only the Email card for an email-only agent (no "no capabilities")', () => {
    const html = renderDetail({ agentSkillIds: ['email'], readinessFamilies: ['email'] });
    const labels = renderedFamilyLabels(html);
    expect(labels).toEqual(['Email']);
    expect(html).not.toContain(messages['agents.detail.capabilities.emptyTitle']);
  });

  it('shows the empty state only when the agent has zero capability families', () => {
    const html = renderDetail({ agentSkillIds: ['task-management'], readinessFamilies: [] });
    const labels = renderedFamilyLabels(html);
    expect(labels).toEqual([]);
    expect(html).toContain(messages['agents.detail.capabilities.emptyTitle']);
  });

  it('replaces the old "No capability setup required" dead-end with the new empty title and explainer', () => {
    const html = renderDetail({ agentSkillIds: ['task-management'], readinessFamilies: [] });
    expect(html).toContain(messages['agents.detail.capabilities.emptyTitle']);
    expect(html).toContain(messages['agents.detail.capabilities.emptyBody']);
    expect(html).not.toContain('No capability setup required');
  });

  it('renders the inline Add-skills and Connections setup controls in the empty state', () => {
    const html = renderDetail({ agentSkillIds: ['task-management'], readinessFamilies: [] });
    expect(html).toContain(messages['agents.detail.capabilities.addSkills']);
    expect(html).toContain(messages['agents.create.connections']);
    expect(html).not.toContain('>Connections<');
  });

  it('renders the inline Add-skills and Connections setup controls alongside existing capability cards', () => {
    const html = renderDetail({ agentSkillIds: ['traderton/skills/crypto-trading'], readinessFamilies: ['trading'] });
    expect(renderedFamilyLabels(html)).toEqual(['Trading']);
    expect(html).toContain(messages['agents.detail.capabilities.addSkills']);
    expect(html).toContain(messages['agents.create.connections']);
  });

  it('offers assignable connections from the account picker in the inline setup block', () => {
    const html = renderDetail({ agentSkillIds: ['task-management'], readinessFamilies: [] });
    // The merged picker lists both a trading connection and a non-trading one.
    expect(html).toContain('My Hyperliquid (hyperliquid)');
    expect(html).toContain('My Gmail (gmail)');
    // Trading / other optgroups come from the shared connection picker.
    expect(html).toContain(messages['agents.create.connections.trading']);
    expect(html).toContain(messages['agents.create.connections.other']);
  });
});
