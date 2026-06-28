import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { describe, expect, it } from 'vitest';
import { messages } from '../../app/i18n/locales/en.js';
import { PUBLIC_PAGE_REGISTRY, getSectionPages } from './contentRegistry.js';
import { PublicFooter } from './PublicLayout.js';
import { loadContent } from './loadContent.js';

function renderFooter(): string {
  return renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages}>
      <PublicFooter locale="en" />
    </IntlProvider>,
  );
}

describe('public pages docs groups', () => {
  it('exposes docs group landing pages through the registry flattening helper', () => {
    const docsPages = getSectionPages(PUBLIC_PAGE_REGISTRY.docs);

    expect(docsPages.agents?.title).toBe('Agents');
    expect(docsPages.messaging?.title).toBe('Messaging');
    expect(docsPages['agents/agent-style']?.title).toBe('Agent Style');
    expect(docsPages['messaging/telegram/slash-commands']?.title).toBe('Telegram Slash Commands');
  });

  it.each([
    ['agents', 'Agents'],
    ['messaging', 'Messaging'],
  ])('loads the docs group landing page for %s via index markdown', async (page, title) => {
    const loaded = await loadContent('docs', page);

    expect(loaded).toMatchObject({ title });
    expect(loaded?.content).toContain(`# ${title}`);
  });

  it('links docs footer group headings to their landing pages', () => {
    const html = renderFooter();

    expect(html).toContain('href="/docs/agents"');
    expect(html).toContain('href="/docs/messaging"');
    expect(html).toContain('href="/docs/agents/agent-style"');
    expect(html).toContain('href="/docs/messaging/telegram/slash-commands"');
  });
});