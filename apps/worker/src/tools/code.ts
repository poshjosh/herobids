import { z } from 'zod';
import { writeFile, mkdir, rm, access } from 'node:fs/promises';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import pino from 'pino';
import type { AgentTool, ToolResult, ToolContext } from '@herobids/domain';
import { convertZodToJsonSchema } from './registry.js';

const execFileAsync = promisify(execFileCb);
const logger = pino({ name: 'tools:code' });

// --- code_execute ---

const CodeExecuteParamsSchema = z.object({
  code: z.string().min(1),
  description: z.string().optional(),
});

const codeExecuteTool: AgentTool = {
  name: 'code_execute',
  description: 'Execute arbitrary JavaScript code in a sandboxed environment. Use for data analysis, calculations, or testing ideas. Code runs in Node.js with network isolation. Output is captured and returned.',
  parametersSchema: CodeExecuteParamsSchema,
  parameters: convertZodToJsonSchema(CodeExecuteParamsSchema),
  category: 'execute-filesystem',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    // Enforce capability policy before executing — rate limit, concurrency, and enable/disable.
    if (ctx.capabilityEngine) {
      const policyDenied = ctx.capabilityEngine.checkAccess('code_execute', ctx.agentId, ctx.sessionId);
      if (policyDenied) {
        logger.warn({ agentId: ctx.agentId, reason: policyDenied }, 'code_execute denied by capability policy');
        return { success: false, error: `capability policy denied: ${policyDenied}`, retryable: false };
      }
      ctx.capabilityEngine.recordStart('code_execute', ctx.sessionId);
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
    const codeGrant = ctx.capabilityEngine?.getGrant('code_execute');
    const TIMEOUT_MS = codeGrant?.limits?.timeoutMs ?? 60_000;
    const MAX_OUTPUT = codeGrant?.limits?.maxResponseBytes ?? (50 * 1024);

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
        ctx.capabilityEngine.recordEnd('code_execute', ctx.sessionId, {
          capability: 'code_execute',
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
        error: `code_execute${label} failed:\nstderr: ${stderr}\nstdout: ${stdout || '(no output)'}`,
        retryable: false,
      };
    }
  },
};

export const codeTools: AgentTool[] = [
  codeExecuteTool,
];
