import { createIntl, createIntlCache } from 'react-intl';
import { describe, expect, it } from 'vitest';
import { messages } from '../app/i18n/locales/en.js';
import { ApiError } from './api-client.js';
import { localizeApiError } from './localize-api-error.js';

const intl = createIntl(
  {
    locale: 'en',
    messages,
  },
  createIntlCache(),
);

describe('localizeApiError', () => {
  it('formats localized API errors with params', () => {
    const error = new ApiError(400, 'credential.validation_error.required', 'walletAddress is required', {
      field: 'walletAddress',
      venue: 'hyperliquid',
    });

    expect(localizeApiError(intl, error, 'common.errorTitle')).toBe('walletAddress is required for hyperliquid.');
  });

  it('falls back to the original message when a translation key is missing', () => {
    const error = new ApiError(500, 'unknown.error', 'Server exploded');

    expect(localizeApiError(intl, error, 'common.errorTitle')).toBe('Server exploded');
  });

  it('returns the raw message when the fallback contains ICU syntax', () => {
    const error = new ApiError(500, 'unknown.error', 'Bad payload: {foo}');

    expect(localizeApiError(intl, error, 'common.errorTitle')).toBe('Bad payload: {foo}');
  });
});