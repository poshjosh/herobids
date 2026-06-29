import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

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
        fontSize: '13px',
        lineHeight: '1.6',
        color: 'var(--color-text-primary)',
      }}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
