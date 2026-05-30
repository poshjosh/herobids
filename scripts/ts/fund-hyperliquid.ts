/**
 * fund-hyperliquid.ts — One-time: bridge USDC from Base → Hyperliquid via Across + Arbitrum.
 *
 * What it does (in order):
 *   1. Check USDC balance on Base
 *   2. Get a bridge quote from Across Protocol (Base → Arbitrum, USDC → USDC)
 *   3. Approve USDC on Base for the Across SpokePool
 *   4. Submit the Across deposit on Base
 *   5. Poll Across until the bridge fills on Arbitrum (~1–4 min)
 *   6. Approve USDC on Arbitrum for the Hyperliquid bridge
 *   7. Deposit USDC into Hyperliquid from Arbitrum
 *
 * Required env vars:
 *   BASE_WALLET_PRIVATE_KEY       EVM private key (0x...) — same key works on Base + Arbitrum
 *   HYPERLIQUID_ACCOUNT_ADDRESS   Your main Hyperliquid account address (shown top-right on
 *                                 app.hyperliquid.xyz, e.g. 0xfaa3...)
 *   AMOUNT_USDC                   Integer USD amount to bridge, e.g. 20
 *
 * Usage:
 *   pnpm --filter @herobids/scripts fund-hyperliquid:dry   # simulate — no transactions sent
 *   pnpm --filter @herobids/scripts fund-hyperliquid       # execute (confirms before each tx)
 *
 * Contract addresses:
 *   Base USDC (native):       0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913  (canonical)
 *   Arbitrum USDC (native):   0xaf88d065e77c8cC2239327C5EDb3A432268e5831  (canonical)
 *   Across SpokePool (Base):  fetched live from Across API quote response
 *   Hyperliquid bridge (Arb): 0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7
 *                             VERIFY at https://arbiscan.io/address/0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7
 *                             before first use — confirm it is labelled "Hyperliquid" on Arbiscan.
 */

import {
  createWalletClient,
  createPublicClient,
  http,
  parseUnits,
  formatUnits,
  type Hex,
  type Address,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, arbitrum } from 'viem/chains';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

// ---------------------------------------------------------------------------
// Contract addresses
// ---------------------------------------------------------------------------

const USDC_BASE     = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address;
const USDC_ARB      = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' as Address;
const HL_BRIDGE_ARB = '0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7' as Address;

const ACROSS_API    = 'https://app.across.to/api';
const BASE_CHAIN_ID = 8453;
const ARB_CHAIN_ID  = 42161;

// ---------------------------------------------------------------------------
// ABIs (minimal)
// ---------------------------------------------------------------------------

const erc20Abi = [
  {
    name: 'approve',
    type: 'function',
    inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
  },
  {
    name: 'balanceOf',
    type: 'function',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    name: 'allowance',
    type: 'function',
    inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
] as const;

// Across V3 SpokePool — https://docs.across.to/contracts/deployments
const spokePoolAbi = [
  {
    name: 'depositV3',
    type: 'function',
    inputs: [
      { name: 'depositor',           type: 'address' },
      { name: 'recipient',           type: 'address' },
      { name: 'inputToken',          type: 'address' },
      { name: 'outputToken',         type: 'address' },
      { name: 'inputAmount',         type: 'uint256' },
      { name: 'outputAmount',        type: 'uint256' },
      { name: 'destinationChainId',  type: 'uint256' },
      { name: 'exclusiveRelayer',    type: 'address' },
      { name: 'quoteTimestamp',      type: 'uint32'  },
      { name: 'fillDeadline',        type: 'uint32'  },
      { name: 'exclusivityDeadline', type: 'uint32'  },
      { name: 'message',             type: 'bytes'   },
    ],
    outputs: [],
    stateMutability: 'payable',
  },
] as const;

// Hyperliquid bridge on Arbitrum — VERIFY function name on Arbiscan before first use
const hlBridgeAbi = [
  {
    name: 'usdDeposit',
    type: 'function',
    inputs: [
      { name: 'destination', type: 'address' },
      { name: 'amount',      type: 'uint64'  },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DRY_RUN = process.argv.includes('--dry-run');

async function confirm(rl: readline.Interface, question: string): Promise<void> {
  const answer = await rl.question(`\n  ${question} (yes/no): `);
  if (answer.trim().toLowerCase() !== 'yes') {
    console.log('  Aborted.');
    process.exit(0);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

interface AcrossQuote {
  spokePoolAddress: Address;
  timestamp: number;
  outputAmount: bigint;
  exclusiveRelayer: Address;
  exclusivityDeadline: number;
  fillDeadline: number;
  expectedFillTimeSec: number;
}

async function getAcrossQuote(amount: bigint): Promise<AcrossQuote> {
  const params = new URLSearchParams({
    inputToken:          USDC_BASE,
    outputToken:         USDC_ARB,
    originChainId:       String(BASE_CHAIN_ID),
    destinationChainId:  String(ARB_CHAIN_ID),
    amount:              String(amount),
    relayer:             '0x0000000000000000000000000000000000000000',
  });

  const res = await fetch(`${ACROSS_API}/suggested-fees?${params}`);
  if (!res.ok) throw new Error(`Across API error ${res.status}: ${await res.text()}`);

  const data = await res.json() as Record<string, unknown>;
  if (data['isAmountTooLow']) throw new Error('Amount is too low for Across bridge (try a larger amount)');

  return {
    spokePoolAddress:    data['spokePoolAddress'] as Address,
    timestamp:           Number(data['timestamp']),
    outputAmount:        BigInt(data['outputAmount'] as string),
    exclusiveRelayer:    (data['exclusiveRelayer'] ?? '0x0000000000000000000000000000000000000000') as Address,
    exclusivityDeadline: Number(data['exclusivityDeadline'] ?? 0),
    fillDeadline:        Number(data['fillDeadline']),
    expectedFillTimeSec: Number(data['expectedFillTimeSec'] ?? 120),
  };
}

async function pollAcrossFill(depositId: string, timeoutSec: number): Promise<void> {
  const deadline = Date.now() + timeoutSec * 1_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${ACROSS_API}/deposit/status?originChainId=${BASE_CHAIN_ID}&depositId=${depositId}`);
      if (res.ok) {
        const data = await res.json() as Record<string, unknown>;
        const status = String(data['status'] ?? 'pending');
        process.stdout.write(`\r  Bridge status: ${status}                `);
        if (status === 'filled') { console.log(''); return; }
      }
    } catch { /* ignore transient poll errors */ }
    await sleep(5_000);
  }
  throw new Error(`Bridge did not fill within ${timeoutSec}s. Check https://app.across.to for status.`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const privateKey    = process.env['BASE_WALLET_PRIVATE_KEY'] as Hex | undefined;
  const hlRecipient   = process.env['HYPERLIQUID_ACCOUNT_ADDRESS'] as Address | undefined;
  const amountUsdcStr = process.env['AMOUNT_USDC'];

  if (!privateKey)    throw new Error('BASE_WALLET_PRIVATE_KEY not set');
  if (!hlRecipient)   throw new Error('HYPERLIQUID_ACCOUNT_ADDRESS not set — your main Hyperliquid account address (0x...)');
  if (!amountUsdcStr) throw new Error('AMOUNT_USDC not set — e.g. export AMOUNT_USDC=20');

  const amountUsdc = parseUnits(amountUsdcStr, 6);
  const account = privateKeyToAccount(privateKey);

  console.log('');
  console.log('=== Hyperliquid Funding — Base → Arbitrum → Hyperliquid ===');
  if (DRY_RUN) console.log('  MODE: DRY RUN — no transactions will be sent');
  console.log(`  Wallet:       ${account.address}`);
  console.log(`  HL recipient: ${hlRecipient}`);
  console.log(`  Amount:       ${amountUsdcStr} USDC`);
  console.log('');
  console.log('  Verify Hyperliquid bridge before proceeding:');
  console.log(`  https://arbiscan.io/address/${HL_BRIDGE_ARB}`);
  console.log('  It should be labelled "Hyperliquid" on Arbiscan.');

  const rl = readline.createInterface({ input, output });

  if (!DRY_RUN) {
    await confirm(rl, 'Have you verified the bridge contract on Arbiscan?');
  }

  const basePublic = createPublicClient({ chain: base,     transport: http() });
  const arbPublic  = createPublicClient({ chain: arbitrum, transport: http() });
  const baseWallet = createWalletClient({ account, chain: base,     transport: http() });
  const arbWallet  = createWalletClient({ account, chain: arbitrum, transport: http() });

  // Step 1: Base USDC balance
  console.log('\nStep 1/7: Checking USDC balance on Base...');
  const baseBalance = await basePublic.readContract({
    address: USDC_BASE, abi: erc20Abi, functionName: 'balanceOf', args: [account.address],
  });
  console.log(`  Balance: ${formatUnits(baseBalance, 6)} USDC`);
  if (baseBalance < amountUsdc) {
    throw new Error(`Insufficient: have ${formatUnits(baseBalance, 6)} USDC, need ${amountUsdcStr}`);
  }

  // Step 2: Across quote
  console.log('\nStep 2/7: Getting Across bridge quote...');
  const quote = await getAcrossQuote(amountUsdc);
  const outputFormatted = formatUnits(quote.outputAmount, 6);
  const feeCost = (Number(amountUsdcStr) - Number(outputFormatted)).toFixed(4);
  console.log(`  SpokePool:     ${quote.spokePoolAddress}`);
  console.log(`  You receive:   ${outputFormatted} USDC on Arbitrum`);
  console.log(`  Bridge fee:    ~$${feeCost}`);
  console.log(`  Expected time: ~${quote.expectedFillTimeSec}s`);

  if (!DRY_RUN) {
    await confirm(rl, `Bridge ${amountUsdcStr} USDC Base → Arbitrum (fee ~$${feeCost})?`);
  }

  // Step 3: Approve USDC on Base
  console.log('\nStep 3/7: Approving USDC on Base for Across SpokePool...');
  if (!DRY_RUN) {
    const allowance = await basePublic.readContract({
      address: USDC_BASE, abi: erc20Abi, functionName: 'allowance',
      args: [account.address, quote.spokePoolAddress],
    });
    if (allowance < amountUsdc) {
      const tx = await baseWallet.writeContract({
        address: USDC_BASE, abi: erc20Abi, functionName: 'approve',
        args: [quote.spokePoolAddress, amountUsdc],
      });
      console.log(`  Tx: ${tx}`);
      await basePublic.waitForTransactionReceipt({ hash: tx });
      console.log('  Approved.');
    } else {
      console.log('  Already approved.');
    }
  } else {
    console.log('  [dry-run] Would approve USDC on Base.');
  }

  // Step 4: Across deposit on Base
  console.log('\nStep 4/7: Submitting Across deposit on Base...');
  const fillDeadline = Math.floor(Date.now() / 1000) + 3600;

  if (!DRY_RUN) {
    const depositTx = await baseWallet.writeContract({
      address: quote.spokePoolAddress,
      abi: spokePoolAbi,
      functionName: 'depositV3',
      args: [
        account.address,
        account.address,
        USDC_BASE,
        USDC_ARB,
        amountUsdc,
        quote.outputAmount,
        BigInt(ARB_CHAIN_ID),
        quote.exclusiveRelayer,
        quote.timestamp,
        fillDeadline,
        quote.exclusivityDeadline,
        '0x',
      ],
    });
    console.log(`  Tx: ${depositTx}`);
    const receipt = await basePublic.waitForTransactionReceipt({ hash: depositTx });
    console.log(`  Confirmed in block ${receipt.blockNumber}`);

    const depositId = receipt.logs[0]?.topics[1] ?? 'unknown';
    console.log(`  Deposit ID: ${depositId}`);

    // Step 5: Wait for Across fill
    console.log('\nStep 5/7: Waiting for Across to fill on Arbitrum...');
    await pollAcrossFill(depositId, quote.expectedFillTimeSec + 180);
    console.log('  Bridge complete — USDC is on Arbitrum.');
  } else {
    console.log('  [dry-run] Would deposit to Across SpokePool on Base.');
    console.log('  [dry-run] Would wait for Across bridge fill (~1–4 min).');
  }

  // Step 6: Check Arbitrum balance + approve HL bridge
  console.log('\nStep 6/7: Checking USDC balance on Arbitrum...');
  if (!DRY_RUN) {
    const arbBalance = await arbPublic.readContract({
      address: USDC_ARB, abi: erc20Abi, functionName: 'balanceOf', args: [account.address],
    });
    console.log(`  Arbitrum USDC: ${formatUnits(arbBalance, 6)}`);
    if (arbBalance < quote.outputAmount) {
      throw new Error(`Expected ${outputFormatted} USDC on Arbitrum but found ${formatUnits(arbBalance, 6)}. Bridge may not have settled.`);
    }

    console.log('\nStep 7/7: Approving + depositing to Hyperliquid bridge...');
    await confirm(rl, `Deposit ${outputFormatted} USDC to Hyperliquid (recipient: ${hlRecipient})?`);

    const hlAllowance = await arbPublic.readContract({
      address: USDC_ARB, abi: erc20Abi, functionName: 'allowance',
      args: [account.address, HL_BRIDGE_ARB],
    });
    if (hlAllowance < quote.outputAmount) {
      const approveTx = await arbWallet.writeContract({
        address: USDC_ARB, abi: erc20Abi, functionName: 'approve',
        args: [HL_BRIDGE_ARB, quote.outputAmount],
      });
      console.log(`  Approve tx: ${approveTx}`);
      await arbPublic.waitForTransactionReceipt({ hash: approveTx });
    }

    const depositTx = await arbWallet.writeContract({
      address: HL_BRIDGE_ARB,
      abi: hlBridgeAbi,
      functionName: 'usdDeposit',
      args: [hlRecipient, quote.outputAmount],
    });
    console.log(`  Deposit tx: ${depositTx}`);
    await arbPublic.waitForTransactionReceipt({ hash: depositTx });
    console.log('  Deposit confirmed.');
  } else {
    console.log('  [dry-run] Would approve USDC on Arbitrum for Hyperliquid bridge.');
    console.log('  [dry-run] Would call usdDeposit on Hyperliquid bridge.');
  }

  console.log('');
  if (DRY_RUN) {
    console.log('=== Dry run complete. Re-run without --dry-run to execute. ===');
  } else {
    console.log('=== Done. ===');
    console.log(`  USDC deposited to Hyperliquid account: ${hlRecipient}`);
    console.log('  Allow 1–2 min for your Hyperliquid balance to update.');
    console.log('  Then: app.hyperliquid.xyz → API → Authorize your API wallet.');
  }

  rl.close();
}

main().catch((err) => {
  console.error('Error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
