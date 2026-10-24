import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { IntlProvider } from 'react-intl';
import { messages } from '../../app/i18n/locales/en.js';
import { PushOptInView, type PushOptInViewProps } from './PushOptIn.js';

function render(props: Partial<PushOptInViewProps> & Pick<PushOptInViewProps, 'state'>): string {
  return renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages} defaultLocale="en">
      <PushOptInView
        busy={false}
        errorCode={null}
        onEnable={vi.fn()}
        onDisable={vi.fn()}
        onClearAndRetry={vi.fn()}
        {...props}
      />
    </IntlProvider>,
  );
}

describe('PushOptInView', () => {
  it('offers to turn notifications on when ready', () => {
    const html = render({ state: 'ready' });
    expect(html).toContain(messages['push.optIn.enable']);
    expect(html).not.toContain(messages['push.optIn.disable']);
  });

  it('offers to turn notifications off when subscribed', () => {
    const html = render({ state: 'subscribed' });
    expect(html).toContain(messages['push.optIn.disable']);
    expect(html).not.toContain(messages['push.optIn.enable']);
  });

  it('explains the blocked permission without offering a prompt', () => {
    const html = render({ state: 'permission_denied' });
    expect(html).toContain(messages['push.optIn.permissionDenied']);
    expect(html).not.toContain('<button');
  });

  it('shows the Home Screen steps for iOS outside the installed app', () => {
    const html = render({ state: 'needs_install' });
    expect(html).toContain(messages['push.optIn.needsInstall.step1']);
    expect(html).toContain(messages['push.optIn.needsInstall.step2']);
    expect(html).toContain(messages['push.optIn.needsInstall.step3']);
    expect(html).toContain('<ol');
  });

  it('shows the generic install hint for unsupported browsers', () => {
    const html = render({ state: 'unsupported' });
    expect(html).toContain(messages['push.optIn.unsupported']);
    expect(html).toContain(messages['push.optIn.installHint']);
  });

  it('shows the error and a retry button after a failed attempt', () => {
    const html = render({ state: 'error', errorCode: 'push.subscribe_failed' });
    expect(html).toContain(messages['push.optIn.error']);
    expect(html).toContain(messages['push.optIn.enable']);
  });

  it('explains a duplicate endpoint and offers only the explicit clear-and-retry button on 409', () => {
    const html = render({ state: 'error', errorCode: 'notification.endpoint_owned' });
    expect(html).toContain(messages['push.optIn.endpointOwned']);
    const clearAndRetry = messages['push.optIn.clearAndRetry'];
    if (clearAndRetry === undefined) throw new Error('push.optIn.clearAndRetry message is missing');
    // React escapes the apostrophe in the label as &#x27;.
    expect(html).toContain(clearAndRetry.replace(/'/g, '&#x27;'));
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).not.toContain(messages['push.optIn.enable']);
  });

  it('offers a plain retry, not the clear action, after other failures', () => {
    const html = render({ state: 'error', errorCode: 'push.subscribe_failed' });
    expect(html).toContain(messages['push.optIn.enable']);
    expect(html).not.toContain(messages['push.optIn.clearAndRetry']);
  });

  it('shows the revoke failure on a subscribed device', () => {
    const html = render({ state: 'subscribed', errorCode: 'push.revoke_failed' });
    expect(html).toContain(messages['push.optIn.revokeFailed']);
    expect(html).toContain(messages['push.optIn.disable']);
  });

  it('never renders an endpoint URL or key material', () => {
    const html = render({ state: 'subscribed' });
    expect(html).not.toMatch(/https:\/\//);
    expect(html).not.toContain('p256dh');
  });
});
