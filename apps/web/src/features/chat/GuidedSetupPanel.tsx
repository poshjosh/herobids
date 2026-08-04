import { useGuidedSetup } from './useGuidedSetup.js';
import { GuidedSetupThread } from './GuidedSetupThread.js';

interface GuidedSetupPanelProps {
  /** Called when the user wants to switch to the form-based flow */
  onSwitchToForm: () => void;
  /** Called when an agent is successfully created */
  onAgentCreated?: (agentId: string) => void;
}

/**
 * Embedded Guided Setup chat surface for the agent creation page.
 *
 * v1 scope: Single-purpose — guide users through the create-agent workflow.
 * The UI label is "Guided Setup" — not "Chat With AI."
 */
export function GuidedSetupPanel({ onSwitchToForm, onAgentCreated }: GuidedSetupPanelProps) {
  const {
    thread,
    messages,
    loading,
    error,
    sending,
    sendMessage,
    startOver,
  } = useGuidedSetup();

  const handleQuickReply = (value: string) => {
    if (value === 'action:use_form') {
      onSwitchToForm();
      return;
    }
    // Treat quick-reply selections as user messages
    sendMessage(value);
  };

  // Show loading state
  if (loading && messages.length === 0) {
    return (
      <div
        style={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          height: '100%',
          color: 'var(--color-text-muted)',
          fontSize: 15,
        }}
      >
        <span style={{ animation: 'pulse 1.5s infinite' }}>●</span>
        &nbsp;Starting Guided Setup...
      </div>
    );
  }

  // Show error state
  if (error && messages.length === 0) {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
          height: '100%',
          gap: 16,
          padding: 32,
        }}
      >
        <div style={{ color: 'var(--color-error)', fontSize: 15, textAlign: 'center' }}>
          {error}
        </div>
        <button
          onClick={startOver}
          style={{
            padding: '10px 24px',
            borderRadius: 8,
            border: 'none',
            backgroundColor: 'var(--color-primary)',
            color: 'var(--color-on-primary)',
            fontSize: 14,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Try Again
        </button>
        <button
          onClick={onSwitchToForm}
          style={{
            padding: '8px 16px',
            borderRadius: 8,
            border: '1px solid var(--color-border)',
            backgroundColor: 'transparent',
            color: 'var(--color-text)',
            fontSize: 14,
            cursor: 'pointer',
          }}
        >
          Use the form instead
        </button>
      </div>
    );
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        borderRadius: 10,
        overflow: 'hidden',
        border: '1px solid var(--color-border)',
        backgroundColor: 'var(--color-surface-1)',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '12px 20px',
          borderBottom: '1px solid var(--color-border)',
          backgroundColor: 'var(--color-surface-1)',
        }}
      >
        <div>
          <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--color-text)' }}>
            Guided Setup
          </span>
          <span
            style={{
              marginLeft: 8,
              fontSize: 11,
              color: 'var(--color-text-muted)',
              backgroundColor: 'var(--color-surface-2)',
              padding: '2px 8px',
              borderRadius: 10,
            }}
          >
            powered by AI
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={startOver}
            title="Start over"
            style={{
              padding: '6px 12px',
              fontSize: 13,
              borderRadius: 6,
              border: '1px solid var(--color-border)',
              backgroundColor: 'transparent',
              color: 'var(--color-text)',
              cursor: 'pointer',
            }}
          >
            Start over
          </button>
          <button
            onClick={onSwitchToForm}
            title="Use the form instead"
            style={{
              padding: '6px 12px',
              fontSize: 13,
              borderRadius: 6,
              border: '1px solid var(--color-border)',
              backgroundColor: 'transparent',
              color: 'var(--color-text-muted)',
              cursor: 'pointer',
            }}
          >
            Use form
          </button>
        </div>
      </div>

      {/* Chat thread */}
      <GuidedSetupThread
        messages={messages}
        onSend={sendMessage}
        onQuickReply={handleQuickReply}
        sending={sending}
      />
    </div>
  );
}
