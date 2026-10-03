import type { IntlShape } from 'react-intl';

export function formatShortDate(intl: IntlShape, iso: string | null): string {
  if (!iso) {
    return '—';
  }

  return intl.formatDate(new Date(iso), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function formatCurrencyFromCents(
  intl: IntlShape,
  amountCents: number | null,
  currency = 'USD',
): string | null {
  if (amountCents == null) {
    return null;
  }

  return intl.formatNumber(amountCents / 100, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}