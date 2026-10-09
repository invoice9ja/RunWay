import type { Address, Chain } from 'viem';

/**
 * Chain identity for the browser, read from the build environment.
 *
 * This was hardcoded to Arc testnet, which meant the chain id, the gas token and
 * the chain name in the UI all disagreed with reality the moment the deployment
 * moved. The failure is quiet rather than loud: a wallet on the wrong chain
 * produces an EIP-712 signature over the wrong domain, which is well-formed and
 * simply reverts on-chain.
 *
 * Values come from `VITE_`-prefixed variables so Vite substitutes them at build
 * time, with the current testnet deployment as the default. The RPC URL here is
 * only what a wallet is told to use; the page's own reads go through the
 * same-origin `/api/rpc` relay, because public endpoints are not reachable from a
 * web page.
 */

const readNumber = (key: string, fallback: number): number => {
  const raw = import.meta.env[key];
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};

const readString = (key: string, fallback: string): string => {
  const raw = import.meta.env[key];
  return typeof raw === 'string' && raw.length > 0 ? raw : fallback;
};

export const CHAIN_ID = readNumber('VITE_RUNWAY_CHAIN_ID', 5042002);
export const NETWORK = readString('VITE_RUNWAY_NETWORK', 'arc-testnet');
export const EXPLORER = readString('VITE_RUNWAY_EXPLORER_URL', 'https://explorer.testnet.arc.io');
export const RPC_URL = readString('VITE_RUNWAY_RPC_URL', 'https://rpc.testnet.arc.network');

/**
 * Gas is paid in USDC on Arc, 18 decimals as a native asset. The symbol differs
 * by network in practice, so it is configurable rather than assumed.
 */
export const NATIVE_CURRENCY = {
  name: readString('VITE_RUNWAY_GAS_NAME', 'Ether'),
  symbol: readString('VITE_RUNWAY_GAS_SYMBOL', 'ETH'),
  decimals: readNumber('VITE_RUNWAY_GAS_DECIMALS', 18),
};

/** Human label for the network, used in headings and status pills. */
export const NETWORK_LABEL = readString('VITE_RUNWAY_NETWORK_LABEL', 'Arc testnet');

export const ARC: Chain = {
  id: CHAIN_ID,
  name: NETWORK_LABEL,
  nativeCurrency: NATIVE_CURRENCY,
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: NETWORK_LABEL, url: EXPLORER } },
};

/**
 * USDC on Arc. The ERC-20 interface sits at the same address on testnet and
 * mainnet, so this default is correct for both; it stays overridable because that
 * is a fact about the chain that a future upgrade could change, not an invariant
 * worth hardcoding.
 */
export const USDC = readString(
  'VITE_RUNWAY_USDC_ADDRESS',
  '0x3600000000000000000000000000000000000000',
) as Address;

export const explorerAddress = (address: string) => `${EXPLORER}/address/${address}`;
export const explorerTx = (hash: string) => `${EXPLORER}/tx/${hash}`;
