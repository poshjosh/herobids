export const SANDBOX_SCRIPT = '/usr/local/bin/sandbox-exec.sh';

export const NON_RECOVERABLE_SANDBOX_PATTERNS = [
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
