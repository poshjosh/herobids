import { useEffect } from 'react';
import type { MutableRefObject } from 'react';
import { useGuidedSetup } from './useGuidedSetup.js';
import { GuidedSetupThread } from './GuidedSetupThread.js';

interface GuidedSetupPanelProps {
  /** Called when an agent is successfully created */
  onAgentCreated?: (agentId: string) => void;
  /**
   * Receives the startOver callback so a parent (e.g. the create-flow header)
   * can trigger a fresh guided thread from outside the panel.
   */
  startOverRef?: MutableRefObject<(() => void) | null>;
}

/**
 * Embedded Guided Setup chat surface for the agent creation page.
 *
 * v1 scope: Single-purpose — guide users through the create-agent workflow.
 */
export function GuidedSetupPanel({ onAgentCreated, startOverRef }: GuidedSetupPanelProps) {
  const {
    thread,
    messages,
    loading,
    error,
    sending,
    sendMessage,
    submitActionResult,
    startOver,
  } = useGuidedSetup();

  // Expose startOver to the parent so the header refresh icon can reset the thread.
  useEffect(() => {
    if (startOverRef) {
      startOverRef.current = startOver;
    }
  }, [startOver, startOverRef]);

  const handleQuickReply = (value: string) => {
    // Treat quick-reply selections as user messages
    sendMessage(value);
  };

  const handleFormSubmit = (actionId: string, result: unknown) => {
    submitActionResult(actionId, result);
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
        &nbsp;Starting chat...
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
      </div>
    );
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: 'min(520px, 60vh)',
        borderRadius: 10,
        overflow: 'hidden',
        border: '1px solid var(--color-border)',
        backgroundColor: 'var(--color-surface-1)',
      }}
    >
      {/* Chat thread */}
      <GuidedSetupThread
        messages={messages}
        onSend={sendMessage}
        onQuickReply={handleQuickReply}
        onFormSubmit={handleFormSubmit}
        sending={sending}
      />
    </div>
  );
}
