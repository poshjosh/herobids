import {
  createWalletClient,
  createPublicClient,
  http,
  encodeFunctionData,
  type WalletClient,
  type PublicClient,
  type Chain,
  type TransactionReceipt,
  type SendTransactionParameters,
  type Account,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import type { Result } from '@herobids/domain';
import { ok, err } from '@herobids/domain';

export interface EvmSignerConfig {
  /** Hex-encoded private key (with or without 0x prefix) */
  privateKey: string;
  /** JSON-RPC URL for the target chain */
  rpcUrl: string;
  /** Chain ID. Default: 8453 (Base) */
  chainId?: number;
  /** Transaction confirmation timeout in ms. Default: 60000 */
  confirmationTimeoutMs?: number;
}

export interface EvmSignerError {
  code: string;
  message: string;
}

export interface TransactionRequest {
  to: `0x${string}`;
  data: `0x${string}`;
  value?: bigint;
  gas?: bigint;
}

const CHAIN_MAP: Record<number, Chain> = {
  8453: base,
};

/**
 * Thin wrapper around viem's WalletClient + PublicClient for EVM transaction signing.
 * Shared by any EVM-based venue adapter (1inch, Uniswap, Paraswap, etc.).
 */
export class EvmSigner {
  private readonly wallet: WalletClient;
  private readonly publicClient: PublicClient;
  private readonly account: Account;
  private readonly confirmationTimeoutMs: number;

  constructor(config: EvmSignerConfig) {
    const trimmed = config.privateKey.trim();
    const key = trimmed.startsWith('0x')
      ? trimmed as `0x${string}`
      : `0x${trimmed}` as `0x${string}`;

    this.account = privateKeyToAccount(key);
    const chainId = config.chainId ?? 8453;
    const chain = CHAIN_MAP[chainId];
    if (!chain) {
      throw new Error(`Unsupported chain ID: ${chainId}. Add it to CHAIN_MAP.`);
    }

    this.wallet = createWalletClient({
      account: this.account,
      chain,
      transport: http(config.rpcUrl),
    });

    this.publicClient = createPublicClient({
      chain,
      transport: http(config.rpcUrl),
    });

    this.confirmationTimeoutMs = config.confirmationTimeoutMs ?? 60_000;
  }

  /** Returns the signer's address */
  get address(): `0x${string}` {
    return this.account.address;
  }

  /** Sign, broadcast, and wait for transaction receipt */
  async sendTransaction(tx: TransactionRequest): Promise<Result<TransactionReceipt, EvmSignerError>> {
    try {
      const hash = await this.wallet.sendTransaction({
        to: tx.to,
        data: tx.data,
        value: tx.value ?? 0n,
        gas: tx.gas,
        chain: this.wallet.chain,
        account: this.account,
      } as SendTransactionParameters);

      const receipt = await this.publicClient.waitForTransactionReceipt({
        hash,
        timeout: this.confirmationTimeoutMs,
      });

      if (receipt.status === 'reverted') {
        return err({
          code: 'evm.tx_reverted',
          message: `Transaction ${hash} reverted on-chain`,
        });
      }

      return ok(receipt);
    } catch (error) {
      return err({
        code: 'evm.tx_failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Read ERC-20 balance for a token at a given address */
  async readErc20Balance(tokenAddress: `0x${string}`, ownerAddress: `0x${string}`): Promise<bigint> {
    const data = await this.publicClient.readContract({
      address: tokenAddress,
      abi: ERC20_BALANCE_ABI,
      functionName: 'balanceOf',
      args: [ownerAddress],
    });
    return data as bigint;
  }

  /** Read ERC-20 allowance for a token owner/spender pair */
  async readErc20Allowance(
    tokenAddress: `0x${string}`,
    ownerAddress: `0x${string}`,
    spenderAddress: `0x${string}`,
  ): Promise<bigint> {
    const data = await this.publicClient.readContract({
      address: tokenAddress,
      abi: ERC20_ALLOWANCE_ABI,
      functionName: 'allowance',
      args: [ownerAddress, spenderAddress],
    });
    return data as bigint;
  }

  /** Read ERC-20 decimals for a token */
  async readErc20Decimals(tokenAddress: `0x${string}`): Promise<number> {
    const data = await this.publicClient.readContract({
      address: tokenAddress,
      abi: ERC20_DECIMALS_ABI,
      functionName: 'decimals',
    });
    return Number(data);
  }

  /** Read native ETH balance */
  async readNativeBalance(address: `0x${string}`): Promise<bigint> {
    return this.publicClient.getBalance({ address });
  }

  /** Approve an ERC-20 spender for a specific amount */
  async approveErc20(
    tokenAddress: `0x${string}`,
    spenderAddress: `0x${string}`,
    amount: bigint,
  ): Promise<Result<TransactionReceipt, EvmSignerError>> {
    const data = encodeFunctionData({
      abi: ERC20_APPROVE_ABI,
      functionName: 'approve',
      args: [spenderAddress, amount],
    });

    return this.sendTransaction({
      to: tokenAddress,
      data,
      value: 0n,
    });
  }

  /** Get the public client for raw RPC calls (e.g. getLogs) */
  getPublicClient(): PublicClient {
    return this.publicClient;
  }
}

const ERC20_BALANCE_ABI = [
  {
    inputs: [{ name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

const ERC20_ALLOWANCE_ABI = [
  {
    inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }],
    name: 'allowance',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

const ERC20_DECIMALS_ABI = [
  {
    inputs: [],
    name: 'decimals',
    outputs: [{ name: '', type: 'uint8' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

const ERC20_APPROVE_ABI = [
  {
    inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
    name: 'approve',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;
