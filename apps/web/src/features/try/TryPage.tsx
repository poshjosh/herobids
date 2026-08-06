import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router';
import { isAuthenticated } from '../../lib/session.js';
import { auth, ApiError } from '../../lib/api-client.js';

// ---------------------------------------------------------------------------
// Static copy
// ---------------------------------------------------------------------------

const MESSAGE_1 = "Hi! I can help you create an AI agent. Let's get you set up first.";
const MESSAGE_2 =
  'I see you have not logged in, please provide your email address so your AI agents can communicate with you';
const MESSAGE_3 = (email: string) =>
  `An email has been sent to ${email}. Check your inbox — the link will set you up for a new AI agent.`;

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------------------------------------------------------------------------
// Timing (ms)
// ---------------------------------------------------------------------------

const TYPING_DELAY_1 = 0;       // typing starts immediately, runs for TYPING_DURATION ms
const TYPING_DURATION = 500;    // typing indicator visible for 500 ms before message appears
const DELAY_BETWEEN_MESSAGES = 2000; // wait 2000 ms after msg1, then typing2 runs for TYPING_DURATION ms
// Total msg1→msg2 = DELAY_BETWEEN_MESSAGES + TYPING_DURATION = 2500 ms (matches plan)

// ---------------------------------------------------------------------------
// State machine phases
// ---------------------------------------------------------------------------

type Phase =
  | 'IDLE'
  | 'TYPING_1'
  | 'MESSAGE_1'
  | 'TYPING_2'
  | 'MESSAGE_2'
  | 'SENDING_LINK'
  | 'LINK_SENT'
  | 'RESENDING'
  | 'ERROR';

// ---------------------------------------------------------------------------
// Styles (mirror ChatMessage / ChatComposer inline patterns)
// ---------------------------------------------------------------------------

const pageStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100vh',
  backgroundColor: 'var(--color-surface-0)',
};

const headerStyle: React.CSSProperties = {
  padding: '16px 24px',
  borderBottom: '1px solid var(--color-border)',
  backgroundColor: 'var(--color-surface-1)',
  display: 'flex',
  alignItems: 'center',
  gap: 12,
};

const headerTitleStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 700,
  color: 'var(--color-text-primary)',
};

const scrollAreaStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  padding: '24px 16px',
};

const messageRowStyle = (isUser: boolean): React.CSSProperties => ({
  display: 'flex',
  flexDirection: 'column',
  alignItems: isUser ? 'flex-end' : 'flex-start',
  marginBottom: 16,
});

const bubbleStyle = (isUser: boolean): React.CSSProperties => ({
  maxWidth: '80%',
  padding: '10px 16px',
  borderRadius: 12,
  backgroundColor: isUser ? 'var(--color-primary)' : 'var(--color-surface-2)',
  color: isUser ? 'var(--color-on-primary)' : 'var(--color-text)',
  fontSize: 15,
  lineHeight: 1.5,
  wordBreak: 'break-word',
});

const typingStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 0',
  color: 'var(--color-text-muted)',
  fontSize: 13,
  marginBottom: 16,
};

const inputRowStyle: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  maxWidth: '80%',
  width: '100%',
};

const inputStyle: React.CSSProperties = {
  flex: 1,
  padding: '10px 14px',
  borderRadius: 8,
  border: '1px solid var(--color-border)',
  backgroundColor: 'var(--color-surface-2)',
  color: 'var(--color-text)',
  fontSize: 15,
  lineHeight: 1.4,
  fontFamily: 'inherit',
};

const sendButtonStyle = (disabled: boolean): React.CSSProperties => ({
  padding: '10px 20px',
  borderRadius: 8,
  border: 'none',
  backgroundColor: disabled ? 'var(--color-surface-2)' : 'var(--color-primary)',
  color: disabled ? 'var(--color-text-muted)' : 'var(--color-on-primary)',
  fontSize: 15,
  fontWeight: 600,
  cursor: disabled ? 'not-allowed' : 'pointer',
  whiteSpace: 'nowrap',
});

const errorStyle: React.CSSProperties = {
  color: 'var(--color-danger)',
  fontSize: 13,
  marginTop: 6,
};

const resendRowStyle: React.CSSProperties = {
  marginTop: 8,
};

const resendButtonStyle = (disabled: boolean): React.CSSProperties => ({
  padding: '8px 16px',
  borderRadius: 8,
  border: '1px solid var(--color-border)',
  backgroundColor: 'transparent',
  color: disabled ? 'var(--color-text-muted)' : 'var(--color-text)',
  fontSize: 14,
  fontFamily: 'inherit',
  cursor: disabled ? 'not-allowed' : 'pointer',
});

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TryPage() {
  const navigate = useNavigate();

  // Redirect authenticated users to /agents/new
  useEffect(() => {
    if (isAuthenticated()) {
      navigate('/agents/new', { replace: true });
    }
  }, [navigate]);

  const [phase, setPhase] = useState<Phase>('IDLE');
  const [email, setEmail] = useState('');
  const [validationError, setValidationError] = useState('');
  const [serverError, setServerError] = useState('');
  const [hasLinkBeenSent, setHasLinkBeenSent] = useState(false);
  const emailInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // ── Typing animation sequence ──────────────────────────────────────────

  useEffect(() => {
    if (phase !== 'IDLE') return;

    const t1 = setTimeout(() => setPhase('TYPING_1'), TYPING_DELAY_1);
    return () => clearTimeout(t1);
  }, [phase]);

  useEffect(() => {
    if (phase !== 'TYPING_1') return;

    const t = setTimeout(() => setPhase('MESSAGE_1'), TYPING_DURATION);
    return () => clearTimeout(t);
  }, [phase]);

  useEffect(() => {
    if (phase !== 'MESSAGE_1') return;

    const t = setTimeout(() => setPhase('TYPING_2'), DELAY_BETWEEN_MESSAGES);
    return () => clearTimeout(t);
  }, [phase]);

  useEffect(() => {
    if (phase !== 'TYPING_2') return;

    const t = setTimeout(() => {
      setPhase('MESSAGE_2');
      // Focus the email input after it appears
      setTimeout(() => emailInputRef.current?.focus(), 50);
    }, TYPING_DURATION);
    return () => clearTimeout(t);
  }, [phase]);

  // ── Auto-scroll when phase changes ────────────────────────────────────

  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [phase]);

  // ── Email input handlers ───────────────────────────────────────────────

  const validate = useCallback((value: string): boolean => {
    if (!EMAIL_REGEX.test(value)) {
      setValidationError('Enter a valid email address');
      return false;
    }
    setValidationError('');
    return true;
  }, []);

  const handleEmailChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      setEmail(value);
      setServerError('');
      // Clear validation error once the value looks valid
      if (validationError && EMAIL_REGEX.test(value)) {
        setValidationError('');
      }
    },
    [validationError],
  );

  const sendLink = useCallback(
    async (emailToSend: string) => {
      setServerError('');
      try {
        await auth.sendLoginLink(emailToSend, undefined, '/agents/new');
        return { ok: true };
      } catch (err) {
        if (err instanceof ApiError && err.status === 429) {
          setServerError('Please wait before requesting another link');
        } else {
          setServerError('Something went wrong. Please try again.');
        }
        return { ok: false };
      }
    },
    [],
  );

  // ── Phase-derived flags (must be above handleSubmit / handleKeyDown) ────

  const isEmailSubmitting = phase === 'SENDING_LINK';
  const isResending = phase === 'RESENDING';

  const handleSubmit = useCallback(async () => {
    const trimmed = email.trim();
    if (!validate(trimmed)) return;
    setEmail(trimmed);
    setPhase('SENDING_LINK');
    const result = await sendLink(trimmed);
    if (result.ok) {
      setHasLinkBeenSent(true);
      setPhase('LINK_SENT');
    } else {
      setPhase('ERROR');
    }
  }, [email, validate, sendLink]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (isEmailSubmitting) return;
        void handleSubmit();
      }
    },
    [handleSubmit, isEmailSubmitting],
  );

  const handleResend = useCallback(async () => {
    setPhase('RESENDING');
    const result = await sendLink(email);
    if (result.ok) {
      setPhase('LINK_SENT');
    } else {
      setPhase('ERROR');
    }
  }, [email, sendLink, isResending]);

  const showTyping1 = phase === 'TYPING_1';
  const showMessage1 =
    phase === 'MESSAGE_1' || phase === 'TYPING_2' || phase === 'MESSAGE_2' ||
    phase === 'SENDING_LINK' || phase === 'LINK_SENT' || phase === 'RESENDING' ||
    phase === 'ERROR';
  const showTyping2 = phase === 'TYPING_2';
  const showMessage2 =
    phase === 'MESSAGE_2' || phase === 'SENDING_LINK' || phase === 'LINK_SENT' ||
    phase === 'RESENDING' || phase === 'ERROR';
  const showEmailInput = phase === 'MESSAGE_2' || phase === 'SENDING_LINK' || (phase === 'ERROR' && !hasLinkBeenSent);
  const showMessage3 = phase === 'LINK_SENT' || phase === 'RESENDING' || (phase === 'ERROR' && hasLinkBeenSent);
  const showResend = phase === 'LINK_SENT' || phase === 'RESENDING' || (phase === 'ERROR' && hasLinkBeenSent);

  return (
    <div style={pageStyle}>
      {/* Header */}
      <div style={headerStyle}>
        <span style={headerTitleStyle}>OpenAIdom</span>
      </div>

      {/* Scrollable message area */}
      <div ref={scrollRef} style={scrollAreaStyle}>
        {/* Typing indicator 1 */}
        {showTyping1 && (
          <div style={typingStyle}>
            <span style={{ animation: 'pulse 1.5s infinite' }}>●</span>
            Assistant is typing...
          </div>
        )}

        {/* Message 1 */}
        {showMessage1 && (
          <div style={messageRowStyle(false)}>
            <div style={bubbleStyle(false)}>{MESSAGE_1}</div>
          </div>
        )}

        {/* Typing indicator 2 */}
        {showTyping2 && (
          <div style={typingStyle}>
            <span style={{ animation: 'pulse 1.5s infinite' }}>●</span>
            Assistant is typing...
          </div>
        )}

        {/* Message 2 */}
        {showMessage2 && (
          <div style={messageRowStyle(false)}>
            <div style={bubbleStyle(false)}>{MESSAGE_2}</div>
          </div>
        )}

        {/* Email input (below message 2) */}
        {showEmailInput && (
          <div style={{ ...messageRowStyle(false), maxWidth: '80%' }}>
            <div style={inputRowStyle}>
              <input
                ref={emailInputRef}
                type="email"
                value={email}
                onChange={handleEmailChange}
                onKeyDown={handleKeyDown}
                placeholder="you@example.com"
                disabled={isEmailSubmitting}
                style={inputStyle}
                autoComplete="email"
              />
              <button
                onClick={() => void handleSubmit()}
                disabled={isEmailSubmitting || !email.trim()}
                style={sendButtonStyle(isEmailSubmitting || !email.trim())}
              >
                {isEmailSubmitting ? '...' : 'Send'}
              </button>
            </div>
            {validationError && <div style={errorStyle}>{validationError}</div>}
            {serverError && !validationError && <div style={errorStyle}>{serverError}</div>}
          </div>
        )}

        {/* Message 3 (after link sent) */}
        {showMessage3 && (
          <div style={messageRowStyle(false)}>
            <div style={bubbleStyle(false)}>{MESSAGE_3(email)}</div>
          </div>
        )}

        {/* Resend button */}
        {showResend && (
          <div style={{ ...messageRowStyle(false), maxWidth: '80%' }}>
            <div style={resendRowStyle}>
              {serverError && phase === 'ERROR' && (
                <div style={{ ...errorStyle, marginBottom: 8 }}>{serverError}</div>
              )}
              <button
                onClick={() => void handleResend()}
                disabled={isResending}
                style={resendButtonStyle(isResending)}
              >
                {isResending ? 'Resending...' : 'Resend link'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
