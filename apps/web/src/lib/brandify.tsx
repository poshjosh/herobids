import { Children, isValidElement, cloneElement, Fragment, createElement } from 'react';
import type { ReactNode, HTMLAttributes, ComponentType } from 'react';

/** Matches the wordmark accent color in BrandLogo.tsx. */
const BRAND_ACCENT = '#635BFF';

/**
 * Recursively walks rendered React children:
 * 1. Colors "AI" in every "OpenAIdom" text occurrence.
 * 2. Converts `backtick-wrapped` text to <code> elements.
 *
 * Skips React components (function/class), <code>, and <pre> elements.
 * Zero dependencies.
 */
export function Brandify({ children }: { children: ReactNode }): ReactNode {
  if (typeof children === 'string') {
    return transformText(children);
  }

  if (isValidElement(children)) {
    const tag = typeof children.type === 'string' ? children.type : '';
    // Skip React components — we can't safely clone them.
    if (!tag) return children;
    // Don't descend into code blocks — keep them verbatim.
    if (tag === 'code' || tag === 'pre') return children;

    const props: unknown = children.props;
    const childChildren =
      typeof props === 'object' && props !== null && 'children' in props
        ? (props as { children?: ReactNode }).children
        : undefined;
    const branded = Children.map(childChildren, (child) => (
      <Brandify>{child}</Brandify>
    ));
    return cloneElement(children, {}, ...(branded ?? []));
  }

  return children;
}

/**
 * Returns a component that renders the given HTML tag with its children
 * wrapped in <Brandify>. Use with react-markdown's `components` prop.
 *
 * @example
 *   const components = { p: brandifyTag('p'), li: brandifyTag('li') };
 */
export function brandifyTag<T extends HTMLElement>(
  tag: string,
): ComponentType<HTMLAttributes<T>> {
  return function Brandified({ children, ...props }: HTMLAttributes<T>) {
    return createElement(tag, props, <Brandify>{children}</Brandify>);
  };
}

/** Split on backtick segments, convert to <code>, brandify the rest. */
function transformText(text: string): ReactNode {
  const parts = text.split(/(`[^`]+`)/g);
  return parts.map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return <code key={`c${i}`}>{part.slice(1, -1)}</code>;
    }
    return brandifyText(part, `b${i}`);
  });
}

/** Color "AI" in every "OpenAIdom" occurrence. */
function brandifyText(text: string, keyBase: string): ReactNode {
  const parts = text.split(/(OpenAIdom)/g);
  if (parts.length === 1) return text;
  return parts.map((part, i) =>
    part === 'OpenAIdom' ? (
      <Fragment key={`${keyBase}-${i}`}>
        Open
        <span style={{ color: BRAND_ACCENT }} aria-hidden="true">AI</span>
        dom
      </Fragment>
    ) : (
      part
    ),
  );
}
