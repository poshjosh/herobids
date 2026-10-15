import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { describe, expect, it, vi } from 'vitest';
import { UseExistingConnectionView } from './UseExistingConnectionPanel.js';

const englishMessages: Record<string, string> = {
  'setup.useExisting.title': 'Use an existing connection for {agent}',
  'setup.useExisting.confirm': 'Use this connection',
};

function render(props: Partial<Parameters<typeof UseExistingConnectionView>[0]> = {}): string {
  return renderToStaticMarkup(
    <IntlProvider locale="en" messages={englishMessages}>
      <UseExistingConnectionView
        agentName="tom"
        options={[{ id: 'conn-1', label: 'Main account' }]}
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
  it('keeps confirm disabled until a connection is selected', () => {
    const html = render({ selectedId: null });

    expect(html).toContain('disabled');
  });

  it('lists each option as a radio and enables confirm once one is selected', () => {
    const html = render({
      options: [{ id: 'conn-1', label: 'Main account' }],
      selectedId: 'conn-1',
    });

    expect(html).toContain('Main account');
    expect(html).toContain('type="radio"');
    expect(html).not.toContain('disabled');
  });

  it('names the agent in the title', () => {
    expect(render()).toContain('Use an existing connection for tom');
  });
});
