import { z } from 'zod';
import { writeFile, mkdir, rm, access } from 'node:fs/promises';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import pino from 'pino';
import type { AgentTool, ToolResult, ToolContext } from '@herobids/domain';
import { convertZodToJsonSchema } from './registry.js';

const execFileAsync = promisify(execFileCb);
const logger = pino({ name: 'tools:code' });

// Read code-execute defaults from the agent runtime config injected by the worker.
const _runtimePolicy = (() => {
  try {
    const raw = process.env['AGENT_RUNTIME_CONFIG_JSON'];
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as { tools?: { codeExecute?: { defaultTimeoutMs?: number; defaultMaxOutputBytes?: number } } };
    return parsed.tools?.codeExecute;
  } catch {
    return undefined;
  }
})();

// --- execute_code ---

const CodeExecuteParamsSchema = z.object({
  code: z.string().min(1),
  description: z.string().optional(),
});

const codeExecuteTool: AgentTool = {
  name: 'execute_code',
  description: 'Execute arbitrary JavaScript code in a sandboxed environment. Use for data analysis, calculations, or testing ideas. Code runs in Node.js with network isolation. Output is captured and returned.',
  parametersSchema: CodeExecuteParamsSchema,
  parameters: convertZodToJsonSchema(CodeExecuteParamsSchema),
  category: 'execute-filesystem',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    // Enforce capability policy before executing — rate limit, concurrency, and enable/disable.
    if (ctx.capabilityEngine) {
      const policyDenied = ctx.capabilityEngine.checkAccess('execute_code', ctx.agentId, ctx.sessionId);
      if (policyDenied) {
        logger.warn({ agentId: ctx.agentId, reason: policyDenied }, 'execute_code denied by capability policy');
        return { success: false, error: `capability policy denied: ${policyDenied}`, retryable: false };
      }
      ctx.capabilityEngine.recordStart('execute_code', ctx.sessionId);
    }

    const codeStartMs = Date.now();
    let codeSuccess = false;

    // Code execution runs locally inside this container — no broker round-trip needed.
    // In Docker mode, sandbox-exec.sh provides network namespace isolation (blocks RFC 1918,
    // allows public internet, uses public DNS). Falls back to direct node in stub/dev mode.
    const { code, description } = params as z.infer<typeof CodeExecuteParamsSchema>;
    const SANDBOX_SCRIPT = '/usr/local/bin/sandbox-exec.sh';
    const SANDBOX_DIR = '/tmp/agent-sandbox';
    const scriptPath = `${SANDBOX_DIR}/script.js`;

    // Read limits from the effective capability grant so operator/user policy changes
    // govern execution timeout and output size, not just rate/concurrency.
    const codeGrant = ctx.capabilityEngine?.getGrant('execute_code');
    if (!_runtimePolicy) {
      return { success: false, error: 'execute_code requires AGENT_RUNTIME_CONFIG_JSON with tools.codeExecute defaults', retryable: false };
    }
    const TIMEOUT_MS = codeGrant?.limits?.timeoutMs ?? _runtimePolicy.defaultTimeoutMs ?? 30_000;
    const MAX_OUTPUT = codeGrant?.limits?.maxResponseBytes ?? _runtimePolicy.defaultMaxOutputBytes ?? 1_048_576;

    let stdout = '';
    let stderr = '';
    let success = false;

    try {
      await rm(SANDBOX_DIR, { recursive: true, force: true });
      await mkdir(SANDBOX_DIR, { recursive: true });
      await writeFile(scriptPath, code, 'utf8');

      const hasSandbox = await access(SANDBOX_SCRIPT).then(() => true).catch(() => false);
      let sandboxBin: string;
      let sandboxArgs: string[];
      if (hasSandbox) {
        // sandbox-exec.sh passes $@ to `exec ip netns exec <ns> "$@"`,
        // so args become the full command inside the namespace.
        sandboxBin = SANDBOX_SCRIPT;
        sandboxArgs = ['node', scriptPath];
      } else {
        sandboxBin = 'node';
        sandboxArgs = [scriptPath];
      }

      const result = await execFileAsync(sandboxBin, sandboxArgs, {
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT * 2,
        env: hasSandbox
          ? { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', TIMEOUT: String(Math.ceil(TIMEOUT_MS / 1000)) }
          : process.env,
      });
      stdout = String(result.stdout || '').slice(0, MAX_OUTPUT);
      success = true;
      codeSuccess = true;
    } catch (err) {
      const execErr = err as { stdout?: string; stderr?: string; message?: string };
      stdout = String(execErr.stdout || '').slice(0, MAX_OUTPUT);
      stderr = String(execErr.stderr || execErr.message || 'execution failed').slice(0, 10 * 1024);
    } finally {
      if (ctx.capabilityEngine) {
        ctx.capabilityEngine.recordEnd('execute_code', ctx.sessionId, {
          capability: 'execute_code',
          agentId: ctx.agentId,
          sessionId: ctx.sessionId,
          timestamp: new Date().toISOString(),
          durationMs: Date.now() - codeStartMs,
          inputSummary: `${code.length} bytes`,
          outputSummary: success ? `${stdout.length} bytes` : `error: ${stderr.slice(0, 100)}`,
          success: codeSuccess,
        });
      }
    }

    const label = description ? ` (${description})` : '';
    if (success) {
      return {
        success: true,
        data: { result: stdout || '(no output)', description: label },
      };
    } else {
      return {
        success: false,
        error: `execute_code${label} failed:\nstderr: ${stderr}\nstdout: ${stdout || '(no output)'}`,
        retryable: false,
      };
    }
  },
};

export const codeTools: AgentTool[] = [
  codeExecuteTool,
];
