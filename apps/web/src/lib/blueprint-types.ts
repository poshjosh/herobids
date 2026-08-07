/**
 * Blueprint marketplace type definitions for the web frontend.
 * Mirrors domain schemas from @herobids/domain (BlueprintSummarySchema, etc.).
 */

export interface BlueprintSummary {
  id: string;
  authorId: string;
  publicationStatus: 'draft' | 'private' | 'published' | 'delisted' | 'archived';
  kind: 'agent' | 'bot';
  name: string;
  description: string;
  tags: string[];
  strategyType: string | null;
  style: 'careful' | 'balanced' | 'bold' | null;
  venueType: string | null;
  likeCount: number;
  forkCount: number;
  isLikedByViewer: boolean;
  popularityScore: number;
  trendingScore: number;
  performanceScore: number;
  publishedAt: string | null;
  currentRevisionId: string;
  publishedRevisionId: string | null;
  sourceBlueprintId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BlueprintRevisionSummary {
  id: string;
  blueprintId: string;
  version: number;
  kind: 'agent' | 'bot';
  name: string;
  description: string;
  strategyType: string | null;
  style: 'careful' | 'balanced' | 'bold' | null;
  tags: string[];
  venueType: string | null;
  changeSummary: string | null;
  createdByUserId: string;
  createdAt: string;
}

export interface BlueprintSkillRef {
  skillId: string;
  skillRevisionId: string;
}

export interface BlueprintRevisionDetail extends BlueprintRevisionSummary {
  payload: Record<string, unknown>;
  skills: BlueprintSkillRef[];
}

export interface BlueprintLineage {
  sourceBlueprintId: string | null;
  sourceBlueprintRevisionId: string | null;
}

export interface BlueprintDetail extends BlueprintSummary {
  revision: BlueprintRevisionDetail;
  lineage: BlueprintLineage | null;
}

// ── Instantiate Preview ──────────────────────────────────────────────

export interface BlueprintInstantiatePreviewRequest {
  revisionId?: string;
  edits?: Record<string, unknown>;
  bindings?: BlueprintBinding;
  requestedMode?: 'paper' | 'shadow' | 'live';
  liveOptIn?: boolean;
}

export interface BlueprintBindingAgent {
  kind: 'agent';
  connectionIds: string[];
}

export interface BlueprintBindingBot {
  kind: 'bot';
  connectionId: string;
  venueAccountId: string;
}

export type BlueprintBinding = BlueprintBindingAgent | BlueprintBindingBot;

export interface EffectiveRiskField {
  rawValue: number | null | undefined;
  effectiveValue: number | null;
  source: 'user' | 'default' | 'agent_override' | 'derived' | 'disabled';
  mutable: boolean;
  operatorCeiling: number | null | undefined;
  enforced: boolean;
}

export interface EffectiveRiskProfile {
  maxOpenPositions: EffectiveRiskField;
  maxPositionSizePct: EffectiveRiskField;
  stopLossPct: EffectiveRiskField;
  stopLossCooldownMs: EffectiveRiskField;
  maxDrawdownPct: EffectiveRiskField;
  dailyMaxLossPct: EffectiveRiskField;
  maxNewPositionsPerDay: EffectiveRiskField;
  avoidParabolicMovePct: EffectiveRiskField;
  maxOrderNotional: EffectiveRiskField;
}

export interface BlueprintInstantiatePreviewResponse {
  blueprintId: string;
  revisionId: string;
  kind: 'agent' | 'bot';
  rawPayload: Record<string, unknown>;
  rawRisk: Record<string, unknown> | null;
  effectiveRisk: EffectiveRiskProfile;
  requiredPrivateInputs: string[];
  compatibleExecutionModes: string[];
  selectedResolvedMode: string | null;
  validationWarnings: string[];
}

// ── Instantiate Confirm ─────────────────────────────────────────────

export interface BlueprintInstantiateRequest {
  revisionId: string;
  edits?: Record<string, unknown>;
  bindings?: BlueprintBinding;
  requestedMode?: 'paper' | 'shadow' | 'live';
  liveOptIn?: boolean;
  expectedMode?: 'paper' | 'shadow' | 'live' | null;
}

export interface BlueprintInstantiateResponse {
  actorId: string;
  actorKind: string;
  status: string;
}

// ── Browse ──────────────────────────────────────────────────────────

export interface BlueprintBrowseParams {
  kind?: 'agent' | 'bot';
  strategyType?: string;
  style?: 'careful' | 'balanced' | 'bold';
  venueType?: 'orderbook' | 'swap';
  tags?: string[];
  sort?: 'popular' | 'trending' | 'newest' | 'ranking';
  cursor?: string;
  limit?: number;
}

export interface BlueprintBrowseResponse {
  items: BlueprintSummary[];
  nextCursor: string | null;
}

// ── Create / Edit ─────────────────────────────────────────────────────

/** Full blueprint revision payload (agent or bot discriminated union). */
export type BlueprintRevisionPayload = Record<string, unknown>;

/** Body for creating a new blueprint from scratch. */
export interface CreateBlueprintBody {
  payload: BlueprintRevisionPayload;
  skills?: BlueprintSkillRef[];
}

/** Body for creating a new revision (edit) of an existing blueprint. */
export interface CreateRevisionBody {
  payload: BlueprintRevisionPayload;
  changeSummary?: string | null;
  expectedBaseRevisionId?: string;
}
