import { useState, type CSSProperties } from 'react';
import {
  WORDMARK_LIGHT,
  WORDMARK_DARK,
  COMPACT_MARK_LIGHT,
  COMPACT_MARK_DARK,
} from './tokens.js';

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

  const darkAsset = COMPACT_MARK_LIGHT; // light mark = for dark surfaces
  const lightAsset = COMPACT_MARK_DARK; // dark mark = for light surfaces

  const src = variant === 'dark' ? darkAsset : variant === 'light' ? lightAsset : lightAsset;

  const img = (
    <img
      src={src}
      alt="OpenAIdom"
      style={{ width: dims.mark, height: dims.mark, display: 'block' }}
      onError={() => setFailed(true)}
    />
  );

  if (variant !== 'auto') {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>
        {img}
      </span>
    );
  }

  // auto: use <picture> with prefers-color-scheme
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>
      <picture>
        <source srcSet={lightAsset} media="(prefers-color-scheme: light)" />
        <source srcSet={darkAsset} media="(prefers-color-scheme: dark)" />
        {img}
      </picture>
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
  const [failed, setFailed] = useState(false);
  const dims = SIZE_MAP[size];

  if (failed) {
    return <TypographicWordmark size={size} variant={variant} responsive={responsive} />;
  }

  const darkAsset = WORDMARK_LIGHT; // light wordmark = for dark surfaces
  const lightAsset = WORDMARK_DARK; // dark wordmark = for light surfaces

  const src = variant === 'dark' ? darkAsset : variant === 'light' ? lightAsset : lightAsset;

  const img = (
    <img
      src={src}
      alt="OpenAIdom"
      style={{ height: dims.wordmarkHeight, width: 'auto', display: 'block' }}
      onError={() => setFailed(true)}
    />
  );

  const className = ['brand-wordmark', responsive && 'brand-wordmark-responsive'].filter(Boolean).join(' ');

  if (variant !== 'auto') {
    return (
      <span className={className}>
        {img}
      </span>
    );
  }

  // auto: use <picture> with prefers-color-scheme
  return (
    <span className={className}>
      <picture>
        <source srcSet={lightAsset} media="(prefers-color-scheme: light)" />
        <source srcSet={darkAsset} media="(prefers-color-scheme: dark)" />
        {img}
      </picture>
    </span>
  );
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
