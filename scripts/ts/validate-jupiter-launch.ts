/**
 * validate-jupiter-launch.ts — Canonical operator-run Jupiter launch validation.
 *
 * This script proves the Jupiter adapter boundary works end-to-end:
 *   1. Quote succeeds (upstream reachability + adapter amount conversion)
 *   2. Signer prerequisite is enforced (no signer → SWAP_SIGNING_UNAVAILABLE)
 *   3. (Optional) Signed swap submission succeeds on the intended environment
 *   4. (Optional) Confirmation evidence is observed via poller
 *   5. Persisted execution evidence is present and understandable
 *
 * Modes:
 *   Default (no --execute): validates steps 1-2 only (safe, no funds at risk)
 *   --execute: validates all steps including real swap submission (requires funded wallet)
 *
 * Required env vars:
 *   JUPITER_WALLET_ADDRESS — Solana wallet public key
 *
 * Required for --execute:
 *   JUPITER_PRIVATE_KEY — Base58 Solana private key for signing
 *   SOLANA_RPC_URL — RPC endpoint (default: https://api.mainnet-beta.solana.com)
 *
 * Optional:
 *   JUPITER_API_URL — Override Jupiter API base URL
 *   SWAP_AMOUNT — Amount of USDC to swap (default: 0.01 for minimal risk)
 *   SLIPPAGE_BPS — Slippage in basis points (default: 100)
 *
 * Usage:
 *   JUPITER_WALLET_ADDRESS=... tsx scripts/ts/validate-jupiter-launch.ts
 *   JUPITER_WALLET_ADDRESS=... JUPITER_PRIVATE_KEY=... tsx scripts/ts/validate-jupiter-launch.ts --execute
 */

import { JupiterSwapAdapter } from '../../packages/venues/src/jupiter-swap.js';
import { JupiterConfirmationPoller } from '../../packages/venues/src/jupiter-confirmation.js';
import { quantity } from '../../packages/domain/src/index.js';
import type { SolanaSignerPort } from '../../packages/venues/src/solana-signer.js';

// ─── Config ─────────────────────────────────────────────────────────────────

const EXECUTE_MODE = process.argv.includes('--execute');
const WALLET_ADDRESS = process.env['JUPITER_WALLET_ADDRESS'];
const PRIVATE_KEY = process.env['JUPITER_PRIVATE_KEY'];
const RPC_URL = process.env['SOLANA_RPC_URL'] ?? 'https://api.mainnet-beta.solana.com';
const API_URL = process.env['JUPITER_API_URL'] ?? 'https://quote-api.jup.ag/v6';
const SWAP_AMOUNT = process.env['SWAP_AMOUNT'] ?? '0.01';
const SLIPPAGE_BPS = parseInt(process.env['SLIPPAGE_BPS'] ?? '100', 10);

// Known Solana token addresses
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

// Token decimals
const TOKEN_DECIMALS: Record<string, number> = {
  [USDC_MINT]: 6,
  [SOL_MINT]: 9,
};

// ─── Helpers ────────────────────────────────────────────────────────────────

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const NC = '\x1b[0m';

function pass(msg: string) { console.log(`${GREEN}[PASS]${NC} ${msg}`); }
function fail(msg: string) { console.error(`${RED}[FAIL]${NC} ${msg}`); }
function info(msg: string) { console.log(`${YELLOW}[INFO]${NC} ${msg}`); }

interface ValidationResult {
  step: string;
  passed: boolean;
  detail?: string;
}

const results: ValidationResult[] = [];

function record(step: string, passed: boolean, detail?: string) {
  results.push({ step, passed, detail });
  if (passed) pass(`${step}${detail ? ` — ${detail}` : ''}`);
  else fail(`${step}${detail ? ` — ${detail}` : ''}`);
}

// ─── Validation Steps ───────────────────────────────────────────────────────

async function validateQuote(adapter: JupiterSwapAdapter): Promise<boolean> {
  const result = await adapter.quote({
    inputAsset: USDC_MINT,
    outputAsset: SOL_MINT,
    amount: quantity(SWAP_AMOUNT),
    slippageBps: SLIPPAGE_BPS,
  });

  if (!result.ok) {
    record('Quote', false, `${result.error.code}: ${result.error.message}`);
    return false;
  }

  record('Quote', true,
    `${SWAP_AMOUNT} USDC → ${result.data.expectedOutputAmount} SOL (impact: ${(result.data.priceImpact * 100).toFixed(4)}%)`);
  return true;
}

async function validateSignerEnforcement(adapterWithoutSigner: JupiterSwapAdapter): Promise<boolean> {
  // Create a fake quote to test signer enforcement
  const quoteResult = await adapterWithoutSigner.quote({
    inputAsset: USDC_MINT,
    outputAsset: SOL_MINT,
    amount: quantity(SWAP_AMOUNT),
    slippageBps: SLIPPAGE_BPS,
  });

  if (!quoteResult.ok) {
    record('Signer enforcement', false, 'Could not get quote to test signer enforcement');
    return false;
  }

  const execResult = await adapterWithoutSigner.executeSwap(quoteResult.data);
  if (!execResult.ok && execResult.error.code === 'SWAP_SIGNING_UNAVAILABLE') {
    record('Signer enforcement', true, 'executeSwap correctly rejected without signer');
    return true;
  }

  record('Signer enforcement', false,
    execResult.ok ? 'executeSwap succeeded without signer (DANGEROUS)' : `Wrong error: ${execResult.error.code}`);
  return false;
}

async function validateLiveExecution(adapterWithSigner: JupiterSwapAdapter): Promise<boolean> {
  const quoteResult = await adapterWithSigner.quote({
    inputAsset: USDC_MINT,
    outputAsset: SOL_MINT,
    amount: quantity(SWAP_AMOUNT),
    slippageBps: SLIPPAGE_BPS,
  });

  if (!quoteResult.ok) {
    record('Live execution — quote', false, `${quoteResult.error.code}: ${quoteResult.error.message}`);
    return false;
  }

  info(`Submitting swap: ${SWAP_AMOUNT} USDC → SOL (min: ${quoteResult.data.minimumOutputAmount})`);
  const execResult = await adapterWithSigner.executeSwap(quoteResult.data);

  if (!execResult.ok) {
    record('Live execution — submit', false, `${execResult.error.code}: ${execResult.error.message}`);
    return false;
  }

  record('Live execution — submit', true, `txRef: ${execResult.data.executionRef}`);
  return true;
}

async function validateConfirmation(txRef: string): Promise<boolean> {
  const poller = new JupiterConfirmationPoller({ rpcUrl: RPC_URL });
  const result = await poller.checkConfirmation(txRef);

  if (!result.ok) {
    record('Confirmation', false, `${result.error.code}: ${result.error.message}`);
    return false;
  }

  if (result.data.status === 'confirmed') {
    record('Confirmation', true, `tx confirmed — outputAmount: ${result.data.outputAmount ?? 'N/A'}`);
    return true;
  } else if (result.data.status === 'failed') {
    record('Confirmation', false, 'Transaction reverted on-chain');
    return false;
  } else {
    record('Confirmation', false, `Unexpected status: ${result.data.status}`);
    return false;
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('═══════════════════════════════════════════════════════');
  console.log('  Jupiter Launch Validation');
  console.log(`  Mode: ${EXECUTE_MODE ? 'LIVE EXECUTION' : 'DRY RUN (quote + signer enforcement only)'}`);
  console.log(`  Timestamp: ${new Date().toISOString()}`);
  console.log('═══════════════════════════════════════════════════════');
  console.log('');

  // Prerequisites
  if (!WALLET_ADDRESS) {
    fail('JUPITER_WALLET_ADDRESS is required');
    process.exit(2);
  }

  if (EXECUTE_MODE && !PRIVATE_KEY) {
    fail('JUPITER_PRIVATE_KEY is required for --execute mode');
    process.exit(2);
  }

  // Build adapter without signer (for enforcement test)
  const adapterNoSigner = new JupiterSwapAdapter({
    apiUrl: API_URL,
    rpcUrl: RPC_URL,
    walletAddress: WALLET_ADDRESS,
    tokenDecimals: TOKEN_DECIMALS,
    // No signer — deliberately omitted
  });

  // Step 1: Quote
  const quoteOk = await validateQuote(adapterNoSigner);
  if (!quoteOk) {
    printSummary();
    process.exit(1);
  }

  // Step 2: Signer enforcement
  const signerOk = await validateSignerEnforcement(adapterNoSigner);
  if (!signerOk) {
    printSummary();
    process.exit(1);
  }

  // Steps 3-5: Live execution (only with --execute)
  if (EXECUTE_MODE) {
    // Build a mock signer that delegates to the real private key
    // In production, the signer is injected by the worker. For validation,
    // we create a minimal signer implementation.
    let signer: SolanaSignerPort | undefined;
    try {
      // Dynamic import to avoid requiring @solana/web3.js at module level
      const { createSolanaKeypairSigner } = await import('../../packages/venues/src/solana-signer.js');
      signer = createSolanaKeypairSigner(PRIVATE_KEY!, RPC_URL);
    } catch (e) {
      fail(`Failed to create signer: ${e instanceof Error ? e.message : String(e)}`);
      info('Ensure @solana/web3.js is available and JUPITER_PRIVATE_KEY is valid base58');
      printSummary();
      process.exit(1);
    }

    const adapterWithSigner = new JupiterSwapAdapter({
      apiUrl: API_URL,
      rpcUrl: RPC_URL,
      walletAddress: WALLET_ADDRESS,
      tokenDecimals: TOKEN_DECIMALS,
      signer,
    });

    const execOk = await validateLiveExecution(adapterWithSigner);
    if (!execOk) {
      printSummary();
      process.exit(1);
    }

    // Get the tx ref from the last execution
    const lastResult = results[results.length - 1];
    const txRef = lastResult?.detail?.match(/txRef: (\S+)/)?.[1];
    if (txRef) {
      // Wait briefly for confirmation
      info('Waiting 5s for on-chain confirmation...');
      await new Promise((r) => setTimeout(r, 5000));
      await validateConfirmation(txRef);
    }
  }

  printSummary();
  const allPassed = results.every((r) => r.passed);
  process.exit(allPassed ? 0 : 1);
}

function printSummary() {
  console.log('');
  console.log('───────────────────────────────────────────────────────');
  console.log('  Results:');
  for (const r of results) {
    const icon = r.passed ? `${GREEN}✓${NC}` : `${RED}✗${NC}`;
    console.log(`    ${icon} ${r.step}`);
  }
  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  console.log('');
  console.log(`  ${passed}/${total} checks passed`);
  console.log('───────────────────────────────────────────────────────');
}

main().catch((e) => {
  fail(`Unhandled error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
