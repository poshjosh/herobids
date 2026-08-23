import { useState, useRef, useEffect, useCallback } from 'react';
import { useIntl } from 'react-intl';
import { useLocale } from '../app/i18n/I18nProvider.js';
import type { SupportedLocale } from '../app/i18n/resolveLocale.js';

/** Native-language display name for each supported locale. */
const LOCALE_DISPLAY_NAMES: Record<SupportedLocale, string> = {
  en: 'English',
  ar: 'العربية',
  hi: 'हिन्दी',
};

interface LocalePickerButtonProps {
  /** Called after the user selects a locale. Use for navigation side-effects. */
  onLocaleChange?: (locale: SupportedLocale) => void;
}

/**
 * A globe-icon button that toggles a locale selection popover.
 * Handles outside-click dismiss, keyboard navigation, and ARIA attributes.
 */
export function LocalePickerButton({ onLocaleChange }: LocalePickerButtonProps) {
  const intl = useIntl();
  const { locale, setLocale, supportedLocales } = useLocale();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  // Close on Escape; arrow-key navigation inside the list
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        return;
      }
      if (!open) return;
      const items = listRef.current?.querySelectorAll<HTMLLIElement>('[role="option"]');
      if (!items?.length) return;
      const focused = document.activeElement as HTMLElement;
      const idx = Array.from(items).indexOf(focused as HTMLLIElement);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const next = idx < items.length - 1 ? idx + 1 : 0;
        items[next]?.focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const prev = idx > 0 ? idx - 1 : items.length - 1;
        items[prev]?.focus();
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (focused.dataset.locale) {
          selectLocale(focused.dataset.locale as SupportedLocale);
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open],
  );

  function selectLocale(next: SupportedLocale) {
    setLocale(next);
    setOpen(false);
    onLocaleChange?.(next);
  }

  const ariaLabel = intl.formatMessage({ id: 'localePicker.label' });

  return (
    <div ref={containerRef} style={{ position: 'relative', display: 'inline-block' }} onKeyDown={handleKeyDown}>
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={ariaLabel}
        onClick={() => setOpen((v) => !v)}
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: '4px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: '6px',
          color: 'var(--color-text-secondary)',
        }}
      >
        {/* Globe icon (Lucide-style) */}
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="10" />
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
          <path d="M2 12h20" />
        </svg>
      </button>

      {open && (
        <ul
          ref={listRef}
          role="listbox"
          aria-label={ariaLabel}
          style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            marginTop: '4px',
            padding: '4px 0',
            minWidth: '120px',
            background: 'var(--color-surface-1)',
            border: '1px solid var(--color-border)',
            borderRadius: '8px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
            listStyle: 'none',
            zIndex: 100,
          }}
        >
          {supportedLocales.map((loc) => (
            <li
              key={loc}
              role="option"
              aria-selected={loc === locale}
              data-locale={loc}
              tabIndex={0}
              onClick={() => selectLocale(loc)}
              style={{
                padding: '8px 14px',
                cursor: 'pointer',
                fontSize: '0.8125rem',
                fontWeight: loc === locale ? '600' : '400',
                color: loc === locale ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                background: loc === locale ? 'var(--color-surface-2, var(--color-surface-0))' : 'transparent',
              }}
            >
              {LOCALE_DISPLAY_NAMES[loc]}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
