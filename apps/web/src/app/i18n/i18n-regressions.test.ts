import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SUPPORTED_LOCALES } from './resolveLocale.js';
import { messages as enMessages } from './locales/en.js';
import { messages as arMessages } from './locales/ar.js';
import { messages as hiMessages } from './locales/hi.js';

const webRoot = new URL('../../', import.meta.url);

function collectSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      return collectSourceFiles(path);
    }

    return path.endsWith('.ts') || path.endsWith('.tsx') ? [path] : [];
  });
}

describe('i18n regressions', () => {
  it('does not use ad-hoc toLocaleDateString formatting in the web app', () => {
    const files = collectSourceFiles(webRoot.pathname);
    const currentTestFile = new URL('./i18n-regressions.test.ts', import.meta.url).pathname;
    const offenders = files.filter((file) => file !== currentTestFile && readFileSync(file, 'utf8').includes('toLocaleDateString('));

    expect(offenders).toEqual([]);
  });

  it('does not use ad-hoc toLocaleString formatting in BillingDetails or ApprovalsPanel', () => {
    const targetFiles = [
      new URL('../../features/billing/BillingDetails.tsx', import.meta.url).pathname,
      new URL('../../features/agents/ApprovalsPanel.tsx', import.meta.url).pathname,
    ];
    const offenders = targetFiles.filter((file) => readFileSync(file, 'utf8').includes('toLocaleString('));
    expect(offenders).toEqual([]);
  });

  it('keeps migrated pages free from the old hard-coded English copy', () => {
    const expectations = [
      {
        file: new URL('../../features/billing/BillingPage.tsx', import.meta.url),
        banned: ['Manage your subscription and plan'],
      },
      {
        file: new URL('../../features/agents/AgentsPage.tsx', import.meta.url),
        banned: ['Goal-driven agents with explicit skills and execution modes', 'No agents yet'],
      },
      {
        file: new URL('../../features/agents/AgentSummaryCard.tsx', import.meta.url),
        banned: ['Loading skills...', 'No capability setup required', 'Open agent'],
      },
      {
        file: new URL('../../features/agents/AgentDetailPage.tsx', import.meta.url),
        banned: ['Edit config', 'Edit agent', 'Delete this agent? This cannot be undone.'],
      },
      {
        file: new URL('../../features/chat/GuidedSetupPanel.tsx', import.meta.url),
        banned: ['Checking account', 'Starting chat', 'Processing your connection'],
      },
    ];

    for (const { file, banned } of expectations) {
      const source = readFileSync(file, 'utf8');
      for (const phrase of banned) {
        expect(source).not.toContain(phrase);
      }
    }
  });

  it('web and API define the same supported locales', () => {
    // The API mirror is apps/api/src/routes/auth.ts. This test detects drift.
    const apiSource = readFileSync(
      new URL('../../../../../apps/api/src/routes/auth.ts', import.meta.url),
      'utf8',
    );
    const match = apiSource.match(/new Set\(\[([^\]]+)\]\)/);
    expect(match, 'Could not find SUPPORTED_LOCALES Set in auth.ts').not.toBeNull();
    const apiLocales = (match![1] ?? '')
      .match(/'([^']+)'/g)!
      .map((s) => s.slice(1, -1))
      .sort();
    const webLocales = [...SUPPORTED_LOCALES].sort();
    expect(apiLocales).toEqual(webLocales);
  });

  it('all en keys are present in every other locale', () => {
    const enKeys = Object.keys(enMessages);
    const otherLocales: Record<string, Record<string, string>> = { ar: arMessages, hi: hiMessages };
    for (const [lang, messages] of Object.entries(otherLocales)) {
      for (const key of enKeys) {
        expect(messages, `Missing key "${key}" in ${lang}`).toHaveProperty(key);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Improved connection & credential handling — copy change regressions (feature 001)
// ---------------------------------------------------------------------------

describe('setup flow copy changes', () => {
  it('agents.create.noConnections no longer tells users to "Create a trading connection first"', () => {
    // The old copy equated connection creation with full trading readiness.
    // The new copy is provider-link aware and surfaces the inline setup button.
    expect(enMessages['agents.create.noConnections']).not.toContain('Create a trading connection first');
  });

  it('agents.capabilityPage.noConnections no longer tells users to "Create a trading connection first"', () => {
    // The old copy pointed to connections as the next step. The correct next step
    // is now Mission Control (guided setup) or Create Agent (inline setup).
    expect(enMessages['agents.capabilityPage.noConnections']).not.toContain('Create a trading connection first');
  });

  it('setup.form.title is defined and names the guided setup flow', () => {
    expect(enMessages['setup.form.title']).toBeTruthy();
    expect(enMessages['setup.form.title']).toBe('Connect agent to external platform');
  });

  it('agents.create.setupTradingNow key exists for the inline escape-hatch button', () => {
    expect(enMessages['agents.create.setupTradingNow']).toBeTruthy();
    expect(enMessages['agents.create.setupTradingNow']).toBe('Set up trading now');
  });

  it('ai model selection copy is defined for settings and agent forms', () => {
    for (const key of [
      'aiModels.title',
      'aiModels.description',
      'aiModels.provider.label',
      'aiModels.economy.label',
      'aiModels.premium.label',
      'agents.create.models.title',
      'agents.create.tradingControls.title',
      'agents.create.telegramChatId',
      'agents.review.models',
      'agents.edit.models.title',
      'agents.edit.models.description',
      'agents.edit.models.override',
      'agents.edit.models.clearOverride',
    ]) {
      expect(enMessages[key], `Missing i18n key: ${key}`).toBeTruthy();
    }
  });

  // The case "AgentCapabilityPage trading next steps no longer route to
  // /connections" was removed: it parsed the body of `getCapabilityNextSteps`,
  // which the capabilities UI overhaul (plan 002) deleted when the per-family
  // page was reworked into a single plain-language Status card. Its premise
  // (a `getCapabilityNextSteps` trading branch using `setupOnAgents`) no longer
  // exists, so the assertion is retired rather than relaxed.
});


// ---------------------------------------------------------------------------
// Permission level i18n keys — explicit coverage
// ---------------------------------------------------------------------------

describe('permission level i18n keys', () => {
  const PERMISSION_LEVEL_KEYS = [
    'agents.permissionLevel.label',
    'agents.permissionLevel.restricted.label',
    'agents.permissionLevel.restricted.description',
    'agents.permissionLevel.standard.label',
    'agents.permissionLevel.standard.description',
    'agents.permissionLevel.full.label',
    'agents.permissionLevel.full.description',
    'agents.permissionLevel.default',
  ] as const;

  it('all permission level keys exist in the English locale', () => {
    for (const key of PERMISSION_LEVEL_KEYS) {
      expect(enMessages, `Missing en key: ${key}`).toHaveProperty(key);
      expect(enMessages[key]).toBeTruthy();
    }
  });

  it('all permission level keys exist in every non-English locale', () => {
    const otherLocales: Record<string, Record<string, string>> = { ar: arMessages, hi: hiMessages };
    for (const [lang, messages] of Object.entries(otherLocales)) {
      for (const key of PERMISSION_LEVEL_KEYS) {
        expect(messages, `Missing key "${key}" in ${lang}`).toHaveProperty(key);
        expect(messages[key]).toBeTruthy();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Trading capability ledger redesign — ADR 014 guards + key presence (feature 003)
// ---------------------------------------------------------------------------

describe('trading capability presentation — ADR 014 value-inspection guards', () => {
  // The web renders server-supplied display strings VERBATIM and only acts on
  // `emphasis`/`prominence`. It must never compute P&L, derive a colour from a
  // value, parse a number, or pull in a decimal library.
  const BANNED_VALUE_TOKENS = ['formatPnl', 'pnlColor', 'decimal.js', 'parseFloat', 'Number('];

  const guardedFiles = [
    new URL('../../features/agents/CapabilityPresentation.tsx', import.meta.url),
    new URL('../../features/agents/TradingCapabilityPresentation.tsx', import.meta.url),
  ];

  it('CapabilityPresentation and TradingCapabilityPresentation never inspect values', () => {
    for (const file of guardedFiles) {
      const source = readFileSync(file, 'utf8');
      for (const token of BANNED_VALUE_TOKENS) {
        expect(source, `${file.pathname} must not contain "${token}"`).not.toContain(token);
      }
    }
  });

  it('formatting.ts no longer exports the removed trading formatters', () => {
    const source = readFileSync(new URL('../../lib/formatting.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('formatPnl');
    expect(source).not.toContain('pnlColor');
  });
});

describe('trading capability presentation — server-emitted i18n keys', () => {
  // Mirrored from the API presentation constants (feature 003, Item 6). Every
  // key the server emits via `labelKey`/`valueKey`/`titleKey`/`columns` must
  // resolve in the English catalog, or the web silently falls back to the raw
  // server string. Keep this list EXPLICIT so a dropped key fails loudly.
  const SERVER_EMITTED_TRADING_KEYS = [
    // Generic contract keys.
    'capability.details',
    'capability.feed.empty',
    // Attributes.
    'capability.trading.attr.totalPnl',
    'capability.trading.attr.totalPnlClosedOnly',
    'capability.trading.attr.realizedPnl',
    'capability.trading.attr.unrealizedPnl',
    'capability.trading.attr.winningTrades',
    'capability.trading.attr.connection',
    'capability.trading.attr.executionMode',
    'capability.trading.attr.authorization',
    'capability.trading.attr.capital',
    'capability.trading.attr.openPositions',
    'capability.trading.attr.positionSizeMode',
    'capability.trading.attr.warnings',
    // Feeds.
    'capability.trading.feed.trades',
    'capability.trading.feed.decisions',
    'capability.trading.feed.fills',
    // Columns.
    'capability.trading.col.when',
    'capability.trading.col.asset',
    'capability.trading.col.direction',
    'capability.trading.col.size',
    'capability.trading.col.entryPrice',
    'capability.trading.col.exitPrice',
    'capability.trading.col.pnl',
    'capability.trading.col.heldFor',
    'capability.trading.col.status',
    'capability.trading.col.side',
    'capability.trading.col.quantity',
    'capability.trading.col.price',
    // Values.
    'capability.trading.value.long',
    'capability.trading.value.short',
    'capability.trading.value.open',
    'capability.trading.value.closed',
    'capability.trading.value.buy',
    'capability.trading.value.sell',
    'capability.trading.value.notSet',
    'capability.trading.value.winsOfClosed',
    // Decision statuses.
    'capability.trading.decisionStatus.pending',
    'capability.trading.decisionStatus.executing',
    'capability.trading.decisionStatus.completed',
    'capability.trading.decisionStatus.failed',
    'capability.trading.decisionStatus.none',
    // Intents.
    'capability.trading.intent.go_long',
    'capability.trading.intent.go_short',
    'capability.trading.intent.go_flat',
    'capability.trading.intent.increase',
    'capability.trading.intent.decrease',
    // Durations.
    'capability.trading.duration.lessThanMinute',
    'capability.trading.duration.minutes',
    'capability.trading.duration.hoursMinutes',
    'capability.trading.duration.daysHours',
    // Execution modes.
    'capability.trading.executionMode.paper',
    'capability.trading.executionMode.shadow',
    'capability.trading.executionMode.live',
    // Authorizations.
    'capability.trading.authorization.direct',
    'capability.trading.authorization.approval_required',
  ] as const;

  it('every server-emitted trading key resolves in the English catalog', () => {
    for (const key of SERVER_EMITTED_TRADING_KEYS) {
      expect(enMessages, `Missing en key: ${key}`).toHaveProperty(key);
      expect(enMessages[key], `Empty en key: ${key}`).toBeTruthy();
    }
  });
});
