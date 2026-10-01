import {
  createPublicClient,
  createWalletClient,
  custom,
  formatUnits,
  http,
  keccak256,
  type Address,
  type EIP1193Provider,
  type PublicClient,
  type WalletClient,
} from 'viem';

import { erc20Abi } from '../../api/_lib/abi';

/**
 * Browser wallet connection for paying Runway sellers.
 *
 * Built on viem's EIP-1193 support rather than wagmi. One wallet abstraction is
 * all this needs, and the repo has no reason to take on a dependency tree that
 * large for a connect button and a signature.
 *
 * The chain is defined inline because the EIP-712 domain a payer signs is scoped
 * to a chainId. If the connected wallet is on the wrong chain the signature is
 * invalid and the seller rejects it, so switching is handled up front.
 */

export const ARC_TESTNET = {
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.testnet.arc.network'] } },
} as const;

export const USDC = '0x3600000000000000000000000000000000000000' as Address;

/** Circle's USDC uses a fixed EIP-712 domain, not EIP-5267 discovery. */
export const USDC_DOMAIN = {
  name: 'USDC',
  version: '2',
  chainId: ARC_TESTNET.id,
  verifyingContract: USDC,
} as const;

export const TRANSFER_WITH_AUTHORIZATION = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

export type ConnectedWallet = {
  address: Address;
  chainId: number;
  provider: EIP1193Provider;
  publicClient: PublicClient;
  walletClient: WalletClient;
};

/** EIP-6963 announced providers, so several wallets can be offered. */
export type DiscoveredProvider = { uuid: string; name: string; icon?: string; rdns?: string };

export function discoverWallets(): DiscoveredProvider[] {
  if (typeof window === 'undefined') return [];
  const announced = (window as unknown as { ethereum?: { providers?: EIP1193Provider[] } }).ethereum
    ?.providers;
  const legacy = (window as unknown as { ethereum?: EIP1193Provider }).ethereum;

  if (announced && announced.length > 1) {
    return announced.map((provider, index) => ({
      uuid: String(index),
      name: `Wallet ${index + 1}`,
    }));
  }
  if (legacy) return [{ uuid: 'injected', name: detectName(legacy) }];
  return [];
}

/** Wallet extensions hang their own flags off the provider. */
type FlaggedProvider = EIP1193Provider & {
  isMetaMask?: boolean;
  isRabby?: boolean;
  isCoinbaseWallet?: boolean;
};

function detectName(provider: EIP1193Provider): string {
  const flagged = provider as FlaggedProvider;
  if (flagged.isRabby) return 'Rabby';
  if (flagged.isCoinbaseWallet) return 'Coinbase Wallet';
  if (flagged.isMetaMask) return 'MetaMask';
  return 'Browser wallet';
}

export function injectedProvider(): EIP1193Provider | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
}

/**
 * Connect and report the chain, without requiring it to be Arc.
 *
 * Returning a wallet on the wrong chain rather than throwing lets the UI offer a
 * one-click switch instead of failing at the point of signing.
 */
export async function connect(
  provider: EIP1193Provider = injectedProvider() as EIP1193Provider,
): Promise<ConnectedWallet> {
  if (!provider) throw new Error('No browser wallet found. Install one, or use the hosted buyer.');

  const publicClient = createPublicClient({
    chain: ARC_TESTNET,
    transport: http(ARC_TESTNET.rpcUrls.default.http[0]),
  });

  const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as Address[];
  const address = accounts[0];
  if (!address) throw new Error('The wallet returned no accounts.');

  const chainIdHex = (await provider.request({ method: 'eth_chainId' })) as `0x${string}`;
  const chainId = Number.parseInt(chainIdHex, 16);

  const walletClient = createWalletClient({
    account: address,
    chain: ARC_TESTNET,
    transport: custom(provider),
  });

  return { address, chainId, provider, publicClient, walletClient };
}

/** Ask the wallet to switch to Arc testnet, adding the chain if unknown. */
export async function switchToArc(wallet: ConnectedWallet): Promise<void> {
  const chainIdHex = `0x${ARC_TESTNET.id.toString(16)}`;
  try {
    await wallet.provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: chainIdHex }],
    });
  } catch (error) {
    // 4902 means the chain is not known to the wallet yet.
    if ((error as { code?: number }).code !== 4902) throw error;
    await wallet.provider.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: chainIdHex,
          chainName: ARC_TESTNET.name,
          nativeCurrency: ARC_TESTNET.nativeCurrency,
          rpcUrls: [...ARC_TESTNET.rpcUrls.default.http],
        },
      ],
    });
  }
}

export async function getUsdcBalance(wallet: ConnectedWallet): Promise<bigint> {
  return wallet.publicClient.readContract({
    address: USDC,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [wallet.address],
  });
}

export async function getNativeBalance(wallet: ConnectedWallet): Promise<bigint> {
  return wallet.publicClient.getBalance({ address: wallet.address });
}

export async function getAllowance(
  wallet: ConnectedWallet,
  spender: Address,
): Promise<bigint> {
  return wallet.publicClient.readContract({
    address: USDC,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [wallet.address, spender],
  });
}

/**
 * Grant the seller permission to pull. EIP-3009 is a pull, so without this the
 * seller rejects the payment no matter how valid the signature is. Approve once,
 * not per request.
 */
export async function approveUsdc(
  wallet: ConnectedWallet,
  spender: Address,
  amount: bigint,
): Promise<`0x${string}`> {
  const hash = await wallet.walletClient.writeContract({
    address: USDC,
    abi: erc20Abi,
    functionName: 'approve',
    args: [spender, amount],
    chain: ARC_TESTNET,
    account: wallet.address,
  });
  await wallet.publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

export type SignedAuthorization = {
  signature: `0x${string}`;
  authorization: {
    from: Address;
    to: Address;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: `0x${string}`;
  };
};

/** Ask the wallet to sign the EIP-3009 authorization the seller will pull. */
export async function signAuthorization(
  wallet: ConnectedWallet,
  params: { to: Address; value: bigint; validForSeconds?: number },
): Promise<SignedAuthorization> {
  const now = BigInt(Math.floor(Date.now() / 1000));
  // A little slack at the front so a signature is not rejected as "not valid
  // yet" by the time the server checks it against block time.
  const validAfter = now - 60n;
  const validBefore = now + BigInt(params.validForSeconds ?? 300);

  const nonce = await createNonce(wallet);

  const message = {
    from: wallet.address,
    to: params.to,
    value: params.value,
    validAfter,
    validBefore,
    nonce,
  };

  const signature = (await wallet.walletClient.signTypedData({
    domain: USDC_DOMAIN,
    types: TRANSFER_WITH_AUTHORIZATION,
    primaryType: 'TransferWithAuthorization',
    message,
    account: wallet.address,
  })) as `0x${string}`;

  return {
    signature,
    authorization: {
      from: message.from,
      to: message.to,
      value: message.value.toString(),
      validAfter: message.validAfter.toString(),
      validBefore: message.validBefore.toString(),
      nonce: message.nonce,
    },
  };
}

/**
 * EIP-3009 nonce, hashed so it is always exactly 32 bytes.
 *
 * The previous version concatenated 16 bytes of entropy with hex fragments of
 * the block number and timestamp. That is 25 bytes, and the signer rejected it
 * with "Expected bytes32, got bytes25". Building the string by hand means the
 * length depends on the width of whatever is concatenated, so hash it instead:
 * keccak256 always returns 32 bytes whatever goes in.
 *
 * Uniqueness comes from the entropy plus the chain head, which also stops two
 * signatures in the same millisecond from colliding.
 */
async function createNonce(wallet: ConnectedWallet): Promise<`0x${string}`> {
  const block = await wallet.publicClient.getBlockNumber();
  const entropy = new Uint8Array(32);
  crypto.getRandomValues(entropy);
  const seed = new Uint8Array(entropy.length + 16);
  seed.set(entropy, 0);
  seed.set(new Uint8Array(new BigUint64Array([block, BigInt(Date.now())]).buffer), entropy.length);
  return keccak256(seed);
}

export function encodePaymentHeader(
  network: string,
  signed: SignedAuthorization,
): string {
  return btoa(
    JSON.stringify({
      x402Version: 1,
      scheme: 'exact',
      network,
      payload: { signature: signed.signature, authorization: signed.authorization },
    }),
  );
}

export function formatUsd(value: bigint): string {
  return formatUnits(value, 6);
}