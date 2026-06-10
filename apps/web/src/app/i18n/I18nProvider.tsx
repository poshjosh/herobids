import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { IntlProvider } from 'react-intl';
import { resolveLocale, persistLocale, SUPPORTED_LOCALES, RTL_LOCALES, type SupportedLocale } from './resolveLocale.js';
import { messages as enMessages } from './locales/en.js';
import { messages as arMessages } from './locales/ar.js';
import { messages as hiMessages } from './locales/hi.js';

const CATALOG: Record<SupportedLocale, Record<string, string>> = {
  en: enMessages,
  ar: arMessages,
  hi: hiMessages,
};

interface LocaleContextValue {
  locale: SupportedLocale;
  setLocale: (locale: SupportedLocale) => void;
  supportedLocales: readonly SupportedLocale[];
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<SupportedLocale>(resolveLocale);

  const setLocale = useCallback((next: SupportedLocale) => {
    persistLocale(next);
    setLocaleState(next);
  }, []);

  // Sync HTML dir and lang attributes for RTL support and accessibility
  useEffect(() => {
    document.documentElement.dir = RTL_LOCALES.has(locale) ? 'rtl' : 'ltr';
    document.documentElement.lang = locale;
  }, [locale]);

  return (
    <LocaleContext.Provider value={{ locale, setLocale, supportedLocales: SUPPORTED_LOCALES }}>
      <IntlProvider locale={locale} messages={CATALOG[locale]} defaultLocale="en">
        {children}
      </IntlProvider>
    </LocaleContext.Provider>
  );
}

export function useLocale(): LocaleContextValue {
  const ctx = useContext(LocaleContext);
  if (!ctx) throw new Error('useLocale must be used within I18nProvider');
  return ctx;
}
