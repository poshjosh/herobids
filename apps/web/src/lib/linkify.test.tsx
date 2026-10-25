import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Linkify } from './linkify.js';

const html = (text: string) => renderToStaticMarkup(<Linkify text={text} />);

describe('Linkify', () => {
  it('renders https links as anchors that open in a new tab', () => {
    expect(html('See https://example.com/a?b=1 now')).toBe(
      'See <a href="https://example.com/a?b=1" target="_blank" rel="noopener noreferrer" style="color:var(--color-brand);text-decoration:underline">https://example.com/a?b=1</a> now',
    );
  });

  it('excludes trailing sentence punctuation from the link', () => {
    expect(html('Visit https://example.com.')).toContain('<a href="https://example.com/" target="_blank" rel="noopener noreferrer" style="color:var(--color-brand);text-decoration:underline">https://example.com</a>.');
  });

  it('links mailto addresses', () => {
    expect(html('mailto:ops@example.com')).toContain('href="mailto:ops@example.com"');
  });

  it('does not link disallowed protocols and leaves them as text', () => {
    expect(html('javascript:alert(1)')).not.toContain('<a');
  });

  it('escapes HTML in the message body', () => {
    const out = html('<img src=x onerror=alert(1)> https://example.com');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
  });

  it('returns plain text unchanged when there are no links', () => {
    expect(html('Watching ETH.')).toBe('Watching ETH.');
  });
});
