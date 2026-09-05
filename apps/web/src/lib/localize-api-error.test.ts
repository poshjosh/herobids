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

  it('surfaces the field name for validation_error details', () => {
    const error = new ApiError(400, 'validation_error', 'Request validation failed', undefined, [
      { path: ['prompt'], message: 'String must contain at most 8000 character(s)' },
    ]);

    expect(localizeApiError(intl, error, 'common.errorTitle')).toBe(
      'Request validation failed: prompt: String must contain at most 8000 character(s)',
    );
  });

  it('does not produce a double dot when combining the localized prefix and detail', () => {
    const error = new ApiError(400, 'validation_error', 'Request validation failed', undefined, [
      { path: ['name'], message: 'Required' },
    ]);

    const result = localizeApiError(intl, error, 'common.errorTitle');
    expect(result).not.toContain('..');
    expect(result).toBe('Request validation failed: name: Required');
  });

  it('joins multiple validation issues', () => {
    const error = new ApiError(400, 'validation_error', 'Request validation failed', undefined, [
      { path: ['prompt'], message: 'Too long' },
      { path: ['name'], message: 'Required' },
    ]);

    expect(localizeApiError(intl, error, 'common.errorTitle')).toBe(
      'Request validation failed: prompt: Too long; name: Required',
    );
  });

  it('renders a detail without a path as just its message', () => {
    const error = new ApiError(400, 'validation_error', 'Request validation failed', undefined, [
      { path: [], message: 'Provider is required' },
    ]);

    expect(localizeApiError(intl, error, 'common.errorTitle')).toBe(
      'Request validation failed: Provider is required',
    );
  });

  it('falls back to the flat message for validation_error without details', () => {
    const error = new ApiError(400, 'validation_error', 'Something specific went wrong');

    expect(localizeApiError(intl, error, 'common.errorTitle')).toBe(
      'Request validation failed: Something specific went wrong',
    );
  });
});
