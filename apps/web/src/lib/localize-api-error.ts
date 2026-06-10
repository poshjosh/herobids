import type { IntlShape } from 'react-intl';
import { ApiError } from './api-client.js';

export function toMessageValues(params?: Record<string, unknown>): Record<string, string | number> {
  if (!params) return {};

  return Object.fromEntries(
    Object.entries(params).filter(([, value]) => typeof value === 'string' || typeof value === 'number'),
  ) as Record<string, string | number>;
}

export function localizeApiError(intl: IntlShape, error: unknown, fallbackId: string): string {
  if (error instanceof ApiError) {
    try {
      return intl.formatMessage(
        { id: error.code, defaultMessage: error.message },
        toMessageValues(error.params),
      );
    } catch {
      return error.message;
    }
  }

  if (error instanceof Error) {
    return error.message;
  }

  return intl.formatMessage({ id: fallbackId });
}