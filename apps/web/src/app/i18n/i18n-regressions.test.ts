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
        file: new URL('../../features/credentials/CredentialsPage.tsx', import.meta.url),
        banned: ['Reusable provider secrets for agents and capability bindings', 'Add provider credential'],
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
        file: new URL('../../features/bots/BotsPage.tsx', import.meta.url),
        banned: ['Trading bots created by you or your AI agents', 'No bots yet', 'Create Bot'],
      },
      {
        file: new URL('../../features/instances/detail/InstanceDetailPage.tsx', import.meta.url),
        banned: ['Bot not found', 'Stop bot?', 'Delete bot?'],
      },
      {
        file: new URL('../../features/trading-instances/InstancesPage.tsx', import.meta.url),
        banned: ['Advanced trading records', 'No bots yet'],
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

  it('agents.capabilityPage.setupOnAgents key exists for the updated next-steps CTA', () => {
    expect(enMessages['agents.capabilityPage.setupOnAgents']).toBeTruthy();
    expect(enMessages['agents.capabilityPage.setupOnAgents']).toBe('Go to AI Agents');
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

  it('AgentCapabilityPage trading next steps no longer route to /connections', () => {
    // The trading capability page must guide users to AI Agents for setup,
    // not to /connections which is now an advanced/partial tool.
    const source = readFileSync(
      new URL('../../features/agents/AgentCapabilityPage.tsx', import.meta.url),
      'utf8',
    );
    // The trading branch should use the setupOnAgents key, not the
    // manageConnections key pointing to /connections.
    const tradingBranchStart = source.indexOf("if (family === 'trading')");
    const tradingBranchEnd = source.indexOf('return [', tradingBranchStart + 1);
    const returnEnd = source.indexOf('];', tradingBranchEnd) + 2;
    const tradingReturnBlock = source.slice(tradingBranchStart, returnEnd);

    expect(tradingReturnBlock).toContain('setupOnAgents');
    expect(tradingReturnBlock).not.toContain("path: '/connections'");
  });
});