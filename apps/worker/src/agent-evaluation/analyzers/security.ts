import type { EvaluationArtifactStore, EvaluationSectionScore, EvaluationFinding } from '@herobids/domain';

// ── Pre-compiled regexes for common secret patterns ─────────────────────────

const SECRET_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: 'OpenAI API key', regex: /sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g },
  { name: 'GitHub token', regex: /ghp_[A-Za-z0-9]{36}/g },
  { name: 'AWS access key', regex: /AKIA[0-9A-Z]{16}/g },
  { name: 'Generic private key', regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g },
  { name: 'JWT token', regex: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
];

const THINKING_PATTERNS = [
  'thinking',
  'thought',
  'chainOfThought',
  'chain_of_thought',
  'reasoning',
];

// ── Helpers ─────────────────────────────────────────────────────────────────

async function readJsonArtifact(store: EvaluationArtifactStore, runId: string, name: string): Promise<unknown> {
  const data = await store.read(runId, name);
  if (!data) return null;
  return JSON.parse(new TextDecoder().decode(data));
}

async function readTextArtifact(store: EvaluationArtifactStore, runId: string, name: string): Promise<string | null> {
  const data = await store.read(runId, name);
  if (!data) return null;
  return new TextDecoder().decode(data);
}

function finding(
  section: EvaluationSectionScore['section'],
  severity: EvaluationFinding['severity'],
  code: string,
  title: string,
  detail: string,
  evidence?: string,
): EvaluationFinding {
  return { section, severity, code, title, detail, evidence };
}

// ── Security analyzer ───────────────────────────────────────────────────────

/**
 * Security analyzer — always runs.
 * Checks for secret leakage and thinking trace exposure in collected evidence.
 */
export async function analyzeSecurity(
  store: EvaluationArtifactStore,
  runId: string,
): Promise<EvaluationSectionScore> {
  const findings: EvaluationFinding[] = [];

  // Collect all text-based artifacts for scanning
  const artifactNames = ['journal.json', 'fills.json', 'sessions.json', 'agent-metadata.json'];
  const textsToScan: Array<{ source: string; content: string }> = [];

  for (const name of artifactNames) {
    const text = await readTextArtifact(store, runId, name);
    if (text) {
      textsToScan.push({ source: name, content: text });
    }
  }

  // ── Secret leakage ─────────────────────────────────────────────────────
  for (const { source, content } of textsToScan) {
    for (const pattern of SECRET_PATTERNS) {
      const matches = content.match(pattern.regex);
      if (matches && matches.length > 0) {
        findings.push(finding(
          'security',
          'critical',
          'security.possible_secret_leak',
          `Possible ${pattern.name} leak`,
          `Found ${matches.length} match(es) matching ${pattern.name} pattern in ${source}. Secrets must never appear in stored artifacts.`,
          `${source} → pattern: ${pattern.name}`,
        ));
      }
    }
  }

  // ── Thinking trace detection ───────────────────────────────────────────
  const journal = await readJsonArtifact(store, runId, 'journal.json') as Array<Record<string, unknown>> | null;
  if (journal) {
    for (const event of journal) {
      const payload = event['payload'] as Record<string, unknown> | undefined;
      const payloadStr = payload ? JSON.stringify(payload).toLowerCase() : '';
      for (const pattern of THINKING_PATTERNS) {
        if (payloadStr.includes(pattern)) {
          findings.push(finding(
            'security',
            'high',
            'security.thinking_trace_leaked',
            'LLM thinking trace detected in stored messages',
            `Journal event ${event['id']} contains a field matching the thinking-trace pattern "${pattern}". Thinking traces must be stripped before persistence.`,
            `journal.json → id=${event['id']}, pattern="${pattern}"`,
          ));
          break;
        }
      }
    }
  }

  // Compute score
  const weights: Record<string, number> = { critical: 40, high: 25, medium: 10, low: 5, info: 0 };
  const score = Math.max(0, 100 - findings.reduce((s, f) => s + (weights[f.severity] ?? 0), 0));

  return { section: 'security', score, findings, applicable: true };
}
