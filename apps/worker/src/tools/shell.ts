import { z } from 'zod';
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { access } from 'node:fs/promises';
import { createLogger } from '../logger.js';
import type { AgentTool, ToolResult, ToolContext } from '@herobids/domain';
import { convertZodToJsonSchema } from './registry.js';
import { getWorkspacePaths, resolveWorkspacePath } from './workspace.js';
import { capabilityDeniedResult } from './tool-errors.js';
import {
  SANDBOX_SCRIPT,
  isNonRecoverableSandboxError,
  getRuntimePolicy,
} from './sandbox-utils.js';

const execAsync = promisify(execCb);
const logger = createLogger('tools:shell');

const ShellExecuteParamsSchema = z.object({
  command: z.string().min(1).describe('Shell command to execute'),
  timeoutMs: z.coerce.number().int().min(1_000).max(600_000).optional()
    .describe('Execution timeout in milliseconds (1000-600000)'),
  workingDir: z.string().optional()
    .describe('Working directory relative to workspace root'),
  description: z.string().optional()
    .describe('Brief description of what this command does. For audit/logging.'),
});

const executeShellTool: AgentTool = {
  name: 'execute_shell',
  description:
    'Execute arbitrary shell commands in the agent workspace. ' +
    'Available at standard and full permission levels. ' +
    'Use for git operations, build tools, package management, and system tasks.',
  parametersSchema: ShellExecuteParamsSchema,
  parameters: convertZodToJsonSchema(ShellExecuteParamsSchema),
  category: 'execute-filesystem',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    // Enforce capability policy — rate limit, concurrency, enable/disable.
    if (ctx.capabilityEngine) {
      const policyDenied = ctx.capabilityEngine.checkAccess('execute_shell', ctx.agentId, ctx.sessionId);
      if (policyDenied) {
        logger.warn({
          agentId: ctx.agentId,
          capability: 'execute_shell',
          reason: policyDenied.reason,
          limit: policyDenied.limit,
          used: policyDenied.used,
          retryAfterMs: policyDenied.retryAfterMs,
        }, 'Capability policy denied');
        return capabilityDeniedResult('execute_shell', policyDenied);
      }
    }

    const startMs = Date.now();
    let execSuccess = false;

    const { command, timeoutMs, workingDir, description } = params as z.infer<typeof ShellExecuteParamsSchema>;

    const permissionLevel = ctx.permissionLevel;

    // Fail-closed: restricted agents must never reach this tool (gated by visibility),
    // but reject if somehow invoked.
    if (permissionLevel === 'restricted') {
      return {
        success: false,
        error: 'execute_shell is not available at the restricted permission level. Use execute_code instead.',
        errorCode: 'execute_shell.permission_denied',
        retryable: false,
        fault: false,
      };
    }

    // Read limits from the capability grant and runtime policy.
    const shellGrant = ctx.capabilityEngine?.getGrant('execute_shell');
    const runtimePolicy = getRuntimePolicy();
    if (!runtimePolicy) {
      return {
        success: false,
        error: 'execute_shell requires AGENT_RUNTIME_CONFIG_JSON with tools.codeExecute defaults',
        errorCode: 'execute_shell.missing_runtime_policy',
        retryable: false,
      };
    }

    const policyTimeout = shellGrant?.limits?.timeoutMs ?? runtimePolicy.defaultTimeoutMs ?? 120_000;
    const TIMEOUT_MS = timeoutMs != null ? Math.min(timeoutMs, policyTimeout) : policyTimeout;
    const MAX_OUTPUT = shellGrant?.limits?.maxResponseBytes ?? runtimePolicy.defaultMaxOutputBytes ?? 1_048_576;

    // Resolve working directory.
    const paths = getWorkspacePaths(ctx.agentId);
    let cwd = paths.root;

    if (workingDir) {
      // For standard level, validate working directory stays inside workspace.
      // Full level can access the entire container filesystem.
      if (permissionLevel === 'full') {
        // Full mode: allow absolute paths and paths outside workspace.
        cwd = workingDir.startsWith('/') ? workingDir : resolve(paths.root, workingDir);
      } else {
        const resolved = await resolveWorkspacePath(paths.root, workingDir);
        if (!resolved.ok) {
          return {
            success: false,
            error: `Invalid working directory: ${resolved.error}`,
            errorCode: 'execute_shell.invalid_working_dir',
            retryable: false,
            fault: false,
          };
        }
        cwd = resolved.absolutePath;
      }
    }

    let stdout = '';
    let stderr = '';
    let exitCode = 1;
    let success = false;
    let capabilityStarted = false;
    let usedSandbox = false;

    try {
      // All validation passed — hold the concurrency slot for execution.
      ctx.capabilityEngine?.recordStart('execute_shell', ctx.sessionId);
      capabilityStarted = ctx.capabilityEngine !== undefined;

      const hasSandbox = await access(SANDBOX_SCRIPT).then(() => true).catch(() => false);
      usedSandbox = hasSandbox;

      // Build the shell command:
      // - All levels are wrapped with sandbox-exec.sh for network isolation.
      // - Standard mode drops to the non-root 'agent' user for the inner command.
      // - Full mode runs as root (container's default user) — no sudo needed.
      let shellCmd: string;
      const innerCmd = permissionLevel === 'full'
        ? `sh -lc ${JSON.stringify(command)}`
        : `sudo -u agent sh -lc ${JSON.stringify(command)}`;

      shellCmd = hasSandbox
        ? `${SANDBOX_SCRIPT} ${innerCmd}`
        : innerCmd;

      const result = await execAsync(shellCmd, {
        timeout: TIMEOUT_MS,
        maxBuffer: Math.max(MAX_OUTPUT * 2, 2 * 1_048_576),
        cwd,
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
      execSuccess = true;
    } catch (err) {
      const execErr = err as { stdout?: string; stderr?: string; message?: string; code?: number };
      stdout = String(execErr.stdout || '').slice(0, MAX_OUTPUT);
      stderr = String(execErr.stderr || execErr.message || 'execution failed').slice(0, 10 * 1024);
      exitCode = typeof execErr.code === 'number' ? execErr.code : 1;
    } finally {
      const durationMs = Date.now() - startMs;
      if (ctx.capabilityEngine && capabilityStarted) {
        ctx.capabilityEngine.recordEnd('execute_shell', ctx.sessionId, {
          capability: 'execute_shell',
          agentId: ctx.agentId,
          sessionId: ctx.sessionId,
          timestamp: new Date().toISOString(),
          durationMs,
          inputSummary: description ?? `${command.slice(0, 100)}`,
          outputSummary: success ? `${stdout.length} bytes` : `error: ${stderr.slice(0, 100)}`,
          success: execSuccess,
        });
      }
    }

    const durationMs = Date.now() - startMs;

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
        errorCode: 'execute_shell.sandbox_infrastructure_error',
        error:
          'Sandbox infrastructure error (non-recoverable): the execute_shell sandbox ' +
          'is misconfigured in this container. Do NOT retry — record this limitation ' +
          `in memory. Detail: ${stderr.slice(0, 300)}`,
        retryable: false,
        fault: false,
      };
    }

    return {
      success: false,
      data: { stdout, stderr, exitCode, durationMs },
      errorCode: 'execute_shell.execution_failed',
      error: `execute_shell failed with exit code ${exitCode}`,
      retryable: false,
      fault: false,
    };
  },
};

export const shellTools: AgentTool[] = [executeShellTool];
