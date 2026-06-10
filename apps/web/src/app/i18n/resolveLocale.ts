// Supported locales mirror apps/api/src/routes/auth.ts — keep in sync.
export const SUPPORTED_LOCALES = ['en', 'ar', 'hi'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: SupportedLocale = 'en';

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return typeof value === 'string' && SUPPORTED_LOCALES.includes(value as SupportedLocale);
}

/** Locales that use right-to-left text direction. */
export const RTL_LOCALES = new Set<SupportedLocale>(['ar']);

const STORAGE_KEY = 'herobids_locale';

// Browser language → supported locale mapping (language-tag aliases)
const LANGUAGE_MAP: Record<string, SupportedLocale> = {
  en: 'en',
  ar: 'ar',
  hi: 'hi',
};

function toSupportedLocale(tag: string): SupportedLocale | undefined {
  // Exact match (e.g. "ar")
  if (LANGUAGE_MAP[tag]) return LANGUAGE_MAP[tag];
  // Language-only prefix match (e.g. "ar-SA" → "ar")
  const lang = tag.split('-')[0] ?? '';
  return LANGUAGE_MAP[lang];
}

export function resolveLocale(): SupportedLocale {
  // 1. Persisted user preference
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const mapped = toSupportedLocale(stored);
      if (mapped) return mapped;
    }
  } catch {
    // localStorage unavailable (e.g. Safari private mode with storage full)
  }

  // 2. Browser language preferences (ordered list)
  for (const tag of navigator.languages) {
    const mapped = toSupportedLocale(tag);
    if (mapped) return mapped;
  }

  // 3. Default
  return DEFAULT_LOCALE;
}

export function persistLocale(locale: SupportedLocale): void {
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // localStorage unavailable — preference will not persist across sessions
  }
}
