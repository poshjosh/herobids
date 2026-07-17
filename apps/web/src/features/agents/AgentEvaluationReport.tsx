import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { brandifyTag } from '../../lib/brandify.js';

/**
 * Renders an evaluation REPORT.md inline as formatted markdown.
 * Lazy-loaded — only renders when the user expands the report viewer.
 * Scrolled within a constrained height for long reports.
 */
export function AgentEvaluationReport({ content }: { content: string }) {
  return (
    <div
      style={{
        padding: '16px',
        background: 'var(--color-surface-2)',
        borderRadius: '8px',
        maxHeight: '60vh',
        overflow: 'auto',
      }}
    >
      <div className="prose prose-invert">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            p: brandifyTag('p'),
            li: brandifyTag('li'),
            td: brandifyTag('td'),
            th: brandifyTag('th'),
            a: brandifyTag('a'),
            h1: brandifyTag('h1'),
            h2: brandifyTag('h2'),
            h3: brandifyTag('h3'),
          }}
        >
          {content}
        </ReactMarkdown>
      </div>
    </div>
  );
}
