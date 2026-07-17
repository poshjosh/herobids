import { Children, isValidElement, cloneElement, Fragment } from 'react';
import type { ReactNode } from 'react';

/** Matches the wordmark accent color in BrandLogo.tsx. */
const BRAND_ACCENT = '#635BFF';

/**
 * Recursively walks rendered React children and replaces every occurrence
 * of "OpenAIdom" in text nodes with a styled version where "AI" is colored.
 *
 * Skips `<code>` and `<pre>` elements to keep code blocks verbatim.
 *
 * Zero dependencies — no plugins or libraries needed.
 */
export function Brandify({ children }: { children: ReactNode }): ReactNode {
  if (typeof children === 'string') {
    const parts = children.split(/(OpenAIdom)/g);
    if (parts.length === 1) return children;
    return parts.map((part, i) =>
      part === 'OpenAIdom' ? (
        <Fragment key={i}>
          Open
          <span style={{ color: BRAND_ACCENT }} aria-hidden="true">
            AI
          </span>
          dom
        </Fragment>
      ) : (
        part
      ),
    );
  }

  if (isValidElement(children)) {
    const tag = typeof children.type === 'string' ? children.type : '';
    // Don't descend into code blocks — keep them verbatim
    if (tag === 'code' || tag === 'pre') return children;

    const branded = Children.map(children.props.children, (child) => (
      <Brandify>{child}</Brandify>
    ));
    return cloneElement(children, {}, ...(branded ?? []));
  }

  return children;
}
