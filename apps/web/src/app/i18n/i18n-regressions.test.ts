import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SUPPORTED_LOCALES } from './resolveLocale.js';

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
        banned: ['Edit config', 'Delete this agent? This cannot be undone.'],
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
});