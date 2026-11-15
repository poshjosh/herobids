// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { IntlProvider } from 'react-intl';
import { afterEach, describe, expect, it } from 'vitest';
import { messages as ar } from '../../app/i18n/locales/ar.js';
import { messages as en } from '../../app/i18n/locales/en.js';
import { messages as hi } from '../../app/i18n/locales/hi.js';
import { RuntimePolicySection } from './RuntimePolicySection.js';

const HELP_ID = 'agents.runtimePolicy.maxToolResultCharsHelp';

afterEach(cleanup);

describe('RuntimePolicySection', () => {
  it('shows the help line under the max tool result chars field', () => {
    render(
      <IntlProvider locale="en" messages={en}>
        <RuntimePolicySection style="balanced" overrides={null} onChange={() => undefined} alwaysExpanded />
      </IntlProvider>,
    );
    const help = screen.getByText(en[HELP_ID]!);
    expect(help.previousElementSibling?.id).toBe('rp-maxToolResultChars');
  });

  it('defines the help line in en, ar and hi', () => {
    for (const locale of [en, ar, hi]) {
      expect(locale[HELP_ID]).toBeTruthy();
    }
  });
});
