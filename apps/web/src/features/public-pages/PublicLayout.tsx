import { type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { useIntl } from 'react-intl';
import { useLocale } from '../../app/i18n/I18nProvider.js';
import type { SupportedLocale } from '../../app/i18n/resolveLocale.js';

interface PublicLayoutProps {
  children: ReactNode;
  /** Whether this section supports translations (shows locale switcher) */
  translated?: boolean;
  /** Current section (e.g. "help", "company") — for locale-aware nav links */
  section?: string;
  /** Current page (e.g. "faqs", "about-us") — for locale-aware nav links */
  page?: string;
  /** Resolved locale from the URL — drives chrome language on first paint */
  locale?: SupportedLocale;
}

/**
 * Builds a URL for a public page, applying the locale prefix when needed.
 * Translated sections get `/:locale/...`; English-only sections are bare.
 * Canvas links (no current locale context) default to `en`.
 */
function publicUrl(section: string, page: string, currentLocale?: string): string {
  // English-only sections never have a locale prefix
  if (section === 'docs' || section === 'legal') {
    return `/${section}/${page}`;
  }
  // Translated sections use the current locale, or fall back to en
  const loc = currentLocale ?? 'en';
  return `/${loc}/${section}/${page}`;
}

export function PublicLayout({ children, translated = false, section, page, locale }: PublicLayoutProps) {
  const { setLocale, supportedLocales } = useLocale();
  const effectiveLocale = locale ?? 'en';
  const intl = useIntl();
  const navigate = useNavigate();

  const handleLocaleChange = (nextLocale: string) => {
    setLocale(nextLocale as typeof effectiveLocale);
    // Navigate to the same page under the new locale
    if (section && page) {
      navigate(publicUrl(section, page, nextLocale), { replace: true });
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--color-surface-0)' }}>
      {/* Slim top nav */}
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 24px',
          borderBottom: '1px solid var(--color-border)',
          background: 'var(--color-surface-1)',
        }}
      >
        <a
          href="/"
          style={{
            fontSize: '18px',
            fontWeight: '700',
            color: 'var(--color-text-primary)',
            textDecoration: 'none',
          }}
        >
          HeroBids
        </a>

        <nav style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <a href={publicUrl('help', 'get-started', effectiveLocale)} style={navLinkStyle}>
            {intl.formatMessage({ id: 'public.nav.help' })}
          </a>
          <a href={publicUrl('company', 'about-us', effectiveLocale)} style={navLinkStyle}>
            {intl.formatMessage({ id: 'public.nav.company' })}
          </a>
          <a href="/docs/agents/agent-style" style={navLinkStyle}>
            {intl.formatMessage({ id: 'public.nav.docs' })}
          </a>
          <a href="/legal/privacy-policy" style={navLinkStyle}>
            {intl.formatMessage({ id: 'public.nav.legal' })}
          </a>

          {translated && (
            <select
              value={effectiveLocale}
              onChange={(e) => handleLocaleChange(e.target.value)}
              style={{
                padding: '4px 8px',
                borderRadius: '6px',
                border: '1px solid var(--color-border)',
                background: 'var(--color-surface-0)',
                color: 'var(--color-text-primary)',
                fontSize: '13px',
              }}
            >
              {supportedLocales.map((loc) => (
                <option key={loc} value={loc}>
                  {loc.toUpperCase()}
                </option>
              ))}
            </select>
          )}
        </nav>
      </header>

      {/* Content */}
      <main style={{ flex: 1, padding: '32px 24px', maxWidth: '800px', margin: '0 auto', width: '100%' }}>
        {children}
      </main>

      {/* Minimal footer */}
      <footer
        style={{
          textAlign: 'center',
          padding: '16px 24px',
          borderTop: '1px solid var(--color-border)',
          color: 'var(--color-text-secondary)',
          fontSize: '13px',
          background: 'var(--color-surface-1)',
        }}
      >
        © {new Date().getFullYear()} HeroBids. All rights reserved.
      </footer>
    </div>
  );
}

const navLinkStyle: React.CSSProperties = {
  color: 'var(--color-text-secondary)',
  textDecoration: 'none',
  fontSize: '14px',
  fontWeight: '500',
};
