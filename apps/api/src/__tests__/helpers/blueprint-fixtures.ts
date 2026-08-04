import type { AgentBlueprintRevisionPayload, BotBlueprintRevisionPayload } from '@herobids/domain';

// ── Default IDs ──────────────────────────────────────────────────────────────

export const BP_ID = 'bp-test-1';
export const REV_ID = 'rev-test-1';
export const USER_ID = 'user-test-1';
export const OTHER_USER_ID = 'user-test-2';

// ── Timestamp helpers ────────────────────────────────────────────────────────

const NOW = new Date('2026-08-04T00:00:00.000Z');
const YESTERDAY = new Date('2026-08-03T00:00:00.000Z');

export function testDate(daysOffset = 0): Date {
  const d = new Date(NOW);
  d.setDate(d.getDate() + daysOffset);
  return d;
}

// ── Agent payload builder ───────────────────────────────────────────────────

export function buildAgentPayload(overrides: Partial<AgentBlueprintRevisionPayload> = {}): AgentBlueprintRevisionPayload {
  // Cast through unknown: Zod .default() types are deeply nested and require
  // all sub-fields in the TS output type even though defaults fill them at
  // parse time. The fixture only needs to produce runtime-valid data for
  // BlueprintDetailSchema.parse().
  return {
    kind: 'agent' as const,
    name: 'Test Agent Blueprint',
    description: 'A test agent blueprint for unit tests',
    tags: ['test', 'momentum'],
    prompt: 'You are a helpful trading agent.',
    style: 'balanced',
    strategy: {
      type: 'momentum' as const,
      decisionMode: 'mechanical' as const,
      params: {
        stopLossPct: 5,
        takeProfitPct: 10,
        positionSize: '100',
      },
    },
    risk: null,
    executionDefaults: { mode: 'paper' as const },
    technical: {
      filters: { venue: 'hyperliquid', venueType: 'orderbook' as const, quoteAssetSymbol: 'USDC' },
    },
    intelligence: undefined,
    capabilityMode: 'hybrid' as const,
    executionPolicy: undefined,
    runtimePolicyOverrides: undefined,
    toolPolicy: undefined,
    modelPolicy: undefined,
    allowedPresets: undefined,
    presetTransition: undefined,
    platformAssessment: undefined,
    authorizationMode: null,
    wakePreferences: undefined,
    openPositionEscalationToJudgePolicy: 'never' as const,
    capital: null,
    maxBots: null,
    tickIntervalMs: null,
    ...overrides,
  } as AgentBlueprintRevisionPayload;
}

// ── Bot payload builder ─────────────────────────────────────────────────────

export function buildBotPayload(overrides: Partial<BotBlueprintRevisionPayload> = {}): BotBlueprintRevisionPayload {
  return {
    kind: 'bot',
    name: 'Test Bot Blueprint',
    description: 'A test bot blueprint for unit tests',
    tags: ['test'],
    strategy: { type: 'momentum', decisionMode: 'mechanical' },
    risk: {},
    executionDefaults: { mode: 'paper' },
    venue: 'hyperliquid',
    venueType: 'orderbook',
    symbol: 'BTC-PERP',
    shadowPollIntervalMs: 5000,
    ...overrides,
  };
}

// ── Blueprint row builder ───────────────────────────────────────────────────

export interface BlueprintRowOverrides {
  id?: string;
  authorId?: string;
  createdAt?: Date;
  updatedAt?: Date;
  publicationStatus?: string;
  publishedAt?: Date | null;
  delistedAt?: Date | null;
  archivedAt?: Date | null;
  currentRevisionId?: string | null;
  publishedRevisionId?: string | null;
  kind?: string;
  name?: string;
  description?: string;
  strategyType?: string | null;
  style?: string | null;
  tags?: string[];
  venueType?: string | null;
  sourceBlueprintId?: string | null;
  sourceBlueprintRevisionId?: string | null;
  likeCount?: number;
  forkCount?: number;
  popularityScore?: number;
  trendingScore?: number;
}

export function buildBlueprint(overrides: BlueprintRowOverrides = {}) {
  const pubStatus = overrides.publicationStatus ?? 'draft';
  const isPublished = pubStatus === 'published';
  return {
    id: overrides.id ?? BP_ID,
    authorId: overrides.authorId ?? USER_ID,
    createdAt: overrides.createdAt ?? YESTERDAY,
    updatedAt: overrides.updatedAt ?? NOW,
    publicationStatus: pubStatus,
    publishedAt: overrides.publishedAt ?? (isPublished ? YESTERDAY : null),
    delistedAt: overrides.delistedAt ?? (pubStatus === 'delisted' ? NOW : null),
    archivedAt: overrides.archivedAt ?? (pubStatus === 'archived' ? NOW : null),
    currentRevisionId: overrides.currentRevisionId ?? REV_ID,
    publishedRevisionId: overrides.publishedRevisionId ?? (isPublished ? REV_ID : null),
    kind: overrides.kind ?? 'agent',
    name: overrides.name ?? 'Test Blueprint',
    description: overrides.description ?? 'A test blueprint',
    strategyType: overrides.strategyType ?? 'momentum',
    style: overrides.style ?? 'balanced',
    tags: overrides.tags ?? ['test'],
    venueType: overrides.venueType ?? null,
    sourceBlueprintId: overrides.sourceBlueprintId ?? null,
    sourceBlueprintRevisionId: overrides.sourceBlueprintRevisionId ?? null,
    likeCount: overrides.likeCount ?? 0,
    forkCount: overrides.forkCount ?? 0,
    popularityScore: overrides.popularityScore ?? 0,
    trendingScore: overrides.trendingScore ?? 0,
  };
}

/** A published blueprint ready for marketplace browse. */
export function buildPublishedBlueprint(overrides: BlueprintRowOverrides = {}) {
  return buildBlueprint({ publicationStatus: 'published', publishedRevisionId: REV_ID, publishedAt: YESTERDAY, ...overrides });
}

/** A draft blueprint (default). */
export function buildDraftBlueprint(overrides: BlueprintRowOverrides = {}) {
  return buildBlueprint({ publicationStatus: 'draft', publishedRevisionId: null, publishedAt: null, ...overrides });
}

// ── Revision row builder ────────────────────────────────────────────────────

export interface RevisionRowOverrides {
  id?: string;
  blueprintId?: string;
  version?: number;
  kind?: string;
  name?: string;
  description?: string;
  strategyType?: string | null;
  style?: string | null;
  tags?: string[];
  venueType?: string | null;
  payload?: Record<string, unknown>;
  changeSummary?: string | null;
  createdByUserId?: string;
  createdAt?: Date;
}

export function buildRevision(overrides: RevisionRowOverrides = {}) {
  return {
    id: overrides.id ?? REV_ID,
    blueprintId: overrides.blueprintId ?? BP_ID,
    version: overrides.version ?? 1,
    kind: overrides.kind ?? 'agent',
    name: overrides.name ?? 'Test Blueprint',
    description: overrides.description ?? 'A test blueprint',
    strategyType: overrides.strategyType ?? 'momentum',
    style: overrides.style ?? 'balanced',
    tags: overrides.tags ?? ['test'],
    venueType: overrides.venueType ?? null,
    payload: overrides.payload ?? buildAgentPayload(),
    changeSummary: overrides.changeSummary ?? null,
    createdByUserId: overrides.createdByUserId ?? USER_ID,
    createdAt: overrides.createdAt ?? YESTERDAY,
  };
}

// ── Revision-skills row builder ─────────────────────────────────────────────

export interface RevisionSkillRow {
  blueprintRevisionId: string;
  skillId: string;
  skillRevisionId: string;
  orderIndex: number;
}

export function buildRevisionSkill(overrides: Partial<RevisionSkillRow> = {}): RevisionSkillRow {
  return {
    blueprintRevisionId: overrides.blueprintRevisionId ?? REV_ID,
    skillId: overrides.skillId ?? 'skill-1',
    skillRevisionId: overrides.skillRevisionId ?? 'skill-rev-1',
    orderIndex: overrides.orderIndex ?? 0,
  };
}

// ── Like row builder ────────────────────────────────────────────────────────

export interface LikeRow {
  blueprintId: string;
  userId: string;
}

export function buildLike(overrides: Partial<LikeRow> = {}): LikeRow {
  return {
    blueprintId: overrides.blueprintId ?? BP_ID,
    userId: overrides.userId ?? USER_ID,
  };
}
