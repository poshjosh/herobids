import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react';
import { auth, ApiError, type MeResponse } from '../../lib/api-client.js';
import { getToken, setToken, clearToken, isAuthenticated } from '../../lib/session.js';
import { queryClient } from './QueryProvider.js';
import { useLocale } from '../i18n/I18nProvider.js';
import { isSupportedLocale } from '../i18n/resolveLocale.js';

interface SessionState {
  user: MeResponse | null;
  loading: boolean;
  authenticated: boolean;
}

interface SessionContextValue extends SessionState {
  login: (token: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const { locale, setLocale } = useLocale();
  const [state, setState] = useState<SessionState>({
    user: null,
    loading: isAuthenticated(),
    authenticated: false,
  });

  const loadUser = useCallback(async () => {
    if (!isAuthenticated()) {
      setState({ user: null, loading: false, authenticated: false });
      return;
    }
    try {
      const user = await auth.me();
      setState({ user, loading: false, authenticated: true });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        // Session explicitly rejected by the server — invalidate.
        // Clear cached query data before updating auth state so that the brief
        // window between clearToken() and the <Navigate to="/login"> redirect
        // cannot show stale data if the client-side router keeps the queryClient alive.
        queryClient.clear();
        clearToken();
        setState({ user: null, loading: false, authenticated: false });
      } else {
        // Server/network error — preserve the session if the client-side JWT is still
        // unexpired.  The exchange code is single-use, so destroying a valid token on
        // a transient 5xx would force a full re-login with no recovery path.
        setState({ user: null, loading: false, authenticated: isAuthenticated() });
      }
    }
  }, []);

  useEffect(() => {
    void loadUser();
  }, [loadUser]);

  // Sync active locale once per user load, driven by the server preference.
  // locale is intentionally excluded from deps: this effect propagates server→client only;
  // including locale would revert manual language changes while a mutation is in-flight.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const preferredLocale = state.user?.preferredLocale;
    if (isSupportedLocale(preferredLocale) && preferredLocale !== locale) {
      setLocale(preferredLocale);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.user?.preferredLocale, setLocale]);

  const login = useCallback(async (token: string) => {
    // Clear any stale cached data from a previous session before establishing
    // the new one — guards against cross-user data leaks if accounts switch
    // without an explicit logout.
    queryClient.clear();
    setToken(token);
    await loadUser();
  }, [loadUser]);

  const logout = useCallback(async () => {
    try {
      if (getToken()) {
        await auth.logout();
      }
    } catch {
      // Best-effort
    } finally {
      clearToken();
      // Clear all cached query data so a subsequent login (possibly a different
      // user) cannot see the previous session's data during the staleTime window.
      queryClient.clear();
      setState({ user: null, loading: false, authenticated: false });
    }
  }, []);

  const refresh = useCallback(async () => {
    await loadUser();
  }, [loadUser]);

  return (
    <SessionContext.Provider value={{ ...state, login, logout, refresh }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used within SessionProvider');
  return ctx;
}
