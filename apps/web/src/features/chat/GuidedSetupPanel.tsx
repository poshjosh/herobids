import { useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useGuidedSetup } from './useGuidedSetup.js';
import { GuidedSetupThread } from './GuidedSetupThread.js';
import { loadGuidedSetupOAuthDraft, clearGuidedSetupOAuthDraft } from './guidedSetupOAuthDraft.js';
import { canUseGuidedSetup } from './canUseGuidedSetup.js';
import type { BillingGateResult } from './canUseGuidedSetup.js';
import * as api from '../../lib/api-client.js';

interface GuidedSetupPanelProps {
  /** Called when an agent is successfully created */
  onAgentCreated?: (agentId: string) => void;
  /**
   * Receives the startOver callback so a parent (e.g. the create-flow header)
   * can trigger a fresh guided thread from outside the panel.
   */
  startOverRef?: MutableRefObject<(() => void) | null>;
  /** Called when the user chooses to switch to the form-based creation flow */
  onSwitchToForm?: () => void;
}

/**
 * Embedded Guided Setup chat surface for the agent creation page.
 *
 * v1 scope: Single-purpose — guide users through the create-agent workflow.
 */
export function GuidedSetupPanel({ onAgentCreated, startOverRef, onSwitchToForm }: GuidedSetupPanelProps) {
  const location = useLocation();
  const navigate = useNavigate();

  // Detect OAuth return synchronously so we can skip auto-init before the
  // initThread / loadThread race begins (see useGuidedSetup skipAutoInit).
  const isOauthReturn = new URLSearchParams(location.search).get('oauthReturn') === '1';

  const {
    thread,
    messages,
    loading,
    error,
    sending,
    billingBlocked,
    sendMessage,
    submitActionResult,
    loadThread,
    startOver,
    clearBillingBlocked,
  } = useGuidedSetup({ skipAutoInit: isOauthReturn });

  const handledOauthReturnRef = useRef(false);

  // Frontend billing gate: fetch usage summary on mount to check credit
  const [billingCheckDone, setBillingCheckDone] = useState(false);
  const [preflightBillingBlocked, setPreflightBillingBlocked] = useState<BillingGateResult | null>(null);

  // Track OAuth resume phase — show a transition message while the thread is
  // being restored and the connection result is submitted, so the user isn't
  // confused by stale pre-OAuth conversation state.
  const [oauthResuming, setOauthResuming] = useState(false);

  // Expose startOver to the parent so the header refresh icon can reset the thread.
  useEffect(() => {
    if (startOverRef) {
      startOverRef.current = startOver;
    }
  }, [startOver, startOverRef]);

  // Handle OAuth return: restore the thread and auto-submit the returned
  // connectionId exactly once (guarded ref + draft clear prevent double-submit
  // on refresh/back/strict-mode).
  useEffect(() => {
    if (handledOauthReturnRef.current) return;

    const params = new URLSearchParams(location.search);
    if (params.get('oauthReturn') !== '1') return;

    handledOauthReturnRef.current = true;
    const draft = loadGuidedSetupOAuthDraft();
    const connectionId = params.get('connectionId');
    const status = params.get('status');

    if (draft && status === 'ok' && connectionId) {
      setOauthResuming(true);
      void loadThread(draft.threadId).then(() => {
        void submitActionResult(draft.actionId, { connectionId }).finally(() => {
          setOauthResuming(false);
        });
      });
    } else if (draft) {
      // No connection returned (e.g. error or cancelled) — still restore the thread.
      setOauthResuming(true);
      void loadThread(draft.threadId).finally(() => {
        setOauthResuming(false);
      });
    }

    clearGuidedSetupOAuthDraft();

    params.delete('oauthReturn');
    params.delete('setup');
    params.delete('status');
    params.delete('error');
    params.delete('connectionId');
    params.delete('guided');
    params.delete('threadId');
    params.delete('actionId');
    const nextSearch = params.toString();
    navigate(nextSearch ? `/agents/new?${nextSearch}` : '/agents/new', { replace: true });
  }, [location.search, navigate, loadThread, submitActionResult]);

  // Check billing status on mount — frontend gate is approximate, backend 402 is authoritative
  useEffect(() => {
    let cancelled = false;
    api.billing.usageSummary().then((summary) => {
      if (cancelled) return;
      const result = canUseGuidedSetup(summary);
      if (result.blocked) {
        setPreflightBillingBlocked(result);
      }
      setBillingCheckDone(true);
    }).catch(() => {
      // If billing check fails (network error, etc.), allow through — the backend guard is authoritative
      if (!cancelled) setBillingCheckDone(true);
    });

    return () => { cancelled = true; };
  }, []);

  // Merge billing blocked sources: preflight check wins over runtime 402
  const effectiveBillingBlocked = preflightBillingBlocked ?? billingBlocked;

  const handleQuickReply = (value: string) => {
    // Treat quick-reply selections as user messages
    sendMessage(value);
  };

  const handleFormSubmit = (actionId: string, result: unknown) => {
    submitActionResult(actionId, result);
  };

  // Render billing gate when blocked (either preflight check or runtime 402)
  if (effectiveBillingBlocked?.blocked) {
    return (
      <BillingGate
        reason={effectiveBillingBlocked.reason}
        message={effectiveBillingBlocked.message}
        onSwitchToForm={onSwitchToForm}
        clearBillingBlocked={clearBillingBlocked}
      />
    );
  }

  // If billing check not done yet, show loading
  if (!billingCheckDone) {
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
        &nbsp;Checking account...
      </div>
    );
  }

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
      {/* OAuth resume transition — reassures the user while the thread
          is being restored and the connection result is processed. */}
      {oauthResuming && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            padding: '12px 16px',
            backgroundColor: 'var(--color-primary)',
            color: 'var(--color-on-primary)',
            fontSize: 14,
            fontWeight: 500,
            flexShrink: 0,
          }}
        >
          <span style={{ animation: 'pulse 1.5s infinite' }}>●</span>
          Processing your connection…
        </div>
      )}
      {/* Chat thread */}
      <GuidedSetupThread
        messages={messages}
        onSend={sendMessage}
        onQuickReply={handleQuickReply}
        onFormSubmit={handleFormSubmit}
        threadId={thread?.id}
        sending={sending}
        hideForms={oauthResuming}
        oauthResuming={oauthResuming}
      />
    </div>
  );
}

/** Billing gate rendered when user lacks available credit for Guided Setup. */
function BillingGate({
  reason,
  message,
  onSwitchToForm,
  clearBillingBlocked,
}: {
  reason: BillingGateResult['reason'];
  message: string;
  onSwitchToForm?: () => void;
  clearBillingBlocked?: () => void;
}) {
  const navigate = useNavigate();
  const isSuspended = reason === 'suspended';

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        height: '100%',
        gap: 20,
        padding: 32,
      }}
    >
      <div style={{ fontSize: 48 }}>💳</div>
      <div
        style={{
          fontSize: 18,
          fontWeight: 600,
          color: 'var(--color-text)',
          textAlign: 'center',
        }}
      >
        Credit Required
      </div>
      <div
        style={{
          fontSize: 14,
          color: 'var(--color-text-muted)',
          textAlign: 'center',
          maxWidth: 320,
        }}
      >
        {message}
      </div>
      <div style={{ display: 'flex', gap: 12 }}>
        {/* Adding credit is irrelevant when suspended — contact support instead */}
        {!isSuspended && (
          <button
            onClick={() => navigate('/billing')}
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
            Add Credit
          </button>
        )}
        {onSwitchToForm && (
          <button
            onClick={() => onSwitchToForm()}
            style={{
              padding: '10px 24px',
              borderRadius: 8,
              border: '1px solid var(--color-border)',
              backgroundColor: 'transparent',
              color: 'var(--color-text)',
              fontSize: 14,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Use standard form
          </button>
        )}
        {clearBillingBlocked && (
          <button
            onClick={() => clearBillingBlocked()}
            style={{
              padding: '10px 24px',
              borderRadius: 8,
              border: '1px solid var(--color-border)',
              backgroundColor: 'transparent',
              color: 'var(--color-text)',
              fontSize: 14,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Try Again
          </button>
        )}
      </div>
      {!isSuspended && (
        <div style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
          After adding credit, click Try Again to continue.
        </div>
      )}
    </div>
  );
}
