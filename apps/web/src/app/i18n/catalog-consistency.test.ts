import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { messages as enMessages } from './locales/en.js';
import { messages as arMessages } from './locales/ar.js';
import { messages as hiMessages } from './locales/hi.js';

function sortedKeys(catalog: Record<string, string>): string[] {
  return Object.keys(catalog).sort();
}

// Error codes the API returns for Telegram linking. localizeApiError uses the code as the message id.
const TELEGRAM_LINK_ERROR_CODES = [
  'auth.telegram_link.rate_limited',
  'auth.telegram_link.bot_not_configured',
] as const;

describe('locale catalogs', () => {
  it('keep Arabic and Hindi keys aligned with English', () => {
    const englishKeys = sortedKeys(enMessages);

    expect(sortedKeys(arMessages)).toEqual(englishKeys);
    expect(sortedKeys(hiMessages)).toEqual(englishKeys);
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