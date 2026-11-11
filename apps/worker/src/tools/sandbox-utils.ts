export const SANDBOX_SCRIPT = '/usr/local/bin/sandbox-exec.sh';

// Matched against stderr from SANDBOX_SCRIPT. A match means the container cannot
// sandbox commands, so the tool result tells the agent not to retry.
export const NON_RECOVERABLE_SANDBOX_PATTERNS = [
  // Emitted by sandbox-exec.sh when the egress marker is missing (exit 97). Written
  // by sandbox-egress.sh at container start; missing when NET_ADMIN was not granted.
  /sandbox egress rules not active in this container/i,
  // Legacy: the per-command namespace design (sandbox-exec.sh before the UID-based
  // egress rules). Kept so images built before that change are still classified.
  /mount --make-shared\s+\/var\/run\/netns.*(?:Operation not permitted|Permission denied)/i,
  /ip netns add\b.*(?:Operation not permitted|Permission denied)/i,
];

export function isNonRecoverableSandboxError(stderr: string): boolean {
  return NON_RECOVERABLE_SANDBOX_PATTERNS.some((pattern) => pattern.test(stderr));
}

/**
 * Read code-execute defaults from the agent runtime config injected by the worker.
 * Evaluated lazily at call time so tests can override AGENT_RUNTIME_CONFIG_JSON.
 */
export function getRuntimePolicy(): { defaultTimeoutMs?: number; defaultMaxOutputBytes?: number } | undefined {
  try {
    const raw = process.env['AGENT_RUNTIME_CONFIG_JSON'];
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as { tools?: { codeExecute?: { defaultTimeoutMs?: number; defaultMaxOutputBytes?: number } } };
    return parsed.tools?.codeExecute;
  } catch {
    return undefined;
  }
}
