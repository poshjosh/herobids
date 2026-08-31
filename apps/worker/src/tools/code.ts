import { z } from 'zod';
import { writeFile, mkdir, rm, access } from 'node:fs/promises';
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '../logger.js';
import type { AgentTool, ToolResult, ToolContext } from '@herobids/domain';
import { convertZodToJsonSchema } from './registry.js';
import { getWorkspacePaths, ensureWorkspaceDirs } from './workspace.js';
import { capabilityDeniedResult } from './tool-errors.js';
import {
  SANDBOX_SCRIPT,
  isNonRecoverableSandboxError,
  getRuntimePolicy,
} from './sandbox-utils.js';

const execAsync = promisify(execCb);
const logger = createLogger('tools:code');

/**
 * Lightweight dependency-name validation.
 * Rejects names that look like shell injection or path traversal.
 */
function isValidDependencyName(name: string): boolean {
  // npm/pip package names: alphanumeric, hyphens, underscores, dots, and optional @scope/name for npm
  return /^(@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/i.test(name);
}

// --- execute_code ---

const CodeExecuteParamsSchema = z.object({
  code: z.string().min(1).describe('Source code to execute'),
  language: z.enum(['javascript', 'python']).default('javascript').describe('Execution language: "javascript" (Node.js) or "python"'),
  dependencies: z.array(z.string().min(1)).default([]).describe('Package names to install before execution (e.g. ["axios", "lodash"])'),
  // coerce: LLMs may send numbers as strings
  timeoutMs: z.coerce.number().int().min(1_000).max(600_000).optional().describe('Execution timeout in milliseconds (1000-600000)'),
  description: z.string().optional().describe('Brief description of what this code does. For audit/logging.'),
});

const codeExecuteTool: AgentTool = {
  name: 'execute_code',
  description: 'Execute JavaScript (Node.js) or Python code in a workspace-backed environment. Supports optional package installation and returns stdout, stderr, exit code, and duration.',
  parametersSchema: CodeExecuteParamsSchema,
  parameters: convertZodToJsonSchema(CodeExecuteParamsSchema),
  category: 'execute-filesystem',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    // Enforce capability policy before executing — rate limit, concurrency, and enable/disable.
    if (ctx.capabilityEngine) {
      const policyDenied = ctx.capabilityEngine.checkAccess('execute_code', ctx.agentId, ctx.sessionId);
      if (policyDenied) {
        logger.warn({
          agentId: ctx.agentId,
          capability: 'execute_code',
          reason: policyDenied.reason,
          limit: policyDenied.limit,
          used: policyDenied.used,
          retryAfterMs: policyDenied.retryAfterMs,
        }, 'Capability policy denied');
        return capabilityDeniedResult('execute_code', policyDenied);
      }
      // recordStart is deferred until after all validation so that early-exit
      // paths (invalid deps, missing config) don't leave the concurrency counter
      // permanently incremented, which would block future calls in the session.
    }

    const codeStartMs = Date.now();
    let codeSuccess = false;

    const { code, language, dependencies, timeoutMs, description } = params as z.infer<typeof CodeExecuteParamsSchema>;

    // Validate dependency names
    const invalidDeps = dependencies.filter((d) => !isValidDependencyName(d));
    if (invalidDeps.length > 0) {
      return { success: false, error: `invalid dependency names: ${invalidDeps.join(', ')}`, errorCode: 'execute_code.invalid_dependencies', retryable: false, fault: false };
    }

    // Read limits from the effective capability grant so operator/user policy changes
    // govern execution timeout and output size, not just rate/concurrency.
    const codeGrant = ctx.capabilityEngine?.getGrant('execute_code');
    const runtimePolicy = getRuntimePolicy();
    if (!runtimePolicy) {
      return { success: false, error: 'execute_code requires AGENT_RUNTIME_CONFIG_JSON with tools.codeExecute defaults', errorCode: 'execute_code.missing_runtime_policy', retryable: false };
    }

    const policyTimeout = codeGrant?.limits?.timeoutMs ?? runtimePolicy.defaultTimeoutMs ?? 30_000;
    const TIMEOUT_MS = timeoutMs != null ? Math.min(timeoutMs, policyTimeout) : policyTimeout;
    const MAX_OUTPUT = codeGrant?.limits?.maxResponseBytes ?? runtimePolicy.defaultMaxOutputBytes ?? 1_048_576;

    const paths = getWorkspacePaths(ctx.agentId);
    const sandboxDir = paths.sandbox;

    let stdout = '';
    let stderr = '';
    let exitCode = 1;
    let success = false;
    let capabilityStarted = false;
    let usedSandbox = false;

    try {
      await ensureWorkspaceDirs(paths);

      // All validation passed and the sandbox is available — hold the
      // concurrency slot only for the duration of actual execution.
      ctx.capabilityEngine?.recordStart('execute_code', ctx.sessionId);
      capabilityStarted = ctx.capabilityEngine !== undefined;

      // Clean the sandbox before each invocation so artifacts from a prior run
      // (node_modules, .pylibs, leftover scripts) cannot bleed into this one.
      await rm(sandboxDir, { recursive: true, force: true });
      await mkdir(sandboxDir, { recursive: true });

      if (language === 'javascript') {
        await writeFile(`${sandboxDir}/script.js`, code, 'utf8');
        if (dependencies.length > 0) {
          const pkgJson = JSON.stringify({ name: 'sandbox', version: '1.0.0', dependencies: Object.fromEntries(dependencies.map((d) => [d, 'latest'])) });
          await writeFile(`${sandboxDir}/package.json`, pkgJson, 'utf8');
        }
      } else {
        await writeFile(`${sandboxDir}/script.py`, code, 'utf8');
        if (dependencies.length > 0) {
          await writeFile(`${sandboxDir}/requirements.txt`, dependencies.join('\n'), 'utf8');
        }
      }

      const hasSandbox = await access(SANDBOX_SCRIPT).then(() => true).catch(() => false);
      usedSandbox = hasSandbox;

      let shellCmd: string;
      if (language === 'javascript') {
        const runCmd = dependencies.length > 0
          ? `cd ${sandboxDir} && npm install --no-audit --no-fund 2>&1 && node script.js`
          : `cd ${sandboxDir} && node script.js`;
        shellCmd = hasSandbox ? `${SANDBOX_SCRIPT} sh -lc ${JSON.stringify(runCmd)}` : `sh -lc ${JSON.stringify(runCmd)}`;
      } else {
        const pyLibs = `${sandboxDir}/.pylibs`;
        await mkdir(pyLibs, { recursive: true });
        const runCmd = dependencies.length > 0
          ? `cd ${sandboxDir} && python3 -m pip install --target ${pyLibs} -q -r requirements.txt 2>&1 && PYTHONPATH=${pyLibs} python3 script.py`
          : `cd ${sandboxDir} && python3 script.py`;
        shellCmd = hasSandbox ? `${SANDBOX_SCRIPT} sh -lc ${JSON.stringify(runCmd)}` : `sh -lc ${JSON.stringify(runCmd)}`;
      }

      const result = await execAsync(shellCmd, {
        timeout: TIMEOUT_MS,
        // Collect enough raw output to apply our own truncation at MAX_OUTPUT.
        // Use at least 2 MiB so small MAX_OUTPUT values don't cause exec to error
        // before we get to slice the output ourselves.
        maxBuffer: Math.max(MAX_OUTPUT * 2, 2 * 1_048_576),
        env: hasSandbox
          ? {
            PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
            TIMEOUT: String(Math.ceil(TIMEOUT_MS / 1000)),
            // HOME is required so agent-browser resolves ~/.agent-browser/config.json correctly.
            // AGENT_BROWSER_CONFIG is the explicit config path set by the entrypoint.
            // Neither is a secret — safe to pass through the sandbox boundary.
            HOME: '/home/agent',
            ...(process.env['AGENT_BROWSER_CONFIG'] ? { AGENT_BROWSER_CONFIG: process.env['AGENT_BROWSER_CONFIG'] } : {}),
            // SANDBOX_ALLOWED_HOSTS is read by sandbox-exec.sh to add iptables allow
            // rules for specific IPs (e.g. the browser pool). Without it the sandbox
            // blocks all RFC 1918 traffic and agent-browser CDP connections time out.
            ...(process.env['SANDBOX_ALLOWED_HOSTS'] ? { SANDBOX_ALLOWED_HOSTS: process.env['SANDBOX_ALLOWED_HOSTS'] } : {}),
          }
          : process.env,
      });
      stdout = String(result.stdout || '').slice(0, MAX_OUTPUT);
      stderr = String(result.stderr || '').slice(0, 10 * 1024);
      exitCode = 0;
      success = true;
      codeSuccess = true;
    } catch (err) {
      const execErr = err as { stdout?: string; stderr?: string; message?: string; code?: number };
      stdout = String(execErr.stdout || '').slice(0, MAX_OUTPUT);
      stderr = String(execErr.stderr || execErr.message || 'execution failed').slice(0, 10 * 1024);
      exitCode = typeof execErr.code === 'number' ? execErr.code : 1;
    } finally {
      const durationMs = Date.now() - codeStartMs;
      if (ctx.capabilityEngine && capabilityStarted) {
        ctx.capabilityEngine.recordEnd('execute_code', ctx.sessionId, {
          capability: 'execute_code',
          agentId: ctx.agentId,
          sessionId: ctx.sessionId,
          timestamp: new Date().toISOString(),
          durationMs,
          inputSummary: `${code.length} bytes (${language})`,
          outputSummary: success ? `${stdout.length} bytes` : `error: ${stderr.slice(0, 100)}`,
          success: codeSuccess,
        });
      }
    }

    const durationMs = Date.now() - codeStartMs;
    const label = description ? ` (${description})` : '';

    if (success) {
      return {
        success: true,
        data: { stdout, stderr, exitCode: 0, durationMs },
      };
    }

    if (usedSandbox && isNonRecoverableSandboxError(stderr)) {
      return {
        success: false,
        data: { stdout, stderr, exitCode, durationMs },
        errorCode: 'execute_code.sandbox_infrastructure_error',
        error:
          'Sandbox infrastructure error (non-recoverable): the execute_code sandbox ' +
          'is misconfigured in this container. Do NOT retry — record this limitation ' +
          `in memory. Detail: ${stderr.slice(0, 300)}`,
        retryable: false,
        fault: false,
      };
    }

    return {
      success: false,
      data: { stdout, stderr, exitCode, durationMs },
      errorCode: 'execute_code.execution_failed',
      error: `execute_code${label} failed with exit code ${exitCode}`,
      retryable: false,
      fault: false,
    };
  },
};

export const codeTools: AgentTool[] = [
  codeExecuteTool,
];
