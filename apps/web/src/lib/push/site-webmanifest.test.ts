import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Lives under src/ rather than public/ so the test file is not copied into the static build.
const manifest: Record<string, unknown> = JSON.parse(
  readFileSync(new URL('../../../public/site.webmanifest', import.meta.url), 'utf8'),
);

describe('site.webmanifest', () => {
  it('declares a stable id, start_url, and scope at the root', () => {
    expect(manifest['id']).toBe('/');
    expect(manifest['start_url']).toBe('/');
    expect(manifest['scope']).toBe('/');
  });

  it('keeps the existing name, icons, colours, and standalone display', () => {
    expect(manifest['name']).toBe('OpenAIdom');
    expect(manifest['short_name']).toBe('OpenAIdom');
    expect(manifest['display']).toBe('standalone');
    expect(manifest['theme_color']).toBe('#ffffff');
    expect(manifest['background_color']).toBe('#ffffff');
    const icons = manifest['icons'];
    expect(Array.isArray(icons)).toBe(true);
    expect(icons).toHaveLength(4);
    const purposes = (icons as Array<{ purpose: string }>).map((icon) => icon.purpose);
    expect(purposes).toContain('any');
    expect(purposes).toContain('maskable');
  });
});
