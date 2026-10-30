import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { IntlProvider } from 'react-intl';
import { PageHeader, StatusBadge } from './ui.js';

function renderStatusBadge(status: string): string {
  return renderToStaticMarkup(
    <IntlProvider locale="en" messages={{ [`status.${status}`]: status }}>
      <StatusBadge status={status} />
    </IntlProvider>,
  );
}

describe('StatusBadge', () => {
  it('animates live statuses', () => {
    const html = renderStatusBadge('active');
    expect(html).toContain('status-dot-pulse');
  });

  it('does not animate stopped statuses', () => {
    const html = renderStatusBadge('stopped');
    expect(html).not.toContain('status-dot-pulse');
  });
});

describe('PageHeader', () => {
  it('keeps the action in the title row and puts the subtitle after that row', () => {
    const html = renderToStaticMarkup(
      <PageHeader title="Skills" subtitle="Extend what agents can do" action={<button>Create skill</button>} />,
    );

    const rowStart = html.indexOf('class="page-header-row"');
    const actionAt = html.indexOf('Create skill');
    const subtitleAt = html.indexOf('Extend what agents can do');
    expect(rowStart).toBeGreaterThan(-1);
    expect(actionAt).toBeGreaterThan(rowStart);
    expect(subtitleAt).toBeGreaterThan(actionAt);
    expect(html.slice(rowStart, subtitleAt)).toContain('Create skill');
  });

  it('renders no subtitle paragraph when none is given', () => {
    const html = renderToStaticMarkup(<PageHeader title="Connections" />);

    expect(html).not.toContain('<p');
  });
});
