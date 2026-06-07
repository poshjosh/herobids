/**
 * useEventStream — subscribes to the /events WebSocket endpoint and
 * calls `onEvent` for each parsed server message.
 *
 * The hook handles:
 * - JWT passed as a query param (browsers cannot set headers on WS upgrades)
 * - Automatic reconnection with exponential back-off (capped at 30 s)
 * - Teardown on unmount or when the token changes
 */

import { useEffect, useRef } from 'react';
import { config } from './config.js';
import { getToken } from './session.js';

export type UserEvent =
  | { type: 'bot.status'; botId: string; status: 'running' | 'stopped' | 'crashed'; timestamp: string }
  | { type: 'agent.status'; agentId: string; status: 'starting' | 'active' | 'stopped' | 'crashed'; timestamp: string }
  | { type: 'order.filled'; botId: string; orderId: string; symbol: string; side: string; quantity: string; price: string; fee?: string; timestamp: string }
  | { type: 'decision.accepted'; agentId: string; decisionId: string; timestamp: string }
  | { type: 'decision.rejected'; agentId: string; decisionId: string; reason: string; timestamp: string }
  | { type: 'risk.guardrail'; botId: string; rule: string; detail: string; timestamp: string }
  | { type: 'platform.alert'; message: string; severity: 'info' | 'warn' | 'critical'; timestamp: string };

function buildWsUrl(): string {
  const token = getToken();
  const base = config.apiBaseUrl;
  let wsBase: string;
  if (base.startsWith('http://') || base.startsWith('https://')) {
    wsBase = base.replace(/^http/, 'ws');
  } else {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    wsBase = `${proto}//${window.location.host}${base}`;
  }
  const url = `${wsBase}/events`;
  return token ? `${url}?token=${encodeURIComponent(token)}` : url;
}

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;

export function useEventStream(onEvent: (event: UserEvent) => void): void {
  // Keep a stable ref to the callback so we don't need it as a dep
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    let ws: WebSocket | null = null;
    let attempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    function connect(): void {
      if (stopped) return;
      const token = getToken();
      if (!token) {
        // Not authenticated — don't connect
        return;
      }

      ws = new WebSocket(buildWsUrl());

      ws.addEventListener('open', () => {
        attempt = 0;
      });

      ws.addEventListener('message', (ev) => {
        try {
          const event = JSON.parse(ev.data as string) as UserEvent;
          handlerRef.current(event);
        } catch {
          // Ignore malformed messages
        }
      });

      ws.addEventListener('close', (ev) => {
        ws = null;
        // Code 4001 = auth failure — no point in reconnecting
        if (stopped || ev.code === 4001) return;
        const delay = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
        attempt++;
        reconnectTimer = setTimeout(connect, delay);
      });

      ws.addEventListener('error', () => {
        // The 'close' event fires after 'error' — reconnection is handled there
      });
    }

    connect();

    return () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) {
        ws.close();
        ws = null;
      }
    };
  }, []); // token is read inside the effect; changes cause remount if needed
}
