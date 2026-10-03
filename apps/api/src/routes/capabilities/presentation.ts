/**
 * Capability-presentation contract — the generic (capability-agnostic) response
 * shape the web renders WITHOUT any trading semantics. Emphasis is computed
 * server-side so the web only maps `emphasis` → theme tokens.
 *
 * Traderton boundary stays the source of the trading values; this module owns
 * only the wire types (no trading logic).
 */

export type CapabilityPresentationEmphasis = 'neutral' | 'positive' | 'negative' | 'warning';

/** Relative visual weight the web uses to lay out an attribute or feed. */
export type CapabilityProminence = 'primary' | 'secondary';

/**
 * A single display cell. `value` is the already-formatted English string the
 * web renders VERBATIM — the web never parses, re-formats, or inspects it to
 * derive meaning. `valueKey` (with optional `valueParams`) lets the web swap in
 * a localized string when the key is present in its catalog, falling back to
 * `value` otherwise. `emphasis` is the only semantic signal the web acts on,
 * mapping to a theme token (text colour only).
 */
export type CapabilityCell = {
  value: string;
  valueKey?: string;
  valueParams?: Record<string, string>;
  emphasis?: CapabilityPresentationEmphasis;
};

export type CapabilityFeedColumn = {
  key: string;
  label: string;
  labelKey?: string;
  align: 'start' | 'end';
  format: 'text' | 'timestamp';
};

export type CapabilityAttribute = {
  key: string;
  label: string;
  value: string;
  emphasis?: CapabilityPresentationEmphasis;
  labelKey?: string;
  valueKey?: string;
  valueParams?: Record<string, string>;
  prominence?: CapabilityProminence;
};

export type CapabilityFeedItem = {
  id: string;
  title: string;
  detail?: string;
  occurredAt: string;
  emphasis?: CapabilityPresentationEmphasis;
  cells?: Record<string, CapabilityCell>;
  titleKey?: string;
  badge?: CapabilityCell;
};

export type CapabilityFeed = {
  key: string;
  label: string;
  items: CapabilityFeedItem[];
  /** Full cursor pagination is future work — omitted for the first cut. */
  nextCursor?: string;
  labelKey?: string;
  prominence?: CapabilityProminence;
  columns?: CapabilityFeedColumn[];
};

export type CapabilityConnection = {
  id: string;
  label: string;
  // `'unavailable'` is reserved for future use — the endpoint emits `connection: null` today when no usable binding exists.
  state: 'ready' | 'unavailable';
};

export type CapabilityPresentation = {
  family: string;
  connection: CapabilityConnection | null;
  attributes: CapabilityAttribute[];
  feeds: CapabilityFeed[];
};