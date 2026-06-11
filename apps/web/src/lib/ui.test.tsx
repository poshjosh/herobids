import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { IntlProvider } from 'react-intl';
import { StatusBadge } from './ui.js';

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