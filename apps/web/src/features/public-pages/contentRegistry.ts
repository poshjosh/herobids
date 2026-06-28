/**
 * Public page content registry.
 *
 * Maps URL path segments (section → page) to content metadata.
 * Every page listed here must have a corresponding markdown file
 * under `content/<section>/<page>.md` (or `content/<section>/<locale>/<page>.md`
 * for translated sections).
 */
export interface PageMeta {
  /** i18n message key for the page title (translated sections) */
  titleKey?: string;
  /** Static English title (English-only sections) */
  title?: string;
}

/** A named subgroup of pages (e.g. "Agents", "Messaging" under Docs). */
export interface DocGroup {
  title: string;
  pages: Record<string, PageMeta>;
}

export interface SectionMeta {
  translated: boolean;
  /** Flat page map for simple sections (help, company, legal). */
  pages?: Record<string, PageMeta>;
  /** Nested groups for sections that need sub-headings (docs). */
  groups?: Record<string, DocGroup>;
}

/** Flatten a section's pages, whether they come from `pages` or `groups`. */
export function getSectionPages(meta: SectionMeta): Record<string, PageMeta> {
  if (meta.pages) return meta.pages;
  if (meta.groups) {
    const flat: Record<string, PageMeta> = {};
    for (const [groupKey, group] of Object.entries(meta.groups)) {
      flat[groupKey] = { title: group.title };
      Object.assign(flat, group.pages);
    }
    return flat;
  }
  return {};
}

export const PUBLIC_PAGE_REGISTRY: Record<string, SectionMeta> = {
  // ── Translated sections ──────────────────────────────────────────
  help: {
    translated: true,
    pages: {
      'get-started': { titleKey: 'public.help.getStarted' },
      faqs: { titleKey: 'public.help.faqs' },
      pricing: { titleKey: 'public.help.pricing' },
    },
  },
  company: {
    translated: true,
    pages: {
      'about-us': { titleKey: 'public.company.aboutUs' },
      'contact-us': { titleKey: 'public.company.contactUs' },
    },
  },

  // ── English-only sections ────────────────────────────────────────
  docs: {
    translated: false,
    groups: {
      agents: {
        title: 'Agents',
        pages: {
          'agents/agent-style': { title: 'Agent Style' },
          'agents/billing-limits': { title: 'Billing Limits' },
        },
      },
      messaging: {
        title: 'Messaging',
        pages: {
          'messaging/telegram/reply-threading': { title: 'Telegram Reply Threading' },
          'messaging/telegram/slash-commands': { title: 'Telegram Slash Commands' },
        },
      },
    },
  },
  legal: {
    translated: false,
    pages: {
      'privacy-policy': { title: 'Privacy Policy' },
      'user-agreement': { title: 'User Agreement' },
    },
  },
} as const;

// Re-export SUPPORTED_LOCALES for convenience in route validation
export { SUPPORTED_LOCALES } from '../../app/i18n/resolveLocale.js';

/** Sections that support i18n (locale prefix in URL) */
export const TRANSLATED_SECTIONS = ['help', 'company'] as const;

/** Sections that are English-only (no locale prefix) */
export const ENGLISH_ONLY_SECTIONS = ['docs', 'legal'] as const;

export type TranslatedSection = (typeof TRANSLATED_SECTIONS)[number];
export type EnglishOnlySection = (typeof ENGLISH_ONLY_SECTIONS)[number];
export type PublicSection = TranslatedSection | EnglishOnlySection;

export function isPublicSection(value: string): value is PublicSection {
  return (
    TRANSLATED_SECTIONS.includes(value as TranslatedSection) ||
    ENGLISH_ONLY_SECTIONS.includes(value as EnglishOnlySection)
  );
}

export function isTranslatedSection(section: string): section is TranslatedSection {
  return TRANSLATED_SECTIONS.includes(section as TranslatedSection);
}
