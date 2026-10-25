import type { ReactNode } from 'react';

const URL_PATTERN = /(?:https?:\/\/|mailto:)[^\s<>"']+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}]+$/;
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

function toSafeHref(candidate: string): string | null {
  try {
    const url = new URL(candidate);
    return ALLOWED_PROTOCOLS.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/** Renders plain text with http(s) and mailto URLs as clickable links. Text is never parsed as HTML. */
export function Linkify({ text }: { text: string }): ReactNode {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(URL_PATTERN)) {
    const raw = match[0];
    const matchStart = match.index ?? 0;
    const trimmed = raw.replace(TRAILING_PUNCTUATION, '');
    const href = toSafeHref(trimmed);
    if (!href) continue;

    if (matchStart > lastIndex) nodes.push(text.slice(lastIndex, matchStart));
    nodes.push(
      <a key={matchStart} href={href} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-brand)', textDecoration: 'underline' }}>
        {trimmed}
      </a>,
    );
    lastIndex = matchStart + trimmed.length;
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return <>{nodes}</>;
}
