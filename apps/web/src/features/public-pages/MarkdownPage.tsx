import { useEffect, useState } from 'react';
import type { HTMLAttributes } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Brandify, brandifyTag } from '../../lib/brandify.js';
import type { PublicSection } from './contentRegistry.js';
import { loadContent } from './loadContent.js';

/**
 * Generate a URL-friendly slug from heading text.
 * E.g. "When does escalation happen?" → "when-does-escalation-happen"
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function extractText(node: unknown): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (node && typeof node === 'object' && 'props' in node) {
    const props = (node as { props?: { children?: unknown } }).props;
    if (props?.children) return extractText(props.children);
  }
  return '';
}

type HeadingProps = HTMLAttributes<HTMLHeadingElement>;

const headingComponents = {
  h1: ({ children, ...props }: HeadingProps) => {
    const text = extractText(children);
    return <h1 id={slugify(text)} {...props}><Brandify>{children}</Brandify></h1>;
  },
  h2: ({ children, ...props }: HeadingProps) => {
    const text = extractText(children);
    return <h2 id={slugify(text)} {...props}><Brandify>{children}</Brandify></h2>;
  },
  h3: ({ children, ...props }: HeadingProps) => {
    const text = extractText(children);
    return <h3 id={slugify(text)} {...props}><Brandify>{children}</Brandify></h3>;
  },
};

interface MarkdownPageProps {
  section: PublicSection;
  page: string;
  locale?: string;
  fallbackTitle: string;
}

/**
 * Renders a markdown content page.
 *
 * Handles loading state, empty state, and the actual markdown rendering
 * with GFM support (tables, strikethrough, autolinks).
 */
export function MarkdownPage({ section, page, locale, fallbackTitle }: MarkdownPageProps) {
  const [content, setContent] = useState<string | null>(null);
  const [title, setTitle] = useState(fallbackTitle);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    loadContent(section, page, locale)
      .then((result) => {
        if (cancelled) return;
        if (result) {
          setContent(result.content);
          setTitle(result.title || fallbackTitle);
        } else {
          setContent(null);
        }
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load content');
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [section, page, locale, fallbackTitle]);

  // Set document title
  useEffect(() => {
    document.title = `${title} — OpenAIdom`;
    return () => {
      document.title = 'OpenAIdom';
    };
  }, [title]);

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: '48px 0', color: 'var(--color-text-secondary)' }}>
        Loading…
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ textAlign: 'center', padding: '48px 0', color: 'var(--color-error)' }}>
        <p>Something went wrong loading this page.</p>
        <p style={{ fontSize: '13px', marginTop: '8px' }}>{error}</p>
      </div>
    );
  }

  if (!content) {
    return (
      <div style={{ textAlign: 'center', padding: '48px 0' }}>
        <h1 style={{ fontSize: '24px', fontWeight: '600', color: 'var(--color-text-primary)' }}>
          Page not found
        </h1>
        <p style={{ color: 'var(--color-text-secondary)', marginTop: '8px' }}>
          The page you are looking for does not exist.
        </p>
      </div>
    );
  }

  return (
    <div className="prose prose-invert">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          ...headingComponents,
          p: brandifyTag('p'),
          li: brandifyTag('li'),
          td: brandifyTag('td'),
          th: brandifyTag('th'),
          a: brandifyTag('a'),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
