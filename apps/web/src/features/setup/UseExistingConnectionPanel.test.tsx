import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { describe, expect, it, vi } from 'vitest';
import { UseExistingConnectionView } from './UseExistingConnectionPanel.js';

const englishMessages: Record<string, string> = {
  'setup.useExisting.title': 'Use an existing connection for {agent}',
  'setup.useExisting.empty': 'You have no active connections for this provider. Create one instead.',
  'setup.useExisting.confirm': 'Use this connection',
};

function render(props: Partial<Parameters<typeof UseExistingConnectionView>[0]> = {}): string {
  return renderToStaticMarkup(
    <IntlProvider locale="en" messages={englishMessages}>
      <UseExistingConnectionView
        agentName="tom"
        options={[]}
        selectedId={null}
        isSubmitting={false}
        onSelect={vi.fn()}
        onConfirm={vi.fn()}
        {...props}
      />
    </IntlProvider>,
  );
}

describe('UseExistingConnectionView', () => {
  it('shows the empty hint and a disabled confirm when the user has no matching connection', () => {
    const html = render({ options: [] });

    expect(html).toContain('You have no active connections for this provider. Create one instead.');
    expect(html).toContain('disabled');
  });

  it('lists each option as a radio and enables confirm once one is selected', () => {
    const html = render({
      options: [{ id: 'conn-1', label: 'Main wallet' }],
      selectedId: 'conn-1',
    });

    expect(html).toContain('Main wallet');
    expect(html).toContain('type="radio"');
    expect(html).not.toContain('disabled');
  });

  it('names the agent in the title', () => {
    expect(render()).toContain('Use an existing connection for tom');
  });
});
