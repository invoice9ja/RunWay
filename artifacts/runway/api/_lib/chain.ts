import { createPublicClient, createWalletClient, http, defineChain } from 'viem';
import { baseSepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

import { config } from './config.js';

/**
 * The chain definition is derived from config rather than imported.
 *
 * Hardcoding `baseSepolia` here meant pointing RUNWAY_RPC_URL at Arc still
 * labelled every client as chain 84532, so chain id, EIP-712 domain and tx
 * serialization were all wrong for a different network. Arc's chain shape is
 * Base-compatible (EVM, 6-decimal USDC), so cloning the Base Sepolia definition
 * and overriding the id is accurate for both.
 */
function chainFor(chainId: number) {
  if (chainId === baseSepolia.id) return baseSepolia;
  return defineChain({
    ...baseSepolia,
    id: chainId,
    name: config.network,
    nativeCurrency: baseSepolia.nativeCurrency,
  });
}

function buildPublicClient() {
  return createPublicClient({
    chain: chainFor(config.chainId),
    transport: http(config.rpcUrl, { batch: true, retryCount: 2, timeout: 20_000 }),
  });
}

/** Separate client for `eth_getLogs`; see config.logsRpcUrl for why it differs. */
function buildLogsClient() {
  return createPublicClient({
    chain: chainFor(config.chainId),
    transport: http(config.logsRpcUrl, { batch: false, retryCount: 2, timeout: 20_000 }),
  });
}

function buildWalletClient() {
  const account = privateKeyToAccount(config.settlerKey as `0x${string}`);
  return {
    account,
    client: createWalletClient({
      account,
      chain: chainFor(config.chainId),
      transport: http(config.rpcUrl, { retryCount: 2, timeout: 20_000 }),
    }),
  };
}

export type RunwayPublicClient = ReturnType<typeof buildPublicClient>;
export type RunwayWalletClient = ReturnType<typeof buildWalletClient>['client'];

let logsClient: RunwayPublicClient | undefined;

export function getLogsClient(): RunwayPublicClient {
  if (config.logsRpcUrl === config.rpcUrl) return getPublicClient();
  logsClient ??= buildLogsClient();
  return logsClient;
}

let publicClient: RunwayPublicClient | undefined;
let wallet: { account: ReturnType<typeof privateKeyToAccount>; client: RunwayWalletClient } | undefined;

export function getPublicClient(): RunwayPublicClient {
  publicClient ??= buildPublicClient();
  return publicClient;
}

/** Returns undefined when no operational key is configured (read-only mode). */
export function getAccount() {
  if (!config.settlerKey) return undefined;
  return getWalletBundle().account;
}

export function getWalletClient(): RunwayWalletClient | undefined {
  if (!config.settlerKey) return undefined;
  return getWalletBundle().client;
}

function getWalletBundle() {
  wallet ??= buildWalletClient();
  return wallet;
}

export function requireWalletClient(): RunwayWalletClient {
  const client = getWalletClient();
  if (!client) {
    throw new Error(
      'RUNWAY_PRIVATE_KEY is not set. The operational signer is required for this action.',
    );
  }
  return client;
}