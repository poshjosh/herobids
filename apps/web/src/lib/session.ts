// Session token storage and access.
// The JWT is kept in memory (primary) and mirrored to localStorage for persistence
// across page refreshes. We do NOT use httpOnly cookies here because the frontend
// needs to read the token to attach it to outgoing API requests.

const STORAGE_KEY = 'hb_session_token';

let memoryToken: string | null = null;

export function getToken(): string | null {
  if (memoryToken) return memoryToken;
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  memoryToken = token;
  try {
    localStorage.setItem(STORAGE_KEY, token);
  } catch {
    // Storage quota or private-browsing restriction — memory-only is still usable
  }
}

export function clearToken(): void {
  memoryToken = null;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function isAuthenticated(): boolean {
  const token = getToken();
  if (!token) return false;
  try {
    // Basic expiry check — decode the JWT payload without cryptographic verification
    // (server verifies on every request; this is just for UX gating)
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    // Restore base64 padding stripped by the JWT compact serialisation before decoding
    const b64 = parts[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(atob(padded)) as { exp?: number };
    if (typeof payload.exp !== 'number') return true;
    return payload.exp * 1000 > Date.now();
  } catch {
    return false;
  }
}
