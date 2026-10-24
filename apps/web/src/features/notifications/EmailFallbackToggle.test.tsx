import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { IntlProvider } from 'react-intl';
import { messages } from '../../app/i18n/locales/en.js';
import { messages as arMessages } from '../../app/i18n/locales/ar.js';
import { messages as hiMessages } from '../../app/i18n/locales/hi.js';
import { EmailFallbackToggleView, type EmailFallbackToggleViewProps } from './EmailFallbackToggle.js';

function render(props: Partial<EmailFallbackToggleViewProps> = {}): string {
  return renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages} defaultLocale="en">
      <EmailFallbackToggleView
        enabled={false}
        busy={false}
        saved={false}
        errorMessage={null}
        onChange={vi.fn()}
        {...props}
      />
    </IntlProvider>,
  );
}

describe('EmailFallbackToggleView', () => {
  it('shows the toggle unticked when the user has not opted in', () => {
    const html = render({ enabled: false });
    expect(html).toContain('type="checkbox"');
    expect(html).not.toContain('checked');
  });

  it('shows the toggle ticked when the user has opted in', () => {
    const html = render({ enabled: true });
    expect(html).toContain('checked=""');
  });

  it('disables the toggle while a save is in flight', () => {
    const html = render({ busy: true });
    expect(html).toContain('disabled=""');
  });

  it('shows the saved confirmation after a successful save', () => {
    const html = render({ saved: true });
    expect(html).toContain(messages['settings.emailFallback.saved']);
  });

  it('shows the save error message', () => {
    const html = render({ errorMessage: 'Could not save your preference.' });
    expect(html).toContain('Could not save your preference.');
  });

  it('describes the email without promising message text', () => {
    const html = render();
    expect(messages['settings.emailFallback.description']).toMatch(/never includes the message text/);
    expect(html).toContain(messages['settings.emailFallback.label']);
  });
});

describe('email fallback copy', () => {
  it.each(Object.keys(messages).filter((key) => key.startsWith('settings.emailFallback.')))(
    'has a translation for %s in ar and hi',
    (key) => {
      expect(arMessages[key]).toEqual(expect.any(String));
      expect(hiMessages[key]).toEqual(expect.any(String));
    },
  );
});
