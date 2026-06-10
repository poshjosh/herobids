import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_LOCALE, persistLocale, resolveLocale } from './resolveLocale.js';

function installBrowserState(languages: string[], storedLocale: string | null = null) {
  const storage = new Map<string, string>();
  if (storedLocale !== null) {
    storage.set('herobids_locale', storedLocale);
  }

  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem(key: string) {
        return storage.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        storage.set(key, value);
      },
      removeItem(key: string) {
        storage.delete(key);
      },
      clear() {
        storage.clear();
      },
    },
  });

  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { languages },
  });

  return storage;
}

describe('resolveLocale', () => {
  beforeEach(() => {
    installBrowserState(['en-US']);
  });

  it('prefers a persisted supported locale', () => {
    installBrowserState(['en-US'], 'ar');

    expect(resolveLocale()).toBe('ar');
  });

  it('falls back to the browser language list when nothing is persisted', () => {
    installBrowserState(['fr-FR', 'hi-IN']);

    expect(resolveLocale()).toBe('hi');
  });

  it('falls back to the default locale when nothing matches', () => {
    installBrowserState(['fr-FR', 'es-ES']);

    expect(resolveLocale()).toBe(DEFAULT_LOCALE);
  });

  it('persists the selected locale', () => {
    const storage = installBrowserState(['en-US']);

    persistLocale('hi');

    expect(storage.get('herobids_locale')).toBe('hi');
  });
});