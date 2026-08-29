import { describe, it, expect } from 'vitest';
import {
  AgentBlueprintRevisionPayloadSchema,
  BotBlueprintRevisionPayloadSchema,
  BlueprintRevisionPayloadSchema,
  BlueprintInstantiatePreviewResponseSchema,
  CreateBlueprintSchema,
  BlueprintBindingSchema,
  BlueprintKindSchema,
  BlueprintSkillRefSchema,
  CreateBlueprintRevisionSchema,
  BlueprintInstantiatePreviewRequestSchema,
  BlueprintInstantiateRequestSchema,
  BlueprintForkRequestSchema,
  PublishBlueprintSchema,
  ExecutionPolicySchema,
  encodeBlueprintCursor,
  decodeBlueprintCursor,
} from './blueprint.js';

// ── Shared valid payloads ────────────────────────────────────────────────────

const validBotPayload = {
  kind: 'bot' as const,
  name: 'Test Bot',
  description: 'A test bot',
  tags: [],
  strategy: { type: 'dca' as const },
  risk: {},
  executionDefaults: { mode: 'paper' as const },
  venue: 'hyperliquid',
  venueType: 'orderbook' as const,
  symbol: 'BTC-USD',
  shadowPollIntervalMs: 1000,
};

const validAgentIntelligencePayload = {
  kind: 'agent' as const,
  name: 'Test Agent',
  description: 'A test agent',
  tags: [],
  prompt: 'You are a test agent',
  style: null,
  strategy: null,
  risk: null,
  executionDefaults: null,
  intelligence: { provider: 'openai', wakeIntervalMs: 60_000 },
  capabilityMode: 'intelligence' as const,
  openPositionEscalationToJudgePolicy: 'never' as const,
  authorizationMode: null,
  capital: null,
  maxBots: null,
  tickIntervalMs: null,
};

const validAgentHybridPayload = {
  kind: 'agent' as const,
  name: 'Test Agent',
  description: 'A test agent',
  tags: [],
  prompt: 'You are a test agent',
  style: null,
  strategy: null,
  risk: null,
  executionDefaults: null,
  technical: { filters: { venue: 'hyperliquid', venueType: 'orderbook' as const } },
  capabilityMode: 'hybrid' as const,
  openPositionEscalationToJudgePolicy: 'never' as const,
  authorizationMode: null,
  capital: null,
  maxBots: null,
  tickIntervalMs: null,
};

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Agent superRefine invariants
// ═══════════════════════════════════════════════════════════════════════════════

describe('AgentBlueprintRevisionPayloadSchema', () => {
  it('rejects when both technical and intelligence are omitted', () => {
    const { technical, intelligence, ...noConfig } = validAgentHybridPayload;
    const payload = { ...noConfig, capabilityMode: 'hybrid' as const };
    const result = AgentBlueprintRevisionPayloadSchema.safeParse(payload);
    expect(result.success).toBe(false);
    if (!result.success) {
      const msgs = result.error.issues.map((i) => i.message);
      expect(msgs.some((m) => m.includes('technical') || m.includes('intelligence'))).toBe(true);
    }
  });

  it('rejects capabilityMode "hybrid" without technical', () => {
    const { technical, ...noTechnical } = validAgentHybridPayload;
    const result = AgentBlueprintRevisionPayloadSchema.safeParse(noTechnical);
    expect(result.success).toBe(false);
    if (!result.success) {
      const msgs = result.error.issues.map((i) => i.message);
      expect(msgs.some((m) => m.includes('technical'))).toBe(true);
    }
  });

  it('rejects capabilityMode "intelligence" with hybridMode set', () => {
    const payload = {
      ...validAgentIntelligencePayload,
      hybridMode: 'mixed' as const,
    };
    const result = AgentBlueprintRevisionPayloadSchema.safeParse(payload);
    expect(result.success).toBe(false);
    if (!result.success) {
      const msgs = result.error.issues.map((i) => i.message);
      expect(msgs.some((m) => m.includes('hybridMode'))).toBe(true);
    }
  });

  it('accepts valid intelligence-mode payload', () => {
    const result = AgentBlueprintRevisionPayloadSchema.safeParse(validAgentIntelligencePayload);
    expect(result.success).toBe(true);
  });

  it('accepts valid hybrid-mode payload', () => {
    const result = AgentBlueprintRevisionPayloadSchema.safeParse(validAgentHybridPayload);
    expect(result.success).toBe(true);
  });

  it('rejects negative capital', () => {
    const payload = { ...validAgentIntelligencePayload, capital: -1 };
    const result = AgentBlueprintRevisionPayloadSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it('rejects negative maxBots', () => {
    const payload = { ...validAgentIntelligencePayload, maxBots: -1 };
    const result = AgentBlueprintRevisionPayloadSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it('rejects tickIntervalMs below 1', () => {
    const payload = { ...validAgentIntelligencePayload, tickIntervalMs: 0 };
    const result = AgentBlueprintRevisionPayloadSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it('accepts capital as 0 (min boundary)', () => {
    const payload = { ...validAgentIntelligencePayload, capital: 0 };
    const result = AgentBlueprintRevisionPayloadSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it('accepts maxBots as 0 (min boundary)', () => {
    const payload = { ...validAgentIntelligencePayload, maxBots: 0 };
    const result = AgentBlueprintRevisionPayloadSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it('accepts tickIntervalMs as 1 (min boundary)', () => {
    const payload = { ...validAgentIntelligencePayload, tickIntervalMs: 1 };
    const result = AgentBlueprintRevisionPayloadSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Bot .strict() rejection — unknown keys
// ═══════════════════════════════════════════════════════════════════════════════

describe('BotBlueprintRevisionPayloadSchema .strict()', () => {
  it('rejects unknown keys in bot payload', () => {
    const payload = { ...validBotPayload, unknownField: 'should-fail' };
    const result = BotBlueprintRevisionPayloadSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it('accepts a valid minimal bot payload', () => {
    const result = BotBlueprintRevisionPayloadSchema.safeParse(validBotPayload);
    expect(result.success).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Agent .strict() rejection — unknown keys
// ═══════════════════════════════════════════════════════════════════════════════

describe('AgentBlueprintRevisionPayloadSchema .strict()', () => {
  it('rejects unknown keys in agent payload', () => {
    const payload = { ...validAgentIntelligencePayload, unknownField: 'should-fail' };
    const result = AgentBlueprintRevisionPayloadSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it('accepts a valid minimal intelligence agent payload', () => {
    const result = AgentBlueprintRevisionPayloadSchema.safeParse(validAgentIntelligencePayload);
    expect(result.success).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. CreateBlueprintSchema rejects skills on bot blueprints
// ═══════════════════════════════════════════════════════════════════════════════

describe('CreateBlueprintSchema', () => {
  it('rejects bot blueprint with non-empty skills', () => {
    const result = CreateBlueprintSchema.safeParse({
      payload: validBotPayload,
      skills: [{ skillId: 's1', skillRevisionId: 'r1' }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths.some((p) => p.includes('skills'))).toBe(true);
    }
  });

  it('accepts bot blueprint with no skills', () => {
    const result = CreateBlueprintSchema.safeParse({
      payload: validBotPayload,
    });
    expect(result.success).toBe(true);
  });

  it('accepts bot blueprint with empty skills array', () => {
    const result = CreateBlueprintSchema.safeParse({
      payload: validBotPayload,
      skills: [],
    });
    // Empty array has length 0, so superRefine allows it
    expect(result.success).toBe(true);
  });

  it('accepts agent blueprint with skills', () => {
    const result = CreateBlueprintSchema.safeParse({
      payload: validAgentIntelligencePayload,
      skills: [{ skillId: 's1', skillRevisionId: 'r1' }],
    });
    expect(result.success).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Discriminated binding schema
// ═══════════════════════════════════════════════════════════════════════════════

describe('BlueprintBindingSchema', () => {
  it('accepts agent binding with connectionIds', () => {
    const result = BlueprintBindingSchema.safeParse({
      kind: 'agent',
      connectionIds: ['conn-1'],
    });
    expect(result.success).toBe(true);
  });

  it('accepts bot binding with connectionId + venueAccountId', () => {
    const result = BlueprintBindingSchema.safeParse({
      kind: 'bot',
      connectionId: 'c1',
      venueAccountId: 'v1',
    });
    expect(result.success).toBe(true);
  });

  it('rejects bot binding with connectionIds (wrong shape)', () => {
    const result = BlueprintBindingSchema.safeParse({
      kind: 'bot',
      connectionIds: ['conn-1'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects agent binding with connectionId + venueAccountId (wrong shape)', () => {
    const result = BlueprintBindingSchema.safeParse({
      kind: 'agent',
      connectionId: 'c1',
      venueAccountId: 'v1',
    });
    expect(result.success).toBe(false);
  });

  it('rejects agent binding missing connectionIds', () => {
    const result = BlueprintBindingSchema.safeParse({ kind: 'agent' });
    expect(result.success).toBe(false);
  });

  it('rejects bot binding missing connectionId + venueAccountId', () => {
    const result = BlueprintBindingSchema.safeParse({ kind: 'bot' });
    expect(result.success).toBe(false);
  });

  it('rejects unknown kind', () => {
    const result = BlueprintBindingSchema.safeParse({
      kind: 'unknown',
      connectionIds: ['conn-1'],
    });
    expect(result.success).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. changeSummary nullable
// ═══════════════════════════════════════════════════════════════════════════════

describe('CreateBlueprintRevisionSchema changeSummary', () => {
  const validRevision = {
    payload: validAgentIntelligencePayload,
    changeSummary: null,
  };

  it('accepts changeSummary as null', () => {
    const result = CreateBlueprintRevisionSchema.safeParse(validRevision);
    expect(result.success).toBe(true);
  });

  it('rejects when changeSummary is omitted (strict)', () => {
    const { changeSummary, ...noSummary } = validRevision;
    const result = CreateBlueprintRevisionSchema.safeParse(noSummary);
    expect(result.success).toBe(false);
  });

  it('accepts changeSummary as a string', () => {
    const result = CreateBlueprintRevisionSchema.safeParse({
      ...validRevision,
      changeSummary: 'Updated prompt',
    });
    expect(result.success).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. Bot revision required fields
// ═══════════════════════════════════════════════════════════════════════════════

describe('BotBlueprintRevisionPayloadSchema required fields', () => {
  it('rejects bot payload missing strategy', () => {
    const { strategy, ...noStrategy } = validBotPayload;
    const result = BotBlueprintRevisionPayloadSchema.safeParse(noStrategy);
    expect(result.success).toBe(false);
  });

  it('rejects bot payload missing risk', () => {
    const { risk, ...noRisk } = validBotPayload;
    const result = BotBlueprintRevisionPayloadSchema.safeParse(noRisk);
    expect(result.success).toBe(false);
  });

  it('rejects bot payload missing executionDefaults', () => {
    const { executionDefaults, ...noExec } = validBotPayload;
    const result = BotBlueprintRevisionPayloadSchema.safeParse(noExec);
    expect(result.success).toBe(false);
  });

  it('rejects bot payload missing venue', () => {
    const { venue, ...noVenue } = validBotPayload;
    const result = BotBlueprintRevisionPayloadSchema.safeParse(noVenue);
    expect(result.success).toBe(false);
  });

  it('rejects bot payload missing symbol', () => {
    const { symbol, ...noSymbol } = validBotPayload;
    const result = BotBlueprintRevisionPayloadSchema.safeParse(noSymbol);
    expect(result.success).toBe(false);
  });

  it('rejects shadowPollIntervalMs below 100', () => {
    const payload = { ...validBotPayload, shadowPollIntervalMs: 99 };
    const result = BotBlueprintRevisionPayloadSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it('accepts shadowPollIntervalMs at 100 (min boundary)', () => {
    const payload = { ...validBotPayload, shadowPollIntervalMs: 100 };
    const result = BotBlueprintRevisionPayloadSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. BlueprintKindSchema — only 'agent' and 'bot'
// ═══════════════════════════════════════════════════════════════════════════════

describe('BlueprintKindSchema', () => {
  it('accepts "agent"', () => {
    expect(BlueprintKindSchema.safeParse('agent').success).toBe(true);
  });

  it('accepts "bot"', () => {
    expect(BlueprintKindSchema.safeParse('bot').success).toBe(true);
  });

  it('rejects "user"', () => {
    expect(BlueprintKindSchema.safeParse('user').success).toBe(false);
  });

  it('rejects empty string', () => {
    expect(BlueprintKindSchema.safeParse('').success).toBe(false);
  });

  it('rejects arbitrary string', () => {
    expect(BlueprintKindSchema.safeParse('invalid').success).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. BlueprintSkillRefSchema — both fields required
// ═══════════════════════════════════════════════════════════════════════════════

describe('BlueprintSkillRefSchema', () => {
  it('accepts both skillId and skillRevisionId', () => {
    const result = BlueprintSkillRefSchema.safeParse({
      skillId: 's1',
      skillRevisionId: 'r1',
    });
    expect(result.success).toBe(true);
  });

  it('rejects when skillId is missing', () => {
    const result = BlueprintSkillRefSchema.safeParse({ skillRevisionId: 'r1' });
    expect(result.success).toBe(false);
  });

  it('rejects when skillRevisionId is missing', () => {
    const result = BlueprintSkillRefSchema.safeParse({ skillId: 's1' });
    expect(result.success).toBe(false);
  });

  it('rejects empty object', () => {
    const result = BlueprintSkillRefSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 10. Preview request rejects response-only fields (strict)
// ═══════════════════════════════════════════════════════════════════════════════

describe('BlueprintInstantiatePreviewRequestSchema', () => {
  const validPreviewRequest = {
    revisionId: 'rev-1',
    requestedMode: 'paper' as const,
  };

  it('accepts a valid minimal preview request', () => {
    const result = BlueprintInstantiatePreviewRequestSchema.safeParse(validPreviewRequest);
    expect(result.success).toBe(true);
  });

  it('rejects rawRisk in preview request body (strict)', () => {
    const result = BlueprintInstantiatePreviewRequestSchema.safeParse({
      ...validPreviewRequest,
      rawRisk: { maxOpenPositions: 5 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects effectiveRisk in preview request body (strict)', () => {
    const result = BlueprintInstantiatePreviewRequestSchema.safeParse({
      ...validPreviewRequest,
      effectiveRisk: { someField: 'value' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown keys in preview request (strict)', () => {
    const result = BlueprintInstantiatePreviewRequestSchema.safeParse({
      ...validPreviewRequest,
      randomField: 'nope',
    });
    expect(result.success).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 11. Partial edit schema — strictness (H-NEW1)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Partial edit schema', () => {
  it('rejects unknown keys in agent edits', () => {
    const result = BlueprintInstantiatePreviewRequestSchema.safeParse({
      revisionId: 'rev-1',
      edits: {
        kind: 'agent',
        name: 'Renamed',
        unknownField: 'should-be-rejected',
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown keys in bot edits', () => {
    const result = BlueprintInstantiatePreviewRequestSchema.safeParse({
      revisionId: 'rev-1',
      edits: {
        kind: 'bot',
        symbol: 'BTC',
        unknownField: 'should-be-rejected',
      },
    });
    expect(result.success).toBe(false);
  });

  it('accepts minimal agent edit (kind only)', () => {
    const result = BlueprintInstantiatePreviewRequestSchema.safeParse({
      revisionId: 'rev-1',
      edits: { kind: 'agent' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts minimal bot edit (kind only)', () => {
    const result = BlueprintInstantiatePreviewRequestSchema.safeParse({
      revisionId: 'rev-1',
      edits: { kind: 'bot' },
    });
    expect(result.success).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 12. BlueprintRevisionPayloadSchema discriminated union (M-NEW1)
// ═══════════════════════════════════════════════════════════════════════════════

describe('BlueprintRevisionPayloadSchema (discriminated union)', () => {
  it('routes agent payload to agent validation', () => {
    const result = BlueprintRevisionPayloadSchema.safeParse(validAgentIntelligencePayload);
    expect(result.success).toBe(true);
  });

  it('routes bot payload to bot validation', () => {
    const result = BlueprintRevisionPayloadSchema.safeParse(validBotPayload);
    expect(result.success).toBe(true);
  });

  it('rejects agent payload missing technical and intelligence via union', () => {
    const { technical, intelligence, ...noConfig } = validAgentHybridPayload;
    const result = BlueprintRevisionPayloadSchema.safeParse({
      ...noConfig,
      capabilityMode: 'hybrid' as const,
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown kind', () => {
    const result = BlueprintRevisionPayloadSchema.safeParse({ kind: 'unknown', name: 'test' });
    expect(result.success).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 13. Confirmation/Fork/Publish schemas (M-NEW3)
// ═══════════════════════════════════════════════════════════════════════════════

describe('BlueprintInstantiateRequestSchema', () => {
  it('accepts valid confirmation request', () => {
    const result = BlueprintInstantiateRequestSchema.safeParse({
      revisionId: 'rev_123',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing revisionId', () => {
    const result = BlueprintInstantiateRequestSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects unknown fields', () => {
    const result = BlueprintInstantiateRequestSchema.safeParse({
      revisionId: 'rev_123',
      rawRisk: { maxOpenPositions: 5 },
    });
    expect(result.success).toBe(false);
  });
});

describe('BlueprintForkRequestSchema', () => {
  it('accepts minimal fork request', () => {
    const result = BlueprintForkRequestSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('accepts fork with edits', () => {
    const result = BlueprintForkRequestSchema.safeParse({
      revisionId: 'rev_456',
      edits: { kind: 'agent', name: 'Forked Agent' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown fields', () => {
    const result = BlueprintForkRequestSchema.safeParse({ unknownKey: true });
    expect(result.success).toBe(false);
  });
});

describe('PublishBlueprintSchema', () => {
  it('accepts valid publish request', () => {
    const result = PublishBlueprintSchema.safeParse({ expectedCurrentRevisionId: 'rev_789' });
    expect(result.success).toBe(true);
  });

  it('rejects missing expectedCurrentRevisionId', () => {
    const result = PublishBlueprintSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 14. Cursor encode/decode (M-NEW5)
// ═══════════════════════════════════════════════════════════════════════════════

describe('encodeBlueprintCursor / decodeBlueprintCursor', () => {
  it('round-trips a cursor with sort fields', () => {
    const cursor = encodeBlueprintCursor({ popularityScore: 1.5, id: 'bp_123' });
    const decoded = decodeBlueprintCursor(cursor);
    // Values are stringified during encoding, so numbers come back as strings
    expect(decoded).toEqual({ id: 'bp_123', popularityScore: '1.5' });
  });

  it('round-trips empty object', () => {
    const cursor = encodeBlueprintCursor({});
    const decoded = decodeBlueprintCursor(cursor);
    expect(decoded).toEqual({});
  });

  it('returns empty object for invalid input', () => {
    const decoded = decodeBlueprintCursor('not-valid-base64!!!');
    expect(decoded).toEqual({});
  });

  it('returns empty object for empty string', () => {
    const decoded = decodeBlueprintCursor('');
    expect(decoded).toEqual({});
  });
});

// ── Regression: takeProfitPct must accept null ──────────────────────────

describe('ExecutionPolicySchema — takeProfitPct null tolerance', () => {
  it('accepts takeProfitPct: null (defense-in-depth)', () => {
    const result = ExecutionPolicySchema.parse({
      positionSizeMode: 'fixed',
      fixedPositionSize: '100',
      takeProfitPct: null,
    });
    expect(result.takeProfitPct).toBeNull();
  });

  it('accepts takeProfitPct: undefined (omitted key)', () => {
    const result = ExecutionPolicySchema.parse({
      positionSizeMode: 'percent_equity',
    });
    expect(result.takeProfitPct).toBeUndefined();
  });

  it('accepts a numeric takeProfitPct', () => {
    const result = ExecutionPolicySchema.parse({ takeProfitPct: 10 });
    expect(result.takeProfitPct).toBe(10);
  });

  it('rejects a negative takeProfitPct', () => {
    expect(() => ExecutionPolicySchema.parse({ takeProfitPct: -1 })).toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Regression: bug-reports/2026/08/29/001 — dead superRefine invariant
// Intelligence-mode agents without explicit technical/intelligence blocks must
// validate successfully through all schema layers. The removed check
// ("at least one of technical or intelligence must be configured") was
// incorrect — intelligence agents are driven by prompt, model policy, and
// skills, not by the optional IntelligenceConfig block.
// ═══════════════════════════════════════════════════════════════════════════════

describe('Regression: intelligence-mode agents without technical/intelligence blocks (bug 2026-08-29-001)', () => {
  /**
   * Minimal intelligence-mode payload with neither `technical` nor `intelligence`.
   * This mirrors what `resolveUnifiedConfig()` + `projectAgentToBlueprintPayload()`
   * produce for marketplace agents like `tintel` and `skills-sh-tester`.
   */
  const intelligenceOnlyPayload = {
    kind: 'agent' as const,
    name: 'Marketplace Intelligence Agent',
    description: 'An intelligence-mode agent without explicit intelligence config',
    tags: ['marketplace'],
    prompt: 'You are an intelligence-mode agent',
    style: 'balanced' as const,
    strategy: null,
    risk: null,
    executionDefaults: null,
    capabilityMode: 'intelligence' as const,
    openPositionEscalationToJudgePolicy: 'never' as const,
    authorizationMode: null,
    capital: null,
    maxBots: null,
    tickIntervalMs: null,
  };

  it('AgentBlueprintRevisionPayloadSchema accepts intelligence agent without technical or intelligence block', () => {
    const result = AgentBlueprintRevisionPayloadSchema.safeParse(intelligenceOnlyPayload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.technical).toBeUndefined();
      expect(result.data.intelligence).toBeUndefined();
    }
  });

  it('BlueprintRevisionPayloadSchema (discriminated union) accepts intelligence agent without either block', () => {
    const result = BlueprintRevisionPayloadSchema.safeParse(intelligenceOnlyPayload);
    expect(result.success).toBe(true);
  });

  it('BlueprintInstantiatePreviewResponseSchema accepts preview response with intelligence-only rawPayload', () => {
    const riskField = {
      effectiveValue: null,
      source: 'default' as const,
      mutable: true,
      enforced: false,
    };
    const previewResponse = {
      blueprintId: 'bp_marketplace_001',
      revisionId: 'rev_001',
      kind: 'agent' as const,
      rawPayload: intelligenceOnlyPayload,
      rawRisk: null,
      effectiveRisk: {
        maxOpenPositions: riskField,
        maxPositionSizePct: riskField,
        stopLossPct: riskField,
        stopLossCooldownMs: riskField,
        maxDrawdownPct: riskField,
        dailyMaxLossPct: riskField,
        maxNewPositionsPerDay: riskField,
        avoidParabolicMovePct: riskField,
        maxOrderNotional: riskField,
      },
      requiredPrivateInputs: [],
      compatibleExecutionModes: ['paper', 'shadow'],
      selectedResolvedMode: 'paper',
      validationWarnings: [],
      modelSelectionReady: true,
    };

    const result = BlueprintInstantiatePreviewResponseSchema.safeParse(previewResponse);
    expect(result.success).toBe(true);
  });

  it('BlueprintInstantiatePreviewResponseSchema accepts null selectedResolvedMode', () => {
    const riskField = {
      effectiveValue: null,
      source: 'default' as const,
      mutable: true,
      enforced: false,
    };
    const previewResponse = {
      blueprintId: 'bp_marketplace_002',
      revisionId: 'rev_002',
      kind: 'agent' as const,
      rawPayload: intelligenceOnlyPayload,
      rawRisk: null,
      effectiveRisk: {
        maxOpenPositions: riskField,
        maxPositionSizePct: riskField,
        stopLossPct: riskField,
        stopLossCooldownMs: riskField,
        maxDrawdownPct: riskField,
        dailyMaxLossPct: riskField,
        maxNewPositionsPerDay: riskField,
        avoidParabolicMovePct: riskField,
        maxOrderNotional: riskField,
      },
      requiredPrivateInputs: [],
      compatibleExecutionModes: ['paper'],
      selectedResolvedMode: null,
      validationWarnings: [],
      modelSelectionReady: false,
    };

    const result = BlueprintInstantiatePreviewResponseSchema.safeParse(previewResponse);
    expect(result.success).toBe(true);
  });

  it('hybrid-mode agent still requires technical config', () => {
    const hybridWithoutTechnical = {
      ...intelligenceOnlyPayload,
      capabilityMode: 'hybrid' as const,
    };
    const result = AgentBlueprintRevisionPayloadSchema.safeParse(hybridWithoutTechnical);
    expect(result.success).toBe(false);
    if (!result.success) {
      const msgs = result.error.issues.map((i) => i.message);
      expect(msgs).toContain('"technical" config is required when capabilityMode is "hybrid"');
    }
  });

  it('intelligence-mode agent rejects hybridMode being set', () => {
    const intelligenceWithHybridMode = {
      ...intelligenceOnlyPayload,
      hybridMode: 'scanner_gated' as const,
    };
    const result = AgentBlueprintRevisionPayloadSchema.safeParse(intelligenceWithHybridMode);
    expect(result.success).toBe(false);
    if (!result.success) {
      const msgs = result.error.issues.map((i) => i.message);
      expect(msgs).toContain('"hybridMode" must not be set when capabilityMode is "intelligence"');
    }
  });

  it('only produces a single issue for hybrid without technical (no redundant "at least one" error)', () => {
    const hybridWithoutTechnical = {
      ...intelligenceOnlyPayload,
      capabilityMode: 'hybrid' as const,
    };
    const result = AgentBlueprintRevisionPayloadSchema.safeParse(hybridWithoutTechnical);
    expect(result.success).toBe(false);
    if (!result.success) {
      // Before the fix, this produced two issues: the generic "at least one"
      // AND the specific "technical required for hybrid". Now only the specific one.
      expect(result.error.issues).toHaveLength(1);
      expect(result.error.issues[0]!.message).toBe('"technical" config is required when capabilityMode is "hybrid"');
    }
  });
});
