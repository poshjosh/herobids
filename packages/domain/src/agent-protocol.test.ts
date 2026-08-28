import { describe, it, expect } from 'vitest';
import {
  AgentWakePayloadSchema,
  ReminderWakeContextSchema,
  WatchThresholdWakeContextSchema,
  DiscoveryDeltaWakeContextSchema,
  RegimeChangeWakeContextSchema,
  ScannerWakeContextSchema,
  MarketWatchTriggeredPayloadSchema,
  SendMessagePayloadSchema,
  ManageAgentSkillsPayloadSchema,
  ManageAgentSkillsResultSchema,
  AGENT_MESSAGE_TYPES,
  MESSAGE_PAYLOAD_SCHEMAS,
} from './agent-protocol.js';

// Shared base fields for all wake payloads
const BASE = {
  wakeId: 'w-1',
  reason: 'test reason',
  eventIds: ['e-1'],
  priority: 'normal' as const,
  requestedAt: '2024-01-01T00:00:00.000Z',
};

describe('AgentWakePayloadSchema', () => {
  describe('reminder wake', () => {
    it('accepts a valid reminder wake payload', () => {
      const result = AgentWakePayloadSchema.safeParse({
        ...BASE,
        source: 'reminder',
        context: { reminderId: 'r-1', message: 'Check price', scheduledBy: 'scout' },
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.source).toBe('reminder');
      if (result.data.source === 'reminder') {
        expect(result.data.context.reminderId).toBe('r-1');
        expect(result.data.context.message).toBe('Check price');
        expect(result.data.context.scheduledBy).toBe('scout');
      }
    });

    it('rejects reminder payload with invalid context fields', () => {
      const result = AgentWakePayloadSchema.safeParse({
        ...BASE,
        source: 'reminder',
        context: { symbol: 'BTC', network: 'eth' }, // missing required reminder fields
      });
      expect(result.success).toBe(false);
    });

    it('rejects reminder payload without context (context is required)', () => {
      const result = AgentWakePayloadSchema.safeParse({ ...BASE, source: 'reminder' });
      expect(result.success).toBe(false);
    });
  });

  describe('watch_threshold wake', () => {
    it('accepts a valid watch_threshold wake payload', () => {
      const result = AgentWakePayloadSchema.safeParse({
        ...BASE,
        source: 'watch_threshold',
        context: {
          watchId: 'wt-1',
          symbol: 'BTC',
          chain: 'ethereum',
          condition: 'above',
          thresholdPrice: 50000,
          currentPrice: 51000,
          stale: false,
          triggeredAt: '2024-01-01T00:00:00.000Z',
        },
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      if (result.data.source === 'watch_threshold') {
        expect(result.data.context.symbol).toBe('BTC');
        expect(result.data.context.condition).toBe('above');
      }
    });

    it('accepts optional note field in watch_threshold context', () => {
      const result = AgentWakePayloadSchema.safeParse({
        ...BASE,
        source: 'watch_threshold',
        context: {
          watchId: 'wt-2',
          symbol: 'ETH',
          chain: 'ethereum',
          condition: 'below',
          thresholdPrice: 2000,
          currentPrice: 1990,
          stale: true,
          triggeredAt: '2024-01-01T00:00:00.000Z',
          note: 'circuit-breaker level',
        },
      });
      expect(result.success).toBe(true);
    });

    it('rejects watch_threshold payload with partial context (missing required fields)', () => {
      const result = AgentWakePayloadSchema.safeParse({
        ...BASE,
        source: 'watch_threshold',
        context: { symbol: 'BTC' }, // missing required watch_threshold fields
      });
      expect(result.success).toBe(false);
    });
  });

  describe('discovery_delta wake', () => {
    it('accepts a valid discovery_delta wake payload', () => {
      const result = AgentWakePayloadSchema.safeParse({
        ...BASE,
        source: 'discovery_delta',
        context: {
          symbol: 'PEPE',
          network: 'solana',
          address: '0xabc123',
          reason: 'entered_top_set',
          detectedAt: '2024-01-01T00:00:00.000Z',
        },
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      if (result.data.source === 'discovery_delta') {
        expect(result.data.context.symbol).toBe('PEPE');
        expect(result.data.context.reason).toBe('entered_top_set');
      }
    });

    it('accepts optional rank and liquidity fields', () => {
      const result = AgentWakePayloadSchema.safeParse({
        ...BASE,
        source: 'discovery_delta',
        context: {
          symbol: 'DOGE',
          network: 'ethereum',
          address: '0xdef456',
          reason: 'multi_vector_confirmation',
          rank: 5,
          liquidityUsd: 1_000_000,
          volume24hUsd: 500_000,
          detectedAt: '2024-01-01T00:00:00.000Z',
        },
      });
      expect(result.success).toBe(true);
    });
  });

  describe('regime_change wake', () => {
    it('accepts a valid regime_change wake payload', () => {
      const result = AgentWakePayloadSchema.safeParse({
        ...BASE,
        source: 'regime_change',
        context: {
          benchmarkSymbol: 'BTC',
          previousState: 'bull',
          currentState: 'bear',
          changedAt: '2024-01-01T00:00:00.000Z',
        },
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      if (result.data.source === 'regime_change') {
        expect(result.data.context.benchmarkSymbol).toBe('BTC');
        expect(result.data.context.currentState).toBe('bear');
      }
    });
  });

  describe('scanner wake', () => {
    it('accepts a valid scanner wake payload', () => {
      const result = AgentWakePayloadSchema.safeParse({
        ...BASE,
        source: 'scanner',
        context: {
          scannerKind: 'signal_scoring',
          signalCount: 3,
          topSymbol: 'SOL',
          topConfidence: 0.85,
          regimePass: true,
        },
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      if (result.data.source === 'scanner') {
        expect(result.data.context.scannerKind).toBe('signal_scoring');
        expect(result.data.context.signalCount).toBe(3);
        expect(result.data.context.topSymbol).toBe('SOL');
      }
    });

    it('accepts scanner context with minimal fields (signalCount: 0 for exit-only wakes)', () => {
      const result = AgentWakePayloadSchema.safeParse({
        ...BASE,
        source: 'scanner',
        context: { scannerKind: 'signal_scoring', signalCount: 0 },
      });
      expect(result.success).toBe(true);
    });

    it('rejects scanner context with missing signalCount', () => {
      const result = AgentWakePayloadSchema.safeParse({
        ...BASE,
        source: 'scanner',
        context: {},
      });
      expect(result.success).toBe(false);
    });
  });

  it('rejects payload with unknown source', () => {
    const result = AgentWakePayloadSchema.safeParse({
      ...BASE,
      source: 'unknown_source',
      context: {},
    });
    expect(result.success).toBe(false);
  });

  it('rejects payload missing source', () => {
    const result = AgentWakePayloadSchema.safeParse({ ...BASE });
    expect(result.success).toBe(false);
  });
});

describe('Source-specific context schemas', () => {
  it('ReminderWakeContextSchema rejects unknown scheduledBy values', () => {
    const result = ReminderWakeContextSchema.safeParse({
      reminderId: 'r-1',
      message: 'hello',
      scheduledBy: 'user', // not scout | judge
    });
    expect(result.success).toBe(false);
  });

  it('WatchThresholdWakeContextSchema rejects unknown condition', () => {
    const result = WatchThresholdWakeContextSchema.safeParse({
      watchId: 'w-1',
      symbol: 'BTC',
      chain: 'ethereum',
      condition: 'sideways', // not above | below
      thresholdPrice: 50000,
      currentPrice: 50001,
      stale: false,
      triggeredAt: '2024-01-01T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  it('WatchThresholdWakeContextSchema accepts optional purpose, instrument, positionKey, and schemaVersion', () => {
    const result = WatchThresholdWakeContextSchema.safeParse({
      watchId: 'w-1',
      symbol: 'BTC',
      chain: 'ethereum',
      condition: 'above',
      thresholdPrice: 50000,
      currentPrice: 51000,
      stale: false,
      triggeredAt: '2024-01-01T00:00:00.000Z',
      purpose: 'stop_loss',
      instrumentVenue: 'hyperliquid',
      instrumentId: 'BTC-USD',
      positionKey: 'pos-btc-1',
      schemaVersion: 2,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.purpose).toBe('stop_loss');
      expect(result.data.instrumentVenue).toBe('hyperliquid');
      expect(result.data.instrumentId).toBe('BTC-USD');
      expect(result.data.positionKey).toBe('pos-btc-1');
      expect(result.data.schemaVersion).toBe(2);
    }
  });

  it('WatchThresholdWakeContextSchema accepts minimal payload without new fields', () => {
    const result = WatchThresholdWakeContextSchema.safeParse({
      watchId: 'w-1',
      symbol: 'BTC',
      chain: 'ethereum',
      condition: 'above',
      thresholdPrice: 50000,
      currentPrice: 51000,
      stale: false,
      triggeredAt: '2024-01-01T00:00:00.000Z',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.purpose).toBeUndefined();
      expect(result.data.instrumentVenue).toBeUndefined();
      expect(result.data.instrumentId).toBeUndefined();
      expect(result.data.positionKey).toBeUndefined();
      expect(result.data.schemaVersion).toBeUndefined();
    }
  });

  it('MarketWatchTriggeredPayloadSchema accepts optional purpose, instrument, positionKey, and schemaVersion', () => {
    const result = MarketWatchTriggeredPayloadSchema.safeParse({
      eventId: 'evt-1',
      monitorType: 'watch_threshold',
      watchId: 'w-1',
      symbol: 'SOL',
      chain: 'solana',
      condition: 'above',
      thresholdPrice: 200,
      currentPrice: 204,
      priceSource: 'dex',
      stale: false,
      triggeredAt: '2024-01-01T00:00:00.000Z',
      purpose: 'entry',
      instrumentVenue: 'jupiter',
      instrumentId: 'SOL-USDC',
      positionKey: 'pos-sol-1',
      schemaVersion: 2,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.purpose).toBe('entry');
      expect(result.data.instrumentVenue).toBe('jupiter');
      expect(result.data.instrumentId).toBe('SOL-USDC');
      expect(result.data.positionKey).toBe('pos-sol-1');
      expect(result.data.schemaVersion).toBe(2);
    }
  });

  it('MarketWatchTriggeredPayloadSchema rejects unknown purpose value', () => {
    const result = MarketWatchTriggeredPayloadSchema.safeParse({
      eventId: 'evt-1',
      monitorType: 'watch_threshold',
      watchId: 'w-1',
      symbol: 'SOL',
      chain: 'solana',
      condition: 'above',
      thresholdPrice: 200,
      currentPrice: 204,
      priceSource: 'dex',
      stale: false,
      triggeredAt: '2024-01-01T00:00:00.000Z',
      purpose: 'unknown_purpose',
    });
    expect(result.success).toBe(false);
  });

  it('WatchThresholdWakeContextSchema rejects unknown purpose value', () => {
    const result = WatchThresholdWakeContextSchema.safeParse({
      watchId: 'w-1',
      symbol: 'BTC',
      chain: 'ethereum',
      condition: 'above',
      thresholdPrice: 50000,
      currentPrice: 51000,
      stale: false,
      triggeredAt: '2024-01-01T00:00:00.000Z',
      purpose: 'not_valid',
    });
    expect(result.success).toBe(false);
  });

  it('DiscoveryDeltaWakeContextSchema rejects non-integer rank', () => {
    const result = DiscoveryDeltaWakeContextSchema.safeParse({
      symbol: 'TOKEN',
      network: 'eth',
      address: '0x123',
      reason: 'new',
      rank: 1.5, // not integer
      detectedAt: '2024-01-01T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  it('RegimeChangeWakeContextSchema requires all non-optional fields', () => {
    const result = RegimeChangeWakeContextSchema.safeParse({
      benchmarkSymbol: 'BTC',
      // missing previousState, currentState, changedAt
    });
    expect(result.success).toBe(false);
  });

  it('ScannerWakeContextSchema accepts valid signal_scoring variant', () => {
    const result = ScannerWakeContextSchema.safeParse({
      scannerKind: 'signal_scoring',
      signalCount: 3,
      topSymbol: 'SOL',
      topConfidence: 0.85,
      regimePass: true,
    });
    expect(result.success).toBe(true);
  });

  it('ScannerWakeContextSchema rejects signal_scoring without signalCount', () => {
    const result = ScannerWakeContextSchema.safeParse({
      scannerKind: 'signal_scoring',
    });
    expect(result.success).toBe(false);
  });

  it('ScannerWakeContextSchema rejects without scannerKind discriminator', () => {
    const result = ScannerWakeContextSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('ScannerWakeContextSchema accepts valid preset_review variant', () => {
    const result = ScannerWakeContextSchema.safeParse({
      scannerKind: 'preset_review',
      assessmentRef: 'ma_20260718_001',
      recommendedPreset: 'premium',
      currentPreset: 'standard',
      relativeUplift: 0.15,
      confidence: 0.82,
    });
    expect(result.success).toBe(true);
  });

  it('ScannerWakeContextSchema rejects preset_review without required fields', () => {
    const result = ScannerWakeContextSchema.safeParse({
      scannerKind: 'preset_review',
    });
    expect(result.success).toBe(false);
  });

  it('validates assessment_review payloads without optional assessment fields (backward compat)', () => {
    const result = ScannerWakeContextSchema.safeParse({
      scannerKind: 'assessment_review',
      checkedAt: '2026-07-31T12:00:00.000Z',
      nextEligibleAt: '2026-08-01T12:00:00.000Z',
      advice: [
        {
          identity: { instrumentKind: 'orderbook', venueFamily: 'hyperliquid', styleTier: 'standard', symbol: 'BTC' },
          candidateRank: 1,
          activePreset: 'momentum',
          presetBehaviorVersion: 'v1',
          reasons: ['peer_outperformance_detected'],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('validates assessment_review payloads with optional assessment fields', () => {
    const result = ScannerWakeContextSchema.safeParse({
      scannerKind: 'assessment_review',
      checkedAt: '2026-07-31T12:00:00.000Z',
      nextEligibleAt: '2026-08-01T12:00:00.000Z',
      advice: [
        {
          identity: { instrumentKind: 'orderbook', venueFamily: 'hyperliquid', styleTier: 'standard', symbol: 'BTC' },
          candidateRank: 1,
          activePreset: 'momentum',
          presetBehaviorVersion: 'v1',
          reasons: ['peer_outperformance_detected'],
          assessmentArtifactId: 'artifact-abc',
          recommendedPreset: 'range',
          confidence: 0.85,
          expiresAt: '2026-07-31T18:00:00.000Z',
        },
      ],
    });
    expect(result.success).toBe(true);
  });
});

// ── SendMessagePayloadSchema — email/messaging split validation ─────────────

describe('SendMessagePayloadSchema', () => {
  it('accepts body, subject, messageClass, and contextRef as valid keys', () => {
    const result = SendMessagePayloadSchema.safeParse({
      body: 'Hello user!',
      subject: 'Status update',
      messageClass: 'alert',
      contextRef: 'ctx-123',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.body).toBe('Hello user!');
      expect(result.data.subject).toBe('Status update');
      expect(result.data.messageClass).toBe('alert');
      expect(result.data.contextRef).toBe('ctx-123');
    }
  });

  it('accepts body only (the only required field)', () => {
    const result = SendMessagePayloadSchema.safeParse({
      body: 'Minimal message',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.body).toBe('Minimal message');
      expect(result.data.subject).toBeUndefined();
      expect(result.data.messageClass).toBeUndefined();
      expect(result.data.contextRef).toBeUndefined();
    }
  });

  it('does NOT include emailDelivery in the schema shape', () => {
    const shape = (SendMessagePayloadSchema as unknown as { shape: Record<string, unknown> }).shape;
    const keys = Object.keys(shape);
    expect(keys).toContain('body');
    expect(keys).toContain('subject');
    expect(keys).toContain('messageClass');
    expect(keys).toContain('contextRef');
    expect(keys).not.toContain('emailDelivery');
    expect(keys).toHaveLength(4);
  });

  it('silently strips unknown keys like emailDelivery (Zod default behavior)', () => {
    const result = SendMessagePayloadSchema.safeParse({
      body: 'Hello',
      emailDelivery: 'if_allowed',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // emailDelivery is stripped, not in output
      expect((result.data as Record<string, unknown>).emailDelivery).toBeUndefined();
      expect(result.data.body).toBe('Hello');
    }
  });

  it('rejects body exceeding 2000 characters', () => {
    const result = SendMessagePayloadSchema.safeParse({
      body: 'x'.repeat(2001),
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty body', () => {
    const result = SendMessagePayloadSchema.safeParse({
      body: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid messageClass value', () => {
    const result = SendMessagePayloadSchema.safeParse({
      body: 'Hello',
      messageClass: 'urgent', // not in enum
    });
    expect(result.success).toBe(false);
  });

  it('rejects subject exceeding 200 characters', () => {
    const result = SendMessagePayloadSchema.safeParse({
      body: 'Hello',
      subject: 'y'.repeat(201),
    });
    expect(result.success).toBe(false);
  });

  it('accepts all valid messageClass enum values', () => {
    for (const cls of ['routine', 'alert', 'reminder']) {
      const result = SendMessagePayloadSchema.safeParse({
        body: 'Test',
        messageClass: cls,
      });
      expect(result.success).toBe(true);
    }
  });

  it('accepts contextRef at exactly 200 chars', () => {
    const result = SendMessagePayloadSchema.safeParse({
      body: 'Hello',
      contextRef: 'x'.repeat(200),
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contextRef).toHaveLength(200);
    }
  });

  it('rejects contextRef exceeding 200 chars', () => {
    const result = SendMessagePayloadSchema.safeParse({
      body: 'Hello',
      contextRef: 'x'.repeat(201),
    });
    expect(result.success).toBe(false);
  });
});


// ── AGENT_MESSAGE_TYPES — skill management constant ─────────────────────────

describe('AGENT_MESSAGE_TYPES.MANAGE_AGENT_SKILLS', () => {
  it('equals "agent.manage_skills"', () => {
    expect(AGENT_MESSAGE_TYPES.MANAGE_AGENT_SKILLS).toBe('agent.manage_skills');
  });
});

// ── MESSAGE_PAYLOAD_SCHEMAS — skill management registration ─────────────────

describe('MESSAGE_PAYLOAD_SCHEMAS registration', () => {
  it('has ManageAgentSkillsPayloadSchema registered for agent.manage_skills', () => {
    const schema = MESSAGE_PAYLOAD_SCHEMAS['agent.manage_skills'];
    expect(schema).toBeDefined();
    expect(schema).toBe(ManageAgentSkillsPayloadSchema);
  });
});

// ── ManageAgentSkillsPayloadSchema ──────────────────────────────────────────

describe('ManageAgentSkillsPayloadSchema', () => {
  it('accepts a valid add payload', () => {
    const result = ManageAgentSkillsPayloadSchema.safeParse({
      action: 'add',
      skillIds: ['trading'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.action).toBe('add');
      expect(result.data.skillIds).toEqual(['trading']);
    }
  });

  it('accepts a valid remove payload', () => {
    const result = ManageAgentSkillsPayloadSchema.safeParse({
      action: 'remove',
      skillIds: ['web-access'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.action).toBe('remove');
      expect(result.data.skillIds).toEqual(['web-access']);
    }
  });

  it('accepts skillIds with exactly 10 entries (upper boundary)', () => {
    const ids = Array.from({ length: 10 }, (_, i) => `skill-${i}`);
    const result = ManageAgentSkillsPayloadSchema.safeParse({ action: 'add', skillIds: ids });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.skillIds).toHaveLength(10);
    }
  });

  it('accepts skillIds with exactly 1 entry (lower boundary)', () => {
    const result = ManageAgentSkillsPayloadSchema.safeParse({ action: 'add', skillIds: ['solo'] });
    expect(result.success).toBe(true);
  });

  // --- Rejection edge cases ---

  it('rejects empty skillIds array', () => {
    const result = ManageAgentSkillsPayloadSchema.safeParse({
      action: 'add',
      skillIds: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects skillIds with more than 10 entries', () => {
    const ids = Array.from({ length: 11 }, (_, i) => `skill-${i}`);
    const result = ManageAgentSkillsPayloadSchema.safeParse({ action: 'add', skillIds: ids });
    expect(result.success).toBe(false);
  });

  it('rejects invalid action value', () => {
    const result = ManageAgentSkillsPayloadSchema.safeParse({
      action: 'update',
      skillIds: ['trading'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing action field', () => {
    const result = ManageAgentSkillsPayloadSchema.safeParse({
      skillIds: ['trading'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing skillIds field', () => {
    const result = ManageAgentSkillsPayloadSchema.safeParse({
      action: 'add',
    });
    expect(result.success).toBe(false);
  });

  it('rejects skillIds containing empty strings', () => {
    const result = ManageAgentSkillsPayloadSchema.safeParse({
      action: 'add',
      skillIds: [''],
    });
    expect(result.success).toBe(false);
  });

  it('rejects skillIds with non-string elements', () => {
    const result = ManageAgentSkillsPayloadSchema.safeParse({
      action: 'add',
      skillIds: [123],
    });
    expect(result.success).toBe(false);
  });

  it('rejects completely empty object', () => {
    const result = ManageAgentSkillsPayloadSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

// ── ManageAgentSkillsResultSchema ───────────────────────────────────────────

describe('ManageAgentSkillsResultSchema', () => {
  it('accepts a valid ok result', () => {
    const result = ManageAgentSkillsResultSchema.safeParse({
      status: 'ok',
      action: 'add',
      skillIds: ['trading', 'web-access'],
      warnings: [],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe('ok');
      expect(result.data.action).toBe('add');
      expect(result.data.skillIds).toEqual(['trading', 'web-access']);
      expect(result.data.warnings).toEqual([]);
    }
  });

  it('accepts a valid error result with error message', () => {
    const result = ManageAgentSkillsResultSchema.safeParse({
      status: 'error',
      action: 'remove',
      skillIds: [],
      warnings: [],
      error: 'Skill not found',
      errorCode: 'SKILL_NOT_FOUND',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe('error');
      expect(result.data.error).toBe('Skill not found');
      expect(result.data.errorCode).toBe('SKILL_NOT_FOUND');
    }
  });

  it('defaults skillIds and warnings to [] when omitted', () => {
    const result = ManageAgentSkillsResultSchema.safeParse({
      status: 'ok',
      action: 'add',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.skillIds).toEqual([]);
      expect(result.data.warnings).toEqual([]);
    }
  });

  it('accepts a result with warnings', () => {
    const result = ManageAgentSkillsResultSchema.safeParse({
      status: 'ok',
      action: 'add',
      skillIds: ['trading'],
      warnings: ['Skill already assigned'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.warnings).toEqual(['Skill already assigned']);
    }
  });

  it('rejects invalid status value', () => {
    const result = ManageAgentSkillsResultSchema.safeParse({
      status: 'pending',
      action: 'add',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid action value', () => {
    const result = ManageAgentSkillsResultSchema.safeParse({
      status: 'ok',
      action: 'update',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing status field', () => {
    const result = ManageAgentSkillsResultSchema.safeParse({
      action: 'add',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing action field', () => {
    const result = ManageAgentSkillsResultSchema.safeParse({
      status: 'ok',
    });
    expect(result.success).toBe(false);
  });
});
