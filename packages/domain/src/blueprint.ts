import { z } from 'zod';
import {
  StrategyIdentitySchema,
  RiskPostureSchema,
  ExecutionDefaultsSchema,
  AgentStyleSchema,
  BotRiskSchema,
  TokenSafetySchema,
  TechnicalConfigSchema,
  IntelligenceConfigSchema,
  AllowedPresetsPolicySchema,
  PresetTransitionPolicySchema,
  PlatformAssessmentOptInSchema,
  AgentRuntimePolicyOverridesSchema,
  WakePreferencesSchema,
} from './config/schema.js';

// ── Discriminators & Lifecycle ───────────────────────────────────────────────

export const BlueprintKindSchema = z.enum(['agent', 'bot']);
export type BlueprintKind = z.infer<typeof BlueprintKindSchema>;

export const PublicationStatusSchema = z.enum([
  'draft',
  'private',
  'published',
  'delisted',
  'archived',
]);
export type PublicationStatus = z.infer<typeof PublicationStatusSchema>;

// ── Execution Policy (agent-specific execution + risk fields) ────────────────

export const ExecutionPolicySchema = z.object({
  positionSizeMode: z.enum(['fixed', 'percent_equity']).optional(),
  fixedPositionSize: z.string().optional(),
  takeProfitPct: z.number().min(0).nullable().optional(),
}).strict();
export type ExecutionPolicy = z.infer<typeof ExecutionPolicySchema>;

// ── Agent Blueprint Revision Payload ─────────────────────────────────────────

/**
 * Agent-specific superRefine logic extracted so it can be applied to both the
 * standalone AgentBlueprintRevisionPayloadSchema and the BlueprintRevisionPayloadSchema
 * discriminated union (Zod 3.25.76 does not unwrap ZodEffects inside discriminatedUnion).
 */
function agentSuperRefine(
  data: { kind: string; technical?: unknown; intelligence?: unknown; capabilityMode: string; hybridMode?: string },
  ctx: z.RefinementCtx,
) {
  if (data.capabilityMode === 'hybrid' && !data.technical) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: '"technical" config is required when capabilityMode is "hybrid"',
      path: ['capabilityMode'],
    });
  }

  if (data.capabilityMode === 'intelligence' && data.hybridMode !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: '"hybridMode" must not be set when capabilityMode is "intelligence"',
      path: ['hybridMode'],
    });
  }
}

const _AgentBlueprintRevisionPayloadRawSchema = z.object({
  kind: z.literal('agent'),
  name: z.string().min(1),
  description: z.string(),
  tags: z.array(z.string()),
  prompt: z.string(),
  style: AgentStyleSchema.nullable(),
  strategy: StrategyIdentitySchema.nullable(),
  risk: RiskPostureSchema.nullable(),
  executionDefaults: ExecutionDefaultsSchema.nullable(),
  technical: TechnicalConfigSchema.optional(),
  intelligence: IntelligenceConfigSchema.optional(),
  capabilityMode: z.enum(['intelligence', 'hybrid']),
  hybridMode: z.enum(['mixed', 'scanner_gated']).optional(),
  executionPolicy: ExecutionPolicySchema.optional(),
  runtimePolicyOverrides: AgentRuntimePolicyOverridesSchema.optional(),
  toolPolicy: z.record(z.string(), z.unknown()).optional(),
  modelPolicy: z.record(z.string(), z.unknown()).optional(),
  allowedPresets: AllowedPresetsPolicySchema.optional(),
  presetTransition: PresetTransitionPolicySchema.optional(),
  platformAssessment: PlatformAssessmentOptInSchema.optional(),
  authorizationMode: z.enum(['direct', 'approval_required']).nullable(),
  wakePreferences: WakePreferencesSchema.optional(),
  openPositionEscalationToJudgePolicy: z.enum([
    'never',
    'uncovered_or_triggered',
    'always',
  ]),
  capital: z.number().min(0).nullable(),
  maxBots: z.number().int().min(0).nullable(),
  tickIntervalMs: z.number().int().min(1).nullable(),
}).strict();

export const AgentBlueprintRevisionPayloadSchema = _AgentBlueprintRevisionPayloadRawSchema.superRefine(agentSuperRefine);
export type AgentBlueprintRevisionPayload = z.infer<typeof AgentBlueprintRevisionPayloadSchema>;

// ── Bot Blueprint Revision Payload ───────────────────────────────────────────

export const SwapAssetsSchema = z.object({
  baseAsset: z.string(),
  quoteAsset: z.string(),
  baseDecimals: z.number().int().min(0).max(18),
  quoteDecimals: z.number().int().min(0).max(18),
});
export type SwapAssets = z.infer<typeof SwapAssetsSchema>;

const _BotBlueprintRevisionPayloadRawSchema = z.object({
  kind: z.literal('bot'),
  name: z.string().min(1),
  description: z.string(),
  tags: z.array(z.string()),
  strategy: StrategyIdentitySchema,
  risk: BotRiskSchema,
  executionDefaults: ExecutionDefaultsSchema,
  tokenSafety: TokenSafetySchema.optional(),
  venue: z.string(),
  venueType: z.enum(['orderbook', 'swap']),
  symbol: z.string(),
  swapAssets: SwapAssetsSchema.optional(),
  shadowPollIntervalMs: z.number().int().min(100),
}).strict();

export const BotBlueprintRevisionPayloadSchema = _BotBlueprintRevisionPayloadRawSchema;
export type BotBlueprintRevisionPayload = z.infer<typeof BotBlueprintRevisionPayloadSchema>;

// ── Discriminated Union ──────────────────────────────────────────────────────

/**
 * Raw discriminated union (without superRefine).
 */
const _BlueprintRevisionPayloadRawSchema = z.discriminatedUnion('kind', [
  _AgentBlueprintRevisionPayloadRawSchema,
  _BotBlueprintRevisionPayloadRawSchema,
]);

/**
 * Partial variant of the discriminated union for edit payloads.
 * Keeps `kind` required so the discriminator still works; all other fields optional.
 */
const _BlueprintRevisionPayloadPartialSchema = z.discriminatedUnion('kind', [
  _AgentBlueprintRevisionPayloadRawSchema.partial().required({ kind: true }).strict(),
  _BotBlueprintRevisionPayloadRawSchema.partial().required({ kind: true }).strict(),
]);

/**
 * Discriminated union of agent and bot revision payloads.
 * SuperRefine is applied on the union itself instead of on individual schemas
 * because Zod 3.25.76's z.discriminatedUnion() does not unwrap ZodEffects.
 */
export const BlueprintRevisionPayloadSchema = _BlueprintRevisionPayloadRawSchema.superRefine((data, ctx) => {
  if (data.kind === 'agent') {
    agentSuperRefine(data as AgentBlueprintRevisionPayload, ctx);
  }
});
export type BlueprintRevisionPayload = z.infer<typeof BlueprintRevisionPayloadSchema>;

// ── Skill Reference ──────────────────────────────────────────────────────────

export const BlueprintSkillRefSchema = z.object({
  skillId: z.string(),
  skillRevisionId: z.string(),
});
export type BlueprintSkillRef = z.infer<typeof BlueprintSkillRefSchema>;

// ── Bindings (discriminated union for agent vs bot) ──────────────────────────

export const AgentBindingSchema = z.object({
  connectionIds: z.array(z.string()).min(0).max(20),
}).strict();
export type AgentBinding = z.infer<typeof AgentBindingSchema>;

export const BotBindingSchema = z.object({
  connectionId: z.string().min(1),
  venueAccountId: z.string().min(1),
}).strict();
export type BotBinding = z.infer<typeof BotBindingSchema>;

export const BlueprintBindingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('agent'), ...AgentBindingSchema.shape }).strict(),
  z.object({ kind: z.literal('bot'), ...BotBindingSchema.shape }).strict(),
]);
export type BlueprintBinding = z.infer<typeof BlueprintBindingSchema>;

// ── Revision Creation ────────────────────────────────────────────────────────

export const CreateBlueprintRevisionSchema = z.object({
  payload: BlueprintRevisionPayloadSchema,
  changeSummary: z.string().nullable(),
  expectedBaseRevisionId: z.string().optional(),
}).strict();

export const CreateBlueprintSchema = z.object({
  payload: BlueprintRevisionPayloadSchema,
  skills: z.array(BlueprintSkillRefSchema).optional(),
}).strict().superRefine((data, ctx) => {
  if (data.payload.kind === 'bot' && data.skills && data.skills.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Bot blueprints cannot have skill dependencies in Phase 1',
      path: ['skills'],
    });
  }
});

// ── Lifecycle Transitions ────────────────────────────────────────────────────

export const PublishBlueprintSchema = z.object({
  expectedCurrentRevisionId: z.string(),
}).strict();

// ── Preview ──────────────────────────────────────────────────────────────────

export const BlueprintInstantiatePreviewRequestSchema = z.object({
  revisionId: z.string().optional(),
  edits: _BlueprintRevisionPayloadPartialSchema.optional(),
  bindings: BlueprintBindingSchema.optional(),
  requestedMode: z.enum(['paper', 'shadow', 'live']).optional(),
  liveOptIn: z.boolean().optional(),
}).strict();

export const EffectiveRiskFieldSchema = z.object({
  rawValue: z.number().nullable().optional(),
  effectiveValue: z.number().nullable(),
  source: z.enum(['user', 'default', 'agent_override', 'derived', 'disabled']),
  mutable: z.boolean(),
  operatorCeiling: z.number().nullable().optional(),
  enforced: z.boolean(),
});

export const EffectiveRiskProfileSchema = z.object({
  maxOpenPositions: EffectiveRiskFieldSchema,
  maxPositionSizePct: EffectiveRiskFieldSchema,
  stopLossPct: EffectiveRiskFieldSchema,
  stopLossCooldownMs: EffectiveRiskFieldSchema,
  maxDrawdownPct: EffectiveRiskFieldSchema,
  dailyMaxLossPct: EffectiveRiskFieldSchema,
  maxNewPositionsPerDay: EffectiveRiskFieldSchema,
  avoidParabolicMovePct: EffectiveRiskFieldSchema,
  maxOrderNotional: EffectiveRiskFieldSchema,
});

export const BlueprintInstantiatePreviewResponseSchema = z.object({
  blueprintId: z.string(),
  revisionId: z.string(),
  kind: BlueprintKindSchema,
  rawPayload: BlueprintRevisionPayloadSchema,
  rawRisk: RiskPostureSchema.nullable(),
  effectiveRisk: EffectiveRiskProfileSchema,
  requiredPrivateInputs: z.array(z.string()),
  compatibleExecutionModes: z.array(z.string()),
  selectedResolvedMode: z.string().nullable(),
  validationWarnings: z.array(z.string()),
  modelSelectionReady: z.boolean(),
}).strict();

// ── Confirmation ─────────────────────────────────────────────────────────────

export const BlueprintInstantiateRequestSchema = z.object({
  revisionId: z.string(),
  edits: _BlueprintRevisionPayloadPartialSchema.optional(),
  bindings: BlueprintBindingSchema.optional(),
  requestedMode: z.enum(['paper', 'shadow', 'live']).optional(),
  liveOptIn: z.boolean().optional(),
  /** If set, confirmation must reject (409) if the re-resolved mode differs from this. */
  expectedMode: z.enum(['paper', 'shadow', 'live']).nullable().optional(),
}).strict();

export const BlueprintForkRequestSchema = z.object({
  revisionId: z.string().optional(),
  edits: _BlueprintRevisionPayloadPartialSchema.optional(),
}).strict();

// ── Browse / Retrieve ────────────────────────────────────────────────────────

export const BlueprintBrowseQuerySchema = z.object({
  kind: BlueprintKindSchema.optional(),
  strategyType: z.string().optional(),
  style: AgentStyleSchema.optional(),
  venueType: z.enum(['orderbook', 'swap']).optional(),
  tags: z.array(z.string()).optional(),
  sort: z.enum(['popular', 'trending', 'newest', 'ranking']).default('popular'),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

// ── Response DTOs ────────────────────────────────────────────────────────────

export const BlueprintSummarySchema = z.object({
  id: z.string(),
  authorId: z.string(),
  publicationStatus: PublicationStatusSchema,
  kind: BlueprintKindSchema,
  name: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  strategyType: z.string().nullable(),
  style: AgentStyleSchema.nullable(),
  venueType: z.string().nullable(),
  likeCount: z.number(),
  forkCount: z.number(),
  isLikedByViewer: z.boolean(),
  popularityScore: z.number(),
  trendingScore: z.number(),
  performanceScore: z.number(),
  publishedAt: z.string().nullable(),
  currentRevisionId: z.string(),
  publishedRevisionId: z.string().nullable(),
  sourceBlueprintId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict();

export const BlueprintRevisionSummarySchema = z.object({
  id: z.string(),
  blueprintId: z.string(),
  version: z.number(),
  kind: BlueprintKindSchema,
  name: z.string(),
  description: z.string(),
  strategyType: z.string().nullable(),
  style: AgentStyleSchema.nullable(),
  tags: z.array(z.string()),
  venueType: z.string().nullable(),
  changeSummary: z.string().nullable(),
  createdByUserId: z.string(),
  createdAt: z.string(),
}).strict();

export const BlueprintDetailSchema = BlueprintSummarySchema.extend({
  revision: BlueprintRevisionSummarySchema.extend({
    payload: BlueprintRevisionPayloadSchema,
    skills: z.array(BlueprintSkillRefSchema),
  }),
  lineage: z.object({
    sourceBlueprintId: z.string().nullable(),
    sourceBlueprintRevisionId: z.string().nullable(),
  }).nullable(),
}).strict();

// ── Error Codes ──────────────────────────────────────────────────────────────

export const BlueprintErrorCodes = {
  VALIDATION: 'blueprint.validation',
  FORBIDDEN: 'blueprint.forbidden',
  NOT_FOUND: 'blueprint.not_found',
  REVISION_STALE: 'blueprint.revision_stale',
  LIFECYCLE_CONFLICT: 'blueprint.lifecycle_conflict',
  DEPENDENCY_UNAVAILABLE: 'blueprint.dependency_unavailable',
  IDEMPOTENCY_CONFLICT: 'blueprint.idempotency_conflict',
  MODE_CHANGED: 'blueprint.mode_changed',
} as const;

// ── Cursor Encoding ──────────────────────────────────────────────────────────

const CURSOR_SEPARATOR = ':';
const CURSOR_ENCODING = 'base64url';

function base64UrlEncode(data: string): string {
  return Buffer.from(data, 'utf-8').toString(CURSOR_ENCODING);
}

function base64UrlDecode(data: string): string {
  return Buffer.from(data, CURSOR_ENCODING).toString('utf-8');
}

/**
 * Encode a set of key-value pairs into an opaque cursor string for browse pagination.
 * Keys are sorted to produce a deterministic encoding.
 */
export function encodeBlueprintCursor(values: Record<string, unknown>): string {
  const sorted = Object.keys(values)
    .sort()
    .map((key) => `${key}${CURSOR_SEPARATOR}${String(values[key])}`)
    .join(',');
  return base64UrlEncode(sorted);
}

/**
 * Decode a cursor string back into key-value pairs.
 * Returns an empty object for empty or invalid cursors.
 */
export function decodeBlueprintCursor(cursor: string): Record<string, unknown> {
  if (!cursor) return {};
  try {
    const decoded = base64UrlDecode(cursor);
    const result: Record<string, unknown> = {};
    const pairs = decoded.split(',');
    for (const pair of pairs) {
      const sepIdx = pair.indexOf(CURSOR_SEPARATOR);
      if (sepIdx === -1) continue;
      const key = pair.slice(0, sepIdx);
      const value = pair.slice(sepIdx + 1);
      result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}
