import { useState, useCallback, useRef, useEffect } from 'react';
import type { ChatMessage, ChatThread } from '../../lib/api-client.js';
import * as api from '../../lib/api-client.js';
import type { BillingGateResult } from './canUseGuidedSetup.js';

export interface GuidedSetupState {
  thread: ChatThread | null;
  messages: ChatMessage[];
  loading: boolean;
  error: string | null;
  sending: boolean;
  billingBlocked: BillingGateResult | null;
}

export function useGuidedSetup() {
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
            reason: (err.params?.reason as string) ?? 'no_available_credit',
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
            reason: (err.params?.reason as string) ?? 'no_available_credit',
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

  // Auto-initialize thread on mount
  const initializedRef = useRef(false);
  useEffect(() => {
    if (!initializedRef.current) {
      initializedRef.current = true;
      initThread();
    }
  }, [initThread]);

  return {
    ...state,
    sendMessage,
    submitActionResult,
    startOver,
    loadThread,
    clearBillingBlocked,
  };
}
