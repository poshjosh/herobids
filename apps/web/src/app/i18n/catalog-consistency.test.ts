import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { messages as enMessages } from './locales/en.js';
import { messages as arMessages } from './locales/ar.js';
import { messages as hiMessages } from './locales/hi.js';

function sortedKeys(catalog: Record<string, string>): string[] {
  return Object.keys(catalog).sort();
}

/**
 * Two-way key drift between a locale and English. `missing` are English keys the locale lacks;
 * `extra` are locale keys English does not define. Both must be empty for the catalogs to be aligned.
 */
function keyDrift(english: Record<string, string>, locale: Record<string, string>): { missing: string[]; extra: string[] } {
  const englishSet = new Set(Object.keys(english));
  const localeSet = new Set(Object.keys(locale));
  return {
    missing: sortedKeys(english).filter((key) => !localeSet.has(key)),
    extra: sortedKeys(locale).filter((key) => !englishSet.has(key)),
  };
}

// Error codes the API returns for Telegram linking. localizeApiError uses the code as the message id.
const TELEGRAM_LINK_ERROR_CODES = [
  'auth.telegram_link.rate_limited',
  'auth.telegram_link.bot_not_configured',
] as const;

describe('locale catalogs', () => {
  it('keep Arabic and Hindi keys aligned with English in both directions', () => {
    // Asserting the drift object (not just equal key arrays) names the offending keys on failure.
    expect(keyDrift(enMessages, arMessages)).toEqual({ missing: [], extra: [] });
    expect(keyDrift(enMessages, hiMessages)).toEqual({ missing: [], extra: [] });
  });

  it('report every key a locale is missing or has extra', () => {
    const english = { 'a.one': 'A', 'a.two': 'B' };
    const locale = { 'a.one': 'A', 'a.three': 'C' };
    expect(keyDrift(english, locale)).toEqual({ missing: ['a.two'], extra: ['a.three'] });
  });

  it('translate every Telegram link API error code in all locales', () => {
    const apiSource = [
      new URL('../../../../../apps/api/src/agents/telegram-link-token.ts', import.meta.url),
      new URL('../../../../../apps/api/src/routes/auth.ts', import.meta.url),
    ].map((file) => readFileSync(file, 'utf8')).join('\n');

    for (const code of TELEGRAM_LINK_ERROR_CODES) {
      expect(apiSource, `API no longer emits ${code}`).toContain(`'${code}'`);
      for (const catalog of [enMessages, arMessages, hiMessages]) {
        expect(catalog[code], `missing ${code}`).toBeTruthy();
      }
    }
  });
});