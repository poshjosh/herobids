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
 *   `./content/help/en/faqs.md`
 *   `./content/docs/agents/agent-style.md`
 *   `./content/legal/privacy-policy.md`
 */
const contentModules = import.meta.glob<string>('./content/**/*.md', {
  query: '?raw',
  import: 'default',
  eager: false,
});

/**
 * Load markdown content for a public page.
 *
 * For translated sections (`help`, `company`), the locale is used to look up
 * the locale-specific file. Falls back to `en` if the locale file does not exist.
 *
 * For English-only sections (`docs`, `legal`), the locale parameter is ignored.
 *
 * @returns The loaded content + title, or `null` if no matching file exists.
 */
export async function loadContent(
  section: PublicSection,
  page: string,
  locale?: string,
): Promise<LoadedContent | null> {

  let modulePath: string;

  if (isTranslatedSection(section)) {
    // Try the requested locale first, then fall back to English
    const localesToTry = locale && locale !== 'en' ? [locale, 'en'] : ['en'];

    let matched: (() => Promise<string>) | undefined;
    for (const loc of localesToTry) {
      const path = `./content/${section}/${loc}/${page}.md`;
      if (path in contentModules) {
        modulePath = path;
        matched = contentModules[path];
        break;
      }
    }

    if (!matched!) return null;

    const raw = await matched();
    return { content: raw, title: extractTitle(raw) };
  }

  // English-only section — no locale in path
  modulePath = `./content/${section}/${page}.md`;
  const loader = contentModules[modulePath];
  if (!loader) return null;

  const raw = await loader();
  return { content: raw, title: extractTitle(raw) };
}

/**
 * Extract the title from the first `# ` heading in markdown content.
 */
function extractTitle(markdown: string): string {
  const match = markdown.match(/^# (.+)$/m);
  return match?.[1] ?? 'Untitled';
}
