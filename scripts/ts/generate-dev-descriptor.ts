/**
 * Generates the committed DEV-signed external-backend descriptor for `traderton`
 * (Phase 3 T4.2, Decision 5). Replaces the deleted T3.3 ephemeral in-process stub
 * (`apps/worker/src/external-backend/stub-descriptor-source.ts`): trust now comes
 * from a committed public key in `config/default.yaml`, not a runtime key splice.
 *
 * What it writes:
 *   - config/external-backends/traderton.descriptor.json  (COMMITTED)
 *       the signed `{ descriptor, signature, keyId }` wrapper the worker serves to
 *       trading agents so their skills resolve tools via the generic trust path.
 *   - config/external-backends/traderton.descriptor.pub.pem (COMMITTED)
 *       the PEM SPKI public key that verifies the wrapper. Paste its contents into
 *       `config/default.yaml → externalBackends.traderton.trustedDescriptorSigningKeys`.
 *   - config/external-backends/traderton.descriptor.dev-key.pem (GITIGNORED)
 *       the ed25519 private key. NEVER committed (see .gitignore). Only needed to
 *       re-sign; the runtime verifies with the committed public key alone.
 *
 * The descriptor binds the three D11 refs (`traderton/skills/crypto-trading` |
 * `crypto-bot-management` | `crypto-risk-monitoring`) → the current built-in
 * trading tool schemas (name/description/category from TOOL_CATALOG, same source
 * the stub mirrored), so the visible tool set stays byte-identical (parity) and
 * the DT4 category cross-check passes by construction.
 *
 * DETERMINISM: a fresh ed25519 keypair is generated each run (non-deterministic).
 * Regenerating therefore changes the signature AND the public key together — both
 * the committed descriptor JSON and the committed public key (and the config value
 * pasted from it) must be regenerated as a set. The private key stays gitignored.
 *
 * Usage (from the herobids repo root):
 *   pnpm --filter @herobids/scripts run generate-dev-descriptor
 */

import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  BUILTIN_TRADING_SOURCE_REFS,
  SYSTEM_SKILLS,
  getToolCatalogEntry,
  type SkillDefinition,
} from '@herobids/domain';
import {
  canonicalizeJcs,
  type Descriptor,
  type DescriptorTool,
  type DescriptorWrapper,
} from '@herobids/domain/external-backend';

const BACKEND_ID = 'traderton';
/** Stable keyId for the committed dev key; must equal the config keyId. */
const KEY_ID = 'traderton-dev-1';
/** The three built-in trading skills whose requiredTools the descriptor binds. */
const TRADING_SKILL_IDS = new Set(['trading', 'bot-management', 'risk-monitoring']);

const OUTPUT_DIR = resolve(import.meta.dirname, '../../config/external-backends');
const DESCRIPTOR_FILE = resolve(OUTPUT_DIR, 'traderton.descriptor.json');
const PUBLIC_KEY_FILE = resolve(OUTPUT_DIR, 'traderton.descriptor.pub.pem');
const PRIVATE_KEY_FILE = resolve(OUTPUT_DIR, 'traderton.descriptor.dev-key.pem');

/**
 * Mirror a registered trading tool into a `DescriptorTool`. `description` and
 * `category` come from `TOOL_CATALOG` (the same registry the runtime cross-checks
 * via DT4), so the committed descriptor's category always equals the catalog's.
 * `inputSchema` is a minimal valid object schema — visibility keys on tool NAMES,
 * and the DT4 tools/list cross-check (which compares inputSchema) is not run in
 * the visibility path.
 */
function toolToDescriptorTool(toolName: string): DescriptorTool {
  const entry = getToolCatalogEntry(toolName);
  if (entry === undefined) {
    throw new Error(`generate-dev-descriptor: tool "${toolName}" has no TOOL_CATALOG entry`);
  }
  return {
    name: toolName,
    description: entry.description,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    category: entry.category,
  };
}

/** One descriptor sourceSkill per built-in trading skill, keyed by its D11 ref. */
function buildSourceSkills(tradingSkills: readonly SkillDefinition[]): Descriptor['sourceSkills'] {
  return tradingSkills.map((skill) => {
    const ref = BUILTIN_TRADING_SOURCE_REFS[skill.id];
    if (ref === undefined) {
      throw new Error(`generate-dev-descriptor: skill "${skill.id}" has no D11 source ref`);
    }
    return { ref, instructions: skill.instructions, tools: skill.requiredTools.map(toolToDescriptorTool) };
  });
}

function main(): void {
  const tradingSkills = SYSTEM_SKILLS.filter((skill) => TRADING_SKILL_IDS.has(skill.id));
  if (tradingSkills.length !== TRADING_SKILL_IDS.size) {
    throw new Error(
      `generate-dev-descriptor: expected ${TRADING_SKILL_IDS.size} built-in trading skills, found ${tradingSkills.length}`,
    );
  }

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

  const now = new Date();
  // A wide dev validity window: issued an hour ago, expires in a decade. maxAge
  // pinning (config) bounds cache age, not issuedAt age (Step 10 §3).
  const issuedAt = new Date(now.getTime() - 3_600_000).toISOString();
  const expiresAt = new Date(now.getTime() + 10 * 365 * 24 * 3_600_000).toISOString();

  const descriptor: Descriptor = {
    descriptorVersion: 'traderton-dev.1',
    backendId: BACKEND_ID,
    issuedAt,
    expiresAt,
    sourceSkills: buildSourceSkills(tradingSkills),
  };

  const signature = sign(null, Buffer.from(canonicalizeJcs(descriptor), 'utf8'), privateKey).toString('base64');
  const wrapper: DescriptorWrapper = { descriptor, signature, keyId: KEY_ID };

  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(DESCRIPTOR_FILE, `${JSON.stringify(wrapper, null, 2)}\n`, 'utf8');
  writeFileSync(PUBLIC_KEY_FILE, publicKeyPem.endsWith('\n') ? publicKeyPem : `${publicKeyPem}\n`, 'utf8');
  writeFileSync(PRIVATE_KEY_FILE, privateKeyPem.endsWith('\n') ? privateKeyPem : `${privateKeyPem}\n`, 'utf8');

  process.stdout.write(
    [
      `Wrote ${DESCRIPTOR_FILE}`,
      `Wrote ${PUBLIC_KEY_FILE} (keyId: ${KEY_ID})`,
      `Wrote ${PRIVATE_KEY_FILE} (GITIGNORED — do not commit)`,
      '',
      'Paste the public key below into config/default.yaml',
      '  externalBackends.traderton.trustedDescriptorSigningKeys[0].publicKey:',
      '',
      publicKeyPem,
    ].join('\n'),
  );
}

main();
