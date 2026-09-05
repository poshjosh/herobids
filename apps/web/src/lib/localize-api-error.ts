import type { IntlShape } from 'react-intl';
import { ApiError, type ApiErrorDetail } from './api-client.js';

export function toMessageValues(params?: Record<string, unknown>): Record<string, string | number> {
  if (!params) return {};

  return Object.fromEntries(
    Object.entries(params).filter(([, value]) => typeof value === 'string' || typeof value === 'number'),
  ) as Record<string, string | number>;
}

/** Render a validation issue as `field: message`, or just the message when no path. */
function formatDetail(detail: ApiErrorDetail): string {
  const field = detail.path.join('.');
  return field ? `${field}: ${detail.message}` : detail.message;
}

/** Join a localized prefix and a suffix without producing a double separator. */
function joinWithDetail(prefix: string, suffix: string): string {
  const trimmed = prefix.replace(/[.:\s]+$/, '');
  return `${trimmed}: ${suffix}`;
}

export function localizeApiError(intl: IntlShape, error: unknown, fallbackId: string): string {
  if (error instanceof ApiError) {
    try {
      const localized = intl.formatMessage(
        { id: error.code, defaultMessage: error.message },
        toMessageValues(error.params),
      );
      if (error.code === 'validation_error') {
        const detailText = error.details && error.details.length > 0
          ? error.details.map(formatDetail).join('; ')
          : error.message;
        if (detailText && detailText !== localized) {
          return joinWithDetail(localized, detailText);
        }
      }
      return localized;
    } catch {
      return error.message;
    }
  }

  if (error instanceof Error) {
    return error.message;
  }

  return intl.formatMessage({ id: fallbackId });
}