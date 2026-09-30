import { createPublicClient, createWalletClient, http } from 'viem';
import { baseSepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

import { config } from './config.js';

function buildPublicClient() {
  return createPublicClient({
    chain: baseSepolia,
    transport: http(config.rpcUrl, { batch: true, retryCount: 2, timeout: 20_000 }),
  });
}

function buildWalletClient() {
  const account = privateKeyToAccount(config.settlerKey as `0x${string}`);
  return {
    account,
    client: createWalletClient({
      account,
      chain: baseSepolia,
      transport: http(config.rpcUrl, { retryCount: 2, timeout: 20_000 }),
    }),
  };
}

export type RunwayPublicClient = ReturnType<typeof buildPublicClient>;
export type RunwayWalletClient = ReturnType<typeof buildWalletClient>['client'];

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
