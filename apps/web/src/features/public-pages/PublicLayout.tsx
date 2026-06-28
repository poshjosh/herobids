import { type ReactNode, useMemo } from 'react';
import { useNavigate } from 'react-router';
import { useIntl } from 'react-intl';
import { useLocale } from '../../app/i18n/I18nProvider.js';
import type { SupportedLocale } from '../../app/i18n/resolveLocale.js';
import { PUBLIC_PAGE_REGISTRY, getSectionPages } from './contentRegistry.js';

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

      {/* Footer with links to all public pages */}
      <PublicFooter locale={effectiveLocale} />
    </div>
  );
}

const navLinkStyle: React.CSSProperties = {
  color: 'var(--color-text-secondary)',
  textDecoration: 'none',
  fontSize: '14px',
  fontWeight: '500',
};

// ── Footer ────────────────────────────────────────────────────────────

interface FooterLink {
  label: string;
  href: string;
}

interface FooterGroup {
  title: string;
  href: string;
  links: FooterLink[];
}

interface FooterColumn {
  heading: string;
  links: FooterLink[];
  /** Sub-groups for sections that use `groups` (e.g. Docs → Agents, Messaging). */
  groups?: FooterGroup[];
}

export function PublicFooter({ locale }: { locale: SupportedLocale }) {
  const intl = useIntl();

  const columns = useMemo<FooterColumn[]>(() => {
    const cols: FooterColumn[] = [];

    for (const [section, meta] of Object.entries(PUBLIC_PAGE_REGISTRY)) {
      const heading = intl.formatMessage({ id: `public.nav.${section}` });

      if (meta.groups) {
        // Section with subgroups (e.g. Docs)
        const groups: FooterGroup[] = [];
        for (const [groupKey, group] of Object.entries(meta.groups)) {
          const groupLinks: FooterLink[] = [];
          for (const [pageKey, pageMeta] of Object.entries(group.pages)) {
            groupLinks.push({
              label: pageMeta.title ?? pageKey,
              href: `/${section}/${pageKey}`,
            });
          }
          groups.push({ title: group.title, href: `/${section}/${groupKey}`, links: groupLinks });
        }
        cols.push({ heading, links: [], groups });
      } else {
        // Flat section (e.g. Help, Company, Legal)
        const links: FooterLink[] = [];
        const pages = getSectionPages(meta);
        for (const [pageKey, pageMeta] of Object.entries(pages)) {
          const href = meta.translated
            ? `/${locale}/${section}/${pageKey}`
            : `/${section}/${pageKey}`;
          const label = meta.translated && pageMeta.titleKey
            ? intl.formatMessage({ id: pageMeta.titleKey })
            : (pageMeta.title ?? pageKey);
          links.push({ label, href });
        }
        cols.push({ heading, links });
      }
    }

    return cols;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locale, intl.locale]);

  return (
    <footer
      style={{
        borderTop: '1px solid var(--color-border)',
        background: 'var(--color-surface-1)',
        padding: '32px 24px 24px',
      }}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
          gap: '24px',
        }}
      >
        {columns.map((col) => (
          <div key={col.heading}>
            <h4
              style={{
                margin: '0 0 12px 0',
                fontSize: '14px',
                fontWeight: '600',
                color: 'var(--color-text-primary)',
              }}
            >
              {col.heading}
            </h4>
            {col.groups ? (
              // Nested groups (e.g. Docs → Agents, Messaging)
              col.groups.map((group) => (
                <div key={group.title} style={{ marginBottom: '12px' }}>
                  <h5 style={{ margin: '0 0 4px 0' }}>
                    <a
                      href={group.href}
                      style={{
                        color: 'var(--color-text-tertiary)',
                        textDecoration: 'none',
                        fontSize: '12px',
                        fontWeight: '600',
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em',
                      }}
                    >
                      {group.title}
                    </a>
                  </h5>
                  <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                    {group.links.map((link) => (
                      <li key={link.href} style={{ marginBottom: '4px' }}>
                        <a
                          href={link.href}
                          style={{
                            color: 'var(--color-text-secondary)',
                            textDecoration: 'none',
                            fontSize: '13px',
                          }}
                        >
                          {link.label}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              ))
            ) : (
              // Flat list (e.g. Help, Company, Legal)
              <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {col.links.map((link) => (
                  <li key={link.href} style={{ marginBottom: '6px' }}>
                    <a
                      href={link.href}
                      style={{
                        color: 'var(--color-text-secondary)',
                        textDecoration: 'none',
                        fontSize: '13px',
                      }}
                    >
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>

      <div
        style={{
          marginTop: '24px',
          paddingTop: '16px',
          borderTop: '1px solid var(--color-border-subtle)',
          textAlign: 'center',
          color: 'var(--color-text-muted)',
          fontSize: '12px',
        }}
      >
        © {new Date().getFullYear()} HeroBids. All rights reserved.
      </div>
    </footer>
  );
}
