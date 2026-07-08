import { useState, useEffect } from 'react';

/** Debounces a value by `delayMs`. Returns the initial value immediately, then only updates after `delayMs` of inactivity. */
export function useDebounce<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timeout = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timeout);
  }, [value, delayMs]);
  return debounced;
}
