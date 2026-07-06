import { isTranslatedSection, type PublicSection } from './contentRegistry.js';

/**
 * Result from loading a markdown content file.
 */
export interface LoadedContent {
  content: string;
  /** Extracted from the first `# ` heading in the markdown, or the registry title. */
  title: string;
}

/**
 * Vite glob of all markdown content files.
 * Keys are relative paths from this module, e.g.:
 *   `./content/en/help/faqs.md`
 *   `./content/en/docs/agents/agent-style.md`
 *   `./content/en/legal/privacy-policy.md`
 */
const contentModules = import.meta.glob<string>('./content/**/*.md', {
  query: '?raw',
  import: 'default',
  eager: false,
});

/**
 * Load markdown content for a public page.
 *
 * All content now lives under `content/{locale}/{section}/{page}.md`.
 * Translated sections (help, company) use the URL locale param with `en` fallback.
 * English-only sections (docs, legal) always resolve to `en`.
 *
 * @returns The loaded content + title, or `null` if no matching file exists.
 */
export async function loadContent(
  section: PublicSection,
  page: string,
  locale?: string,
): Promise<LoadedContent | null> {
  // All content lives under content/{locale}/{section}/{page}.md
  // English-only sections always use 'en'; translated sections use the URL param
  const effectiveLocale = isTranslatedSection(section) ? (locale ?? 'en') : 'en';
  const localesToTry = effectiveLocale !== 'en' ? [effectiveLocale, 'en'] : ['en'];

  let matched: (() => Promise<string>) | undefined;
  for (const loc of localesToTry) {
    const path = `./content/${loc}/${section}/${page}.md`;
    if (path in contentModules) {
      matched = contentModules[path];
      break;
    }
  }

  // Also try index.md fallback for group landing pages (e.g. docs/agents/index.md)
  if (!matched) {
    for (const loc of localesToTry) {
      const indexPath = `./content/${loc}/${section}/${page}/index.md`;
      if (indexPath in contentModules) {
        matched = contentModules[indexPath];
        break;
      }
    }
  }

  if (!matched) return null;

  const raw = await matched();
  return { content: raw, title: extractTitle(raw) };
}

/**
 * Extract the title from the first `# ` heading in markdown content.
 */
function extractTitle(markdown: string): string {
  const match = markdown.match(/^# (.+)$/m);
  return match?.[1] ?? 'Untitled';
}
