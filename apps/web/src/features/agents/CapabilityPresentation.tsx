import { useIntl, type IntlShape } from 'react-intl';
import { RelativeTime } from '../../lib/ui.js';
import type {
  CapabilityAttribute,
  CapabilityCell,
  CapabilityFeed,
  CapabilityFeedColumn,
  CapabilityFeedItem,
  CapabilityPresentationEmphasis,
  CapabilityProminence,
} from '../../lib/api-client.js';

// Re-export the wire types from api-client so this generic component is NOT a
// second source of truth for the presentation contract. Importers that pull
// `CapabilityAttribute`/`CapabilityFeed`/etc. from here keep working unchanged.
export type {
  CapabilityAttribute,
  CapabilityCell,
  CapabilityFeed,
  CapabilityFeedColumn,
  CapabilityFeedItem,
  CapabilityPresentationEmphasis,
  CapabilityProminence,
};

const EMPHASIS_TOKENS: Record<CapabilityPresentationEmphasis, { background: string; color: string }> = {
  neutral: { background: 'var(--color-surface-2)', color: 'var(--color-text-primary)' },
  positive: { background: 'var(--color-success-subtle)', color: 'var(--color-success)' },
  negative: { background: 'var(--color-danger-subtle)', color: 'var(--color-danger)' },
  warning: { background: 'var(--color-warning-subtle)', color: 'var(--color-warning)' },
};

function emphasisStyle(emphasis: CapabilityPresentationEmphasis | undefined): { background: string; color: string } {
  return EMPHASIS_TOKENS[emphasis ?? 'neutral'];
}

function emphasisColor(emphasis: CapabilityPresentationEmphasis | undefined): string {
  return EMPHASIS_TOKENS[emphasis ?? 'neutral'].color;
}

// The web NEVER inspects or parses a value. It only localizes via the server's
// key (when present in the catalog) and otherwise renders the server's English
// `value`/`label` verbatim. `intl.messages` is checked first so react-intl does
// not emit missing-key console errors for keys this locale does not carry.
function localizeText(
  intl: IntlShape,
  key: string | undefined,
  fallback: string,
  params?: Record<string, string>,
): string {
  if (key && intl.messages[key]) {
    return intl.formatMessage({ id: key }, params);
  }
  return fallback;
}

export function CapabilityAttributes({ attributes }: { attributes: CapabilityAttribute[] }) {
  const intl = useIntl();
  if (attributes.length === 0) return null;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '8px' }}>
      {attributes.map((attribute) => {
        const colors = emphasisStyle(attribute.emphasis);
        const label = localizeText(intl, attribute.labelKey, attribute.label);
        const value = localizeText(intl, attribute.valueKey, attribute.value, attribute.valueParams);
        return (
          <div
            key={attribute.key}
            style={{
              border: '1px solid var(--color-border)',
              borderRadius: '8px',
              padding: '10px 12px',
              background: colors.background,
              minWidth: 0,
            }}
          >
            <div style={{ color: 'var(--color-text-muted)', fontSize: '0.6875rem', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              {label}
            </div>
            <div style={{ color: colors.color, fontSize: '0.8125rem', fontWeight: '600', marginTop: '4px', overflowWrap: 'anywhere' }}>
              {value}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function CapabilityOverview({ attributes }: { attributes: CapabilityAttribute[] }) {
  const intl = useIntl();
  if (attributes.length === 0) return null;

  const primary = attributes.filter((attribute) => attribute.prominence !== 'secondary');
  const secondary = attributes.filter((attribute) => attribute.prominence === 'secondary');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {primary.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '8px' }}>
          {primary.map((attribute) => {
            const label = localizeText(intl, attribute.labelKey, attribute.label);
            const value = localizeText(intl, attribute.valueKey, attribute.value, attribute.valueParams);
            return (
              <div
                key={attribute.key}
                style={{
                  border: '1px solid var(--color-border)',
                  borderRadius: '8px',
                  padding: '14px 16px',
                  background: 'var(--color-surface-2)',
                  minWidth: 0,
                }}
              >
                <div style={{ color: 'var(--color-text-muted)', fontSize: '0.6875rem', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                  {label}
                </div>
                <div
                  style={{
                    color: emphasisColor(attribute.emphasis),
                    fontSize: '1.25rem',
                    fontWeight: '600',
                    fontFamily: 'var(--font-mono, monospace)',
                    marginTop: '6px',
                    overflowWrap: 'anywhere',
                  }}
                >
                  {value}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {secondary.length > 0 && (
        <details>
          <summary style={{ cursor: 'pointer', color: 'var(--color-text-secondary)', fontSize: '0.8125rem', fontWeight: '600' }}>
            {localizeText(intl, 'capability.details', 'Details')}
          </summary>
          <div style={{ marginTop: '8px' }}>
            <CapabilityAttributes attributes={secondary} />
          </div>
        </details>
      )}
    </div>
  );
}

function CapabilityFeedTable({ feed, label }: { feed: CapabilityFeed; label: string }) {
  const intl = useIntl();
  const columns = feed.columns ?? [];

  return (
    <div role="region" aria-label={label} tabIndex={0} style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8125rem' }}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                style={{
                  textAlign: column.align === 'end' ? 'right' : 'left',
                  padding: '6px 10px',
                  color: 'var(--color-text-muted)',
                  fontSize: '0.6875rem',
                  fontWeight: '600',
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  borderBottom: '1px solid var(--color-border)',
                  whiteSpace: 'nowrap',
                }}
              >
                {localizeText(intl, column.labelKey, column.label)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {feed.items.map((item) => (
            <tr key={item.id}>
              {columns.map((column) => (
                <CapabilityFeedTableCell key={column.key} intl={intl} column={column} item={item} />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CapabilityFeedTableCell({
  intl,
  column,
  item,
}: {
  intl: IntlShape;
  column: CapabilityFeedColumn;
  item: CapabilityFeedItem;
}) {
  const alignEnd = column.align === 'end';
  const baseStyle: React.CSSProperties = {
    padding: '8px 10px',
    borderBottom: '1px solid var(--color-border)',
    textAlign: alignEnd ? 'right' : 'left',
    verticalAlign: 'top',
    ...(alignEnd ? { fontFamily: 'var(--font-mono, monospace)', whiteSpace: 'nowrap' } : {}),
  };

  const cell = item.cells?.[column.key];

  if (column.format === 'timestamp') {
    const iso = cell?.value ?? null;
    return (
      <td style={baseStyle} title={iso ?? undefined}>
        <RelativeTime timestamp={iso} />
      </td>
    );
  }

  if (!cell) {
    return <td style={baseStyle}>—</td>;
  }

  const value = localizeText(intl, cell.valueKey, cell.value, cell.valueParams);
  return (
    <td style={{ ...baseStyle, color: emphasisColor(cell.emphasis) }}>{value}</td>
  );
}

function CapabilityFeedList({ feed }: { feed: CapabilityFeed }) {
  const intl = useIntl();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      {feed.items.map((item) => {
        const colors = emphasisStyle(item.emphasis);
        const title = localizeText(intl, item.titleKey, item.title);
        return (
          <article key={item.id} style={{ border: '1px solid var(--color-border)', borderRadius: '8px', padding: '10px 12px', background: colors.background }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '12px' }}>
              <strong style={{ color: colors.color, fontSize: '0.8125rem', overflowWrap: 'anywhere' }}>{title}</strong>
              <span style={{ display: 'flex', alignItems: 'baseline', gap: '8px', flexShrink: 0 }}>
                {item.badge && (
                  <span style={{ color: emphasisColor(item.badge.emphasis), fontSize: '0.6875rem', fontWeight: '600' }}>
                    {localizeText(intl, item.badge.valueKey, item.badge.value, item.badge.valueParams)}
                  </span>
                )}
                <span style={{ color: 'var(--color-text-muted)', fontSize: '0.6875rem' }}><RelativeTime timestamp={item.occurredAt} /></span>
              </span>
            </div>
            {item.detail && <div style={{ color: 'var(--color-text-secondary)', fontSize: '0.75rem', lineHeight: '1.5', marginTop: '4px', overflowWrap: 'anywhere' }}>{item.detail}</div>}
          </article>
        );
      })}
    </div>
  );
}

function CapabilityFeedBody({ feed, label }: { feed: CapabilityFeed; label: string }) {
  const intl = useIntl();

  if (feed.items.length === 0) {
    return <p style={{ color: 'var(--color-text-muted)', fontSize: '0.8125rem', margin: 0 }}>{localizeText(intl, 'capability.feed.empty', 'No items yet.')}</p>;
  }

  if (feed.columns && feed.columns.length > 0) {
    return <CapabilityFeedTable feed={feed} label={label} />;
  }

  return <CapabilityFeedList feed={feed} />;
}

export function CapabilityFeeds({ feeds }: { feeds: CapabilityFeed[] }) {
  const intl = useIntl();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {feeds.map((feed) => {
        const label = localizeText(intl, feed.labelKey, feed.label);

        if (feed.prominence === 'secondary') {
          return (
            <details key={feed.key}>
              <summary style={{ cursor: 'pointer', color: 'var(--color-text-secondary)', fontSize: '0.75rem', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                {label}
              </summary>
              <div style={{ marginTop: '8px' }}>
                <CapabilityFeedBody feed={feed} label={label} />
              </div>
            </details>
          );
        }

        return (
          <section key={feed.key} aria-label={label}>
            <div style={{ color: 'var(--color-text-secondary)', fontSize: '0.75rem', fontWeight: '600', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              {label}
            </div>
            <CapabilityFeedBody feed={feed} label={label} />
          </section>
        );
      })}
    </div>
  );
}
