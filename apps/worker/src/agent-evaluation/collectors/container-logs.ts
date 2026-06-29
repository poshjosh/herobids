import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { EvaluationArtifactStore } from '@herobids/domain';
import type { EvidenceManifestEntry } from './evidence-assembler.js';

const execFileAsync = promisify(execFile);

/**
 * Collect container logs for a given agent (best-effort).
 *
 * Attempts to fetch the last 500 lines of Docker logs for the agent's container.
 * Failures are silent — this is a best-effort collector that records
 * `collected: false` in the manifest when logs are unavailable.
 */
export async function collectContainerLogs(
  agentId: string,
  store: EvaluationArtifactStore,
  runId: string,
): Promise<EvidenceManifestEntry> {
  try {
    const containerName = `herobids-agent-${agentId}`;
    const { stdout } = await execFileAsync('docker', [
      'logs',
      '--timestamps',
      '--tail',
      '500',
      containerName,
    ], {
      timeout: 10_000,
      maxBuffer: 5 * 1024 * 1024, // 5 MB
    });

    await store.write(runId, 'container-logs.txt', stdout);
    return { artifactName: 'container-logs.txt', collected: true };
  } catch {
    // Docker may not be available (e.g. agent running in a different host,
    // or using a non-Docker runtime). This is expected and not an error.
    return { artifactName: 'container-logs.txt', collected: false, error: 'Container logs unavailable' };
  }
}
