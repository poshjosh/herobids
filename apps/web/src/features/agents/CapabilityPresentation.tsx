import { RelativeTime } from '../../lib/ui.js';
import type {
  CapabilityAttribute,
  CapabilityFeed,
  CapabilityFeedItem,
  CapabilityPresentationEmphasis,
} from '../../lib/api-client.js';

// Re-export the wire types from api-client so this generic component is NOT a
// second source of truth for the presentation contract. Importers that pull
// `CapabilityAttribute`/`CapabilityFeed`/etc. from here keep working unchanged.
export type {
  CapabilityAttribute,
  CapabilityFeed,
  CapabilityFeedItem,
  CapabilityPresentationEmphasis,
};

const EMPHASIS_TOKENS: Record<CapabilityPresentationEmphasis, { background: string; color: string }> = {
  neutral: { background: 'var(--color-surface-2)', color: 'var(--color-text-primary)' },
  positive: { background: 'var(--color-success-subtle)', color: 'var(--color-success)' },
  negative: { background: 'var(--color-danger-subtle)', color: 'var(--color-danger)' },
  warning: { background: 'var(--color-warning-subtle)', color: 'var(--color-warning)' },
};

function emphasisStyle(emphasis: CapabilityPresentationEmphasis | undefined): React.CSSProperties {
  return EMPHASIS_TOKENS[emphasis ?? 'neutral'];
}

export function CapabilityAttributes({ attributes }: { attributes: CapabilityAttribute[] }) {
  if (attributes.length === 0) return null;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '8px' }}>
      {attributes.map((attribute) => {
        const colors = emphasisStyle(attribute.emphasis);
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
              {attribute.label}
            </div>
            <div style={{ color: colors.color, fontSize: '0.8125rem', fontWeight: '600', marginTop: '4px', overflowWrap: 'anywhere' }}>
              {attribute.value}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function CapabilityFeeds({ feeds }: { feeds: CapabilityFeed[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {feeds.map((feed) => (
        <section key={feed.key} aria-label={feed.label}>
          <div style={{ color: 'var(--color-text-secondary)', fontSize: '0.75rem', fontWeight: '600', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            {feed.label}
          </div>
          {feed.items.length === 0 ? (
            <p style={{ color: 'var(--color-text-muted)', fontSize: '0.8125rem', margin: 0 }}>No items yet.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {feed.items.map((item) => {
                const colors = emphasisStyle(item.emphasis);
                return (
                  <article key={item.id} style={{ border: '1px solid var(--color-border)', borderRadius: '8px', padding: '10px 12px', background: colors.background }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '12px' }}>
                      <strong style={{ color: colors.color, fontSize: '0.8125rem', overflowWrap: 'anywhere' }}>{item.title}</strong>
                      <span style={{ color: 'var(--color-text-muted)', fontSize: '0.6875rem', flexShrink: 0 }}><RelativeTime timestamp={item.occurredAt} /></span>
                    </div>
                    {item.detail && <div style={{ color: 'var(--color-text-secondary)', fontSize: '0.75rem', lineHeight: '1.5', marginTop: '4px', overflowWrap: 'anywhere' }}>{item.detail}</div>}
                  </article>
                );
              })}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}