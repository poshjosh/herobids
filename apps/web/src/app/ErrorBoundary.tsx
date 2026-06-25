import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary] Uncaught error:', error, info.componentStack);
  }

  handleReset = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback;

      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: '100vh',
            padding: '32px',
            gap: '16px',
            fontFamily: 'system-ui, sans-serif',
            textAlign: 'center',
            background: 'var(--color-surface-1, #fff)',
          }}
        >
          <div style={{ fontSize: '48px' }}>⚠</div>
          <h1 style={{ fontSize: '20px', fontWeight: 600, color: 'var(--color-text-primary, #111)', margin: 0 }}>
            Something went wrong
          </h1>
          <p style={{ fontSize: '14px', color: 'var(--color-text-secondary, #666)', maxWidth: '480px', lineHeight: 1.5 }}>
            An unexpected error occurred. Please try refreshing the page.
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: '8px 20px',
              fontSize: '14px',
              fontWeight: 500,
              borderRadius: '6px',
              border: 'none',
              cursor: 'pointer',
              background: 'var(--color-brand, #6366f1)',
              color: '#fff',
            }}
          >
            Refresh page
          </button>
          {import.meta.env.DEV && (
            <pre
              style={{
                marginTop: '16px',
                padding: '16px',
                maxWidth: '640px',
                fontSize: '11px',
                textAlign: 'left',
                overflow: 'auto',
                background: 'var(--color-surface-2, #f5f5f5)',
                borderRadius: '8px',
                color: 'var(--color-text-secondary, #666)',
              }}
            >
              {this.state.error.stack ?? this.state.error.message}
            </pre>
          )}
        </div>
      );
    }

    return this.props.children;
  }
}
