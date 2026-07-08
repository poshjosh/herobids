import type { IntlShape } from 'react-intl';
import Decimal from 'decimal.js';

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

export function formatPnl(pnl: string | number | null | undefined): string {
  if (pnl == null) return '—';
  const d = new Decimal(pnl);
  const absValue = d.abs().toFixed(2);
  return d.gte(0) ? `+$${absValue}` : `-$${absValue}`;
}

export function pnlColor(pnl: string | number | null | undefined): string {
  if (pnl == null) return 'var(--color-text-muted)';
  const d = new Decimal(pnl);
  if (d.gt(0)) return 'var(--color-success)';
  if (d.lt(0)) return 'var(--color-danger)';
  return 'var(--color-text)';
}