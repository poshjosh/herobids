import {
  FileToolsConfigSchema,
  WebCacheConfigSchema,
  type FileToolsConfig,
  type WebCacheConfig,
} from '@herobids/domain';
import { z } from 'zod';

const BYTES_PER_MIB = 1024 * 1024;

/** Mirrors `agentRuntime.sandboxDefaults.workspaceDiskMb`; the default lives in the domain schema. */
const SandboxDefaultsQuotaSchema = z.object({
  workspaceDiskMb: z.number().int().min(1).default(100),
}).default({});

const QuotaEnvSchema = z.coerce.number().int().min(1);

interface RuntimeConfigShape {
  tools?: { files?: unknown; webAccess?: { webCache?: unknown } };
  sandboxDefaults?: unknown;
}

interface Memo<T> {
  raw: string | undefined;
  value: T;
}

let filesMemo: Memo<FileToolsConfig> | undefined;
let cacheMemo: Memo<WebCacheConfig> | undefined;

/**
 * Parse AGENT_RUNTIME_CONFIG_JSON (injected by the worker). Evaluated at call time so
 * tests can change the env. Missing or unreadable JSON is treated as "no config", so
 * the Zod schema defaults apply (an older worker that sends no `tools.files` still works).
 */
function readRuntimeConfig(raw: string | undefined): RuntimeConfigShape {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as RuntimeConfigShape) : {};
  } catch {
    return {};
  }
}

/** Effective file tool limits. Defaults come from `FileToolsConfigSchema`. */
export function getFileToolLimits(): FileToolsConfig {
  const raw = process.env['AGENT_RUNTIME_CONFIG_JSON'];
  if (filesMemo && filesMemo.raw === raw) return filesMemo.value;
  const value = FileToolsConfigSchema.parse(readRuntimeConfig(raw).tools?.files);
  filesMemo = { raw, value };
  return value;
}

/** Effective web cache settings. Defaults come from `WebCacheConfigSchema`. */
export function getWebCacheConfig(): WebCacheConfig {
  const raw = process.env['AGENT_RUNTIME_CONFIG_JSON'];
  if (cacheMemo && cacheMemo.raw === raw) return cacheMemo.value;
  const value = WebCacheConfigSchema.parse(readRuntimeConfig(raw).tools?.webAccess?.webCache);
  cacheMemo = { raw, value };
  return value;
}

/**
 * Soft workspace quota in bytes. Source order: the per-tier env var set by the
 * launcher, then `sandboxDefaults.workspaceDiskMb` from the runtime config, then
 * the schema default. A quota therefore always exists.
 */
export function getWorkspaceQuotaBytes(): number {
  const fromEnv = QuotaEnvSchema.safeParse(process.env['AGENT_WORKSPACE_QUOTA_MB']);
  if (fromEnv.success) return fromEnv.data * BYTES_PER_MIB;
  const defaults = SandboxDefaultsQuotaSchema.parse(
    readRuntimeConfig(process.env['AGENT_RUNTIME_CONFIG_JSON']).sandboxDefaults,
  );
  return defaults.workspaceDiskMb * BYTES_PER_MIB;
}
