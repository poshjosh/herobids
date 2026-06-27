import { useEffect } from 'react';
import { useParams, Navigate } from 'react-router';
import { useIntl } from 'react-intl';
import {
  PUBLIC_PAGE_REGISTRY,
  SUPPORTED_LOCALES,
  isTranslatedSection,
  isPublicSection,
  type PublicSection,
} from './contentRegistry.js';
import type { SupportedLocale } from '../../app/i18n/resolveLocale.js';
import { useLocale } from '../../app/i18n/I18nProvider.js';
import { PublicLayout } from './PublicLayout.js';
import { MarkdownPage } from './MarkdownPage.js';

interface PublicPageProps {
  section: string;
  page: string;
}

/**
 * The single page component used by all public page routes.
 *
 * Resolves the locale from route params (for translated sections) or
 * defaults to English (for English-only sections). Validates that the
 * section and page exist in the registry.
 */
export function PublicPage({ section, page }: PublicPageProps) {
  const params = useParams();
  const intl = useIntl();
  const { locale: currentLocale, setLocale } = useLocale();

  // ── Validate inputs (pure — no hooks after this) ──────────────
  const validSection = isPublicSection(section);
  const sectionMeta = validSection ? PUBLIC_PAGE_REGISTRY[section] : undefined;
  const pageMeta = sectionMeta?.pages[page];
  const translated = validSection && sectionMeta ? isTranslatedSection(section) : false;

  // ── Resolve effective locale and redirect ─────────────────────
  let redirectTo: string | null = null;
  let activeLocale: SupportedLocale;

  if (!validSection || !sectionMeta || !pageMeta) {
    // Unknown section or page — bail to home
    redirectTo = '/';
    activeLocale = 'en'; // placeholder, unused because we redirect
  } else if (translated) {
    const rawLocale = params.locale;
    if (!rawLocale || !SUPPORTED_LOCALES.includes(rawLocale as SupportedLocale)) {
      redirectTo = `/en/${section}/${page}`;
      activeLocale = 'en'; // placeholder
    } else {
      activeLocale = rawLocale as SupportedLocale;
    }
  } else {
    activeLocale = 'en';
  }

  // ── Sync global i18n locale to the URL locale ─────────────────
  // Always called, regardless of validation outcome — satisfies
  // React's hooks-ordering invariant.
  useEffect(() => {
    if (!redirectTo && currentLocale !== activeLocale) {
      setLocale(activeLocale);
    }
  }, [activeLocale, currentLocale, redirectTo, setLocale]);

  // ── Redirect for invalid inputs ───────────────────────────────
  if (redirectTo) {
    return <Navigate to={redirectTo} replace />;
  }

  // Now sectionMeta and pageMeta are guaranteed non-null
  const fallbackTitle = translated
    ? pageMeta!.titleKey
      ? intl.formatMessage({ id: pageMeta!.titleKey })
      : page
    : pageMeta!.title ?? page;

  return (
    <PublicLayout translated={translated} section={section} page={page} locale={activeLocale}>
      <MarkdownPage
        section={section as PublicSection}
        page={page}
        locale={activeLocale}
        fallbackTitle={fallbackTitle}
      />
    </PublicLayout>
  );
}
