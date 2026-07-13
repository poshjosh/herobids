import { useState, type CSSProperties } from 'react';
import { COMPACT_MARK } from './tokens.js';

// ─── Public Types ────────────────────────────────────────────────────────────

export type BrandDisplay = 'mark' | 'wordmark' | 'full';
export type BrandVariant = 'dark' | 'light' | 'auto';
export type BrandSize = 'sm' | 'md' | 'lg';

export interface BrandLogoProps {
  /** What to display: compact mark, wordmark, or both (wordmark collapses on mobile). */
  display?: BrandDisplay;
  /** Color scheme variant for image assets. `auto` uses prefers-color-scheme. */
  variant?: BrandVariant;
  /** Size preset. */
  size?: BrandSize;
  /** Optional URL — wraps the logo in an anchor element for navigation. */
  linkTo?: string;
  /** Additional CSS class for the outermost wrapper element. */
  className?: string;
}

// ─── Sizing ──────────────────────────────────────────────────────────────────

const SIZE_MAP: Record<BrandSize, { mark: number; wordmarkHeight: number }> = {
  sm:  { mark: 24, wordmarkHeight: 16 },
  md:  { mark: 32, wordmarkHeight: 22 },
  lg:  { mark: 48, wordmarkHeight: 32 },
};

// ─── Typographic Fallback ────────────────────────────────────────────────────
// Per tokens.ts: accent on dark backgrounds, primary on light backgrounds.

const TYPOGRAPHIC_STYLE: CSSProperties = {
  fontFamily:
    "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif",
  fontWeight: 700,
  letterSpacing: '-0.02em',
  lineHeight: 1,
};

function resolveTypographicColor(variant: BrandVariant): string {
  if (variant === 'light') {
    return 'var(--brand-primary, #101828)';
  }
  // dark or auto — assume dark surface
  return 'var(--brand-accent, #635BFF)';
}

// ─── Component ───────────────────────────────────────────────────────────────

export function BrandLogo({
  display = 'full',
  variant = 'auto',
  size = 'md',
  linkTo,
  className,
}: BrandLogoProps) {
  const showMark = display === 'mark' || display === 'full';
  const showWordmark = display === 'wordmark' || display === 'full';

  const logoContent = (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: size === 'sm' ? '6px' : size === 'md' ? '8px' : '12px',
        whiteSpace: 'nowrap',
      }}
    >
      {showMark && (
        <BrandMark
          variant={variant}
          size={size}
        />
      )}
      {showWordmark && (
        <BrandWordmark
          variant={variant}
          size={size}
          responsive={display === 'full'}
        />
      )}
    </span>
  );

  if (linkTo) {
    return (
      <a
        href={linkTo}
        className={className}
        style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}
        aria-label="OpenAIdom"
      >
        {logoContent}
      </a>
    );
  }

  return (
    <span className={className} style={{ display: 'inline-flex', alignItems: 'center' }}>
      {logoContent}
    </span>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function BrandMark({ variant, size }: { variant: BrandVariant; size: BrandSize }) {
  const [failed, setFailed] = useState(false);
  const dims = SIZE_MAP[size];

  if (failed) {
    return <TypographicMark size={size} variant={variant} />;
  }

  // Single mark asset — CSS filter handles dark/light visibility.
  // brightness(0) = pure black silhouette on light surfaces.
  // brightness(0) invert(1) = pure white silhouette on dark surfaces.
  const needsWhiteFilter = variant !== 'light';

  const img = (
    <img
      src={COMPACT_MARK}
      alt="OpenAIdom"
      style={{
        width: dims.mark,
        height: dims.mark,
        display: 'block',
        filter: needsWhiteFilter ? 'brightness(0) invert(1)' : 'brightness(0)',
      }}
      onError={() => setFailed(true)}
    />
  );

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>
      {img}
    </span>
  );
}

function BrandWordmark({
  variant,
  size,
  responsive,
}: {
  variant: BrandVariant;
  size: BrandSize;
  responsive: boolean;
}) {
  // Use typographic wordmark always — the source logo PNG is a combined
  // icon+text image, not a text-only wordmark, so rendering it alongside
  // the compact mark produces "logo + logo" instead of "logo + text".
  return <TypographicWordmark size={size} variant={variant} responsive={responsive} />;
}

// ─── Typographic Fallback Components ─────────────────────────────────────────

function TypographicMark({ size, variant }: { size: BrandSize; variant: BrandVariant }) {
  const color = resolveTypographicColor(variant);
  const fontSize = size === 'sm' ? '14px' : size === 'md' ? '20px' : '30px';

  return (
    <span
      role="img"
      style={{
        ...TYPOGRAPHIC_STYLE,
        fontSize,
        color,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: SIZE_MAP[size].mark,
        height: SIZE_MAP[size].mark,
        flexShrink: 0,
      }}
      aria-label="OpenAIdom"
    >
      <span aria-hidden="true">OD</span>
    </span>
  );
}

function TypographicWordmark({
  size,
  variant,
  responsive,
}: {
  size: BrandSize;
  variant: BrandVariant;
  responsive: boolean;
}) {
  const color = resolveTypographicColor(variant);
  const fontSize = size === 'sm' ? '14px' : size === 'md' ? '18px' : '24px';
  const className = ['brand-wordmark', responsive && 'brand-wordmark-responsive'].filter(Boolean).join(' ');

  return (
    <span
      className={className}
      style={{
        ...TYPOGRAPHIC_STYLE,
        fontSize,
        color,
      }}
    >
      OpenAIdom
    </span>
  );
}
