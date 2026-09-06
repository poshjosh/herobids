import { useState, useCallback, useRef, useEffect } from 'react';
import type { ChatMessage, ChatThread } from '../../lib/api-client.js';
import * as api from '../../lib/api-client.js';
import type { BillingGateResult } from './canUseGuidedSetup.js';

const GUIDED_SETUP_THREAD_KEY = 'guided-setup-thread-id-v1';

const BILLING_GATE_REASONS: readonly BillingGateResult['reason'][] = ['ok', 'hard_limited', 'suspended', 'no_available_credit'];

/** Narrows an unknown API param to a known billing gate reason, defaulting to 'no_available_credit'. */
function toBillingGateReason(value: unknown): BillingGateResult['reason'] {
  return typeof value === 'string' && (BILLING_GATE_REASONS as readonly string[]).includes(value)
    ? (value as BillingGateResult['reason'])
    : 'no_available_credit';
}

function saveThreadId(threadId: string): void {
  try {
    window.sessionStorage.setItem(GUIDED_SETUP_THREAD_KEY, threadId);
  } catch {
    // Ignore storage failures.
  }
}

function loadSavedThreadId(): string | null {
  try {
    return window.sessionStorage.getItem(GUIDED_SETUP_THREAD_KEY);
  } catch {
    return null;
  }
}

function clearSavedThreadId(): void {
  try {
    window.sessionStorage.removeItem(GUIDED_SETUP_THREAD_KEY);
  } catch {
    // Ignore storage failures.
  }
}

export interface GuidedSetupState {
  thread: ChatThread | null;
  messages: ChatMessage[];
  loading: boolean;
  error: string | null;
  sending: boolean;
  billingBlocked: BillingGateResult | null;
}

export function useGuidedSetup({ skipAutoInit = false }: { skipAutoInit?: boolean } = {}) {
  const [state, setState] = useState<GuidedSetupState>({
    thread: null,
    messages: [],
    loading: false,
    error: null,
    sending: false,
    billingBlocked: null,
  });

  const threadIdRef = useRef<string | null>(null);

  /** Create a new thread (or resume existing) */
  const initThread = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const res = await api.chat.createThread();
      threadIdRef.current = res.thread.id;
      saveThreadId(res.thread.id);
      setState({
        thread: res.thread as ChatThread,
        messages: [res.message],
        loading: false,
        error: null,
        sending: false,
        billingBlocked: null,
      });
    } catch (err) {
      setState((s) => ({
        ...s,
        loading: false,
        error: err instanceof api.ApiError ? err.message : 'Failed to create chat thread',
      }));
    }
  }, []);

  /** Load an existing thread */
  const loadThread = useCallback(async (threadId: string) => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const res = await api.chat.getThread(threadId);
      threadIdRef.current = res.thread.id;
      saveThreadId(res.thread.id);
      setState({
        thread: res.thread,
        messages: res.messages,
        loading: false,
        error: null,
        sending: false,
        billingBlocked: null,
      });
    } catch (err) {
      setState((s) => ({
        ...s,
        loading: false,
        error: err instanceof api.ApiError ? err.message : 'Failed to load thread',
      }));
    }
  }, []);

  /** Send a user message */
  const sendMessage = useCallback(async (content: string) => {
    const threadId = threadIdRef.current;
    if (!threadId) return;

    // Optimistically add user message
    const optimisticMsg: ChatMessage = {
      id: `temp-${Date.now()}`,
      role: 'user',
      content,
      actions: null,
      createdAt: new Date().toISOString(),
    };

    setState((s) => ({
      ...s,
      messages: [...s.messages, optimisticMsg],
      sending: true,
      error: null,
    }));

    try {
      const res = await api.chat.sendMessage(threadId, content);
      setState((s) => ({
        ...s,
        // Replace optimistic message + add assistant response
        messages: [
          ...s.messages.filter((m) => m.id !== optimisticMsg.id),
          { id: `user-${Date.now()}`, role: 'user' as const, content, actions: null, createdAt: new Date().toISOString() },
          res.message,
        ],
        sending: false,
      }));
    } catch (err) {
      if (err instanceof api.ApiError && err.code === 'billing.top_up_required') {
        setState((s) => ({
          ...s,
          messages: s.messages.filter((m) => m.id !== optimisticMsg.id),
          sending: false,
          billingBlocked: {
            blocked: true,
            reason: toBillingGateReason(err.params?.reason),
            message: err.message,
          },
        }));
        return;
      }
      setState((s) => ({
        ...s,
        messages: s.messages.filter((m) => m.id !== optimisticMsg.id),
        sending: false,
        error: err instanceof api.ApiError ? err.message : 'Failed to send message',
      }));
    }
  }, []);

  /** Submit an action result (e.g., connection form completed) */
  const submitActionResult = useCallback(async (actionId: string, result: unknown) => {
    const threadId = threadIdRef.current;
    if (!threadId) return;

    setState((s) => ({ ...s, sending: true }));
    try {
      const res = await api.chat.submitActionResult(threadId, actionId, result);
      setState((s) => ({
        ...s,
        // The server may return no new message when the action was already
        // processed (idempotent re-submit) — only append when present.
        messages: res.message ? [...s.messages, res.message] : s.messages,
        sending: false,
      }));
    } catch (err) {
      if (err instanceof api.ApiError && err.code === 'billing.top_up_required') {
        setState((s) => ({
          ...s,
          sending: false,
          billingBlocked: {
            blocked: true,
            reason: toBillingGateReason(err.params?.reason),
            message: err.message,
          },
        }));
        return;
      }
      setState((s) => ({
        ...s,
        sending: false,
        error: err instanceof api.ApiError ? err.message : 'Failed to submit action result',
      }));
    }
  }, []);

  /** Start over — create a new thread */
  const startOver = useCallback(() => {
    clearSavedThreadId();
    threadIdRef.current = null;
    setState({
      thread: null,
      messages: [],
      loading: false,
      error: null,
      sending: false,
      billingBlocked: null,
    });
    initThread();
  }, [initThread]);

  /** Clear billing blocked state (e.g. after user adds credit and returns) */
  const clearBillingBlocked = useCallback(() => {
    setState((s) => ({ ...s, billingBlocked: null }));
  }, []);

  // Auto-initialize thread on mount (skipped during OAuth resume — the
  // caller will restore the existing thread via loadThread instead).
  // If a saved thread ID exists in sessionStorage, restore it instead of
  // creating a new one so the user can resume after navigating away.
  const initializedRef = useRef(false);
  useEffect(() => {
    if (skipAutoInit) return;
    if (!initializedRef.current) {
      initializedRef.current = true;
      const savedId = loadSavedThreadId();
      if (savedId) {
        loadThread(savedId);
      } else {
        initThread();
      }
    }
  }, [skipAutoInit, initThread, loadThread]);

  return {
    ...state,
    sendMessage,
    submitActionResult,
    startOver,
    loadThread,
    clearBillingBlocked,
    clearSavedThreadId,
  };
}
