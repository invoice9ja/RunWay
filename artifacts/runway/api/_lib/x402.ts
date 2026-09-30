import type { Address, Hex } from 'viem';

import { config } from './config.js';

export const X402_VERSION = 1;

/** Circle FiatTokenV2 (USDC) uses a fixed EIP-712 domain, not EIP-5267. */
export const usdcDomain = () =>
  ({
    name: 'USDC',
    version: '2',
    chainId: config.chainId,
    verifyingContract: config.usdc,
  }) as const;

/** EIP-3009 `TransferWithAuthorization` struct. */
export const transferWithAuthorizationTypes = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

export type PaymentRequirements = {
  scheme: 'exact';
  network: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: Address;
  maxTimeoutSeconds: number;
  asset: Address;
  extra: { name: string; version: string };
};

export type PaymentChallenge = {
  x402Version: number;
  error: string;
  accepts: PaymentRequirements[];
};

export type Authorization = {
  from: Address;
  to: Address;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
};

export type PaymentPayload = {
  x402Version: number;
  scheme: 'exact';
  network: string;
  payload: { signature: Hex; authorization: Authorization };
};

export type PaymentResponse = {
  success: boolean;
  transaction: Hex;
  network: string;
  payer: Address;
};

export function buildChallenge(
  resource: string,
  payTo: Address,
  amount: bigint,
  description: string,
): PaymentChallenge {
  return {
    x402Version: X402_VERSION,
    error: 'X-PAYMENT header is required',
    accepts: [
      {
        scheme: 'exact',
        network: config.network,
        maxAmountRequired: amount.toString(),
        resource,
        description,
        mimeType: 'application/json',
        payTo,
        maxTimeoutSeconds: 300,
        asset: config.usdc,
        extra: { name: 'USDC', version: '2' },
      },
    ],
  };
}

export function encodeHeader(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

export function decodeHeader<T>(value: string): T {
  const normalized = value.trim();
  const json = normalized.startsWith('{')
    ? normalized
    : Buffer.from(normalized, 'base64').toString('utf8');
  return JSON.parse(json) as T;
}

export function parseAmount(input: unknown, fallback: bigint): bigint {
  if (typeof input !== 'string' || !/^\d+$/.test(input)) return fallback;
  const parsed = BigInt(input);
  return parsed > 0n ? parsed : fallback;
}
